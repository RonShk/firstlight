// Nemotron adapter: one chat turn with native tool calling against the OpenAI-compatible endpoint
// (vLLM on Brev), streamed. A busy GPU is slow but alive, so the only timeout is for a STALL: no
// tokens (including hidden reasoning tokens) for `stallMs`. Runaway generation is bounded by the
// per-step token cap instead. The model's private reasoning text is dropped: the audit trail
// records tool calls, stated purposes and outcomes, not a transcript of hidden thinking.
import OpenAI from "openai";
import { config, NVIDIA_API, type Config } from "../config";

export type Message = OpenAI.Chat.ChatCompletionMessageParam;
export type ToolSpec = OpenAI.Chat.ChatCompletionTool;
export type ToolChoice = "auto" | "required" | { type: "function"; function: { name: string } };

export interface AssistantTurn {
  content: string | null;
  toolCalls: { id: string; name: string; arguments: string }[];
  usage: { promptTokens: number; completionTokens: number };
  finishReason: string | null;
}

export interface AgentModel {
  name: string;
  turn(messages: Message[], tools: ToolSpec[], toolChoice: ToolChoice, signal: AbortSignal): Promise<AssistantTurn>;
}

export class ModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelError";
  }
}

/** Infrastructure trouble (connection drop, stall, overload, 5xx): retry the run later, do not fail it. */
export class TransientModelError extends ModelError {
  constructor(message: string) {
    super(message);
    this.name = "TransientModelError";
  }
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal.addEventListener("abort", () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

function isTransient(e: unknown): boolean {
  if (e instanceof TransientModelError) return true;
  if (e instanceof OpenAI.APIConnectionError) return true; // includes connection timeouts
  if (e instanceof OpenAI.APIError) return e.status === undefined || e.status === 408 || e.status === 409 || e.status === 429 || e.status >= 500;
  return /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|fetch failed|terminated/i.test((e as Error)?.message ?? "");
}

export function nemotron(c: Config = config(), options: { maxTokens?: number; stallMs?: number } = {}): AgentModel {
  // Hidden reasoning counts toward max_tokens; the cap bounds a runaway step, the runner recovers from it.
  const maxTokens = options.maxTokens ?? Number(process.env.AGENT_MAX_OUTPUT_TOKENS || 8_192);
  const stallMs = options.stallMs ?? Number(process.env.NEMOTRON_STALL_MS || 60_000);
  // No overall request timeout: liveness is judged by token flow (see stall handling below).
  const client = new OpenAI({ apiKey: c.chat.apiKey || "unset", baseURL: c.chat.baseUrl, timeout: 30 * 60_000, maxRetries: 0 });

  async function once(messages: Message[], tools: ToolSpec[], toolChoice: ToolChoice, signal: AbortSignal): Promise<AssistantTurn> {
    const stall = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const alive = () => { clearTimeout(timer); timer = setTimeout(() => stall.abort(), stallMs); };
    alive(); // also bounds the wait for the first token (prefill, or vLLM queueing)
    const combined = AbortSignal.any([signal, stall.signal]);
    let content = "";
    let finishReason: string | null = null;
    let usage = { promptTokens: 0, completionTokens: 0 };
    const calls = new Map<number, { id: string; name: string; arguments: string }>();
    try {
      const stream = await client.chat.completions.create({
        model: c.chat.model, messages: validToolHistory(messages), tools, tool_choice: toolChoice, parallel_tool_calls: true,
        // vLLM accepts chat-template options; the hosted NVIDIA API has its own template.
        ...(c.chat.baseUrl.replace(/\/$/, "") !== NVIDIA_API ? {
          chat_template_kwargs: { enable_thinking: process.env.NEMOTRON_ENABLE_THINKING === "true" },
        } : {}),
        temperature: 0.2, top_p: 0.95, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
      }, { signal: combined });
      for await (const chunk of stream) {
        alive();
        if (chunk.usage) usage = { promptTokens: chunk.usage.prompt_tokens ?? 0, completionTokens: chunk.usage.completion_tokens ?? 0 };
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        if (choice.delta?.content) content += choice.delta.content;
        for (const t of choice.delta?.tool_calls ?? []) {
          const call = calls.get(t.index) ?? { id: "", name: "", arguments: "" };
          if (t.id) call.id = t.id;
          if (t.function?.name) call.name += t.function.name;
          if (t.function?.arguments) call.arguments += t.function.arguments;
          calls.set(t.index, call);
        }
      }
    } catch (e) {
      if (signal.aborted) throw e;
      if (stall.signal.aborted) throw new TransientModelError(`Nemotron produced no tokens for ${Math.round(stallMs / 1000)}s`);
      const message = `${(e as Error).name}: ${(e as Error).message}`;
      throw isTransient(e) ? new TransientModelError(message) : new ModelError(message);
    } finally {
      clearTimeout(timer);
    }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([i, t]) => ({ ...t, id: t.id || `call_${Date.now()}_${i}` })).filter((t) => t.name);
    return { content: stripThinking(content), toolCalls, usage, finishReason };
  }

  return {
    name: c.chat.model,
    async turn(messages, tools, toolChoice, signal) {
      if (!c.chat.apiKey || !c.chat.model) throw new ModelError("NEMOTRON_API_KEY or NEMOTRON_MODEL is not set");
      // Brief blips are retried in place; longer outages surface as TransientModelError and the worker
      // re-queues the run (it resumes from its checkpoint later).
      for (let attempt = 0; ; attempt++) {
        try {
          return await once(messages, tools, toolChoice, signal);
        } catch (e) {
          if (!(e instanceof TransientModelError) || attempt >= 2 || /no tokens/.test(e.message)) throw e;
          await sleep(2_000 * 2 ** attempt, signal);
        }
      }
    },
  };
}

function stripThinking(content: string | null | undefined): string | null {
  const text = (content ?? "").replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").trim();
  return text || null;
}

/** vLLM parses historical arguments before generation. Keep rejected calls paired with their
 * feedback, but replace invalid JSON so one malformed response cannot poison the whole run.
 * Only request history is copied; original arguments remain in the audit events.
 */
export function validToolHistory(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== "assistant" || !message.tool_calls) return message;
    return { ...message, tool_calls: message.tool_calls.map((call) => {
      if (call.type !== "function") return call;
      try { JSON.parse(call.function.arguments); return call; }
      catch { return { ...call, function: { ...call.function, arguments: "{}" } }; }
    }) };
  });
}
