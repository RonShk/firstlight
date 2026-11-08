// Nemotron client: chat via the OpenAI-compatible API (our Brev vLLM server) and NVIDIA hosted
// embeddings. Every call has a timeout and one retry; failures surface as
// ModelUnavailableError so callers can route the case to a human instead of crashing.

import OpenAI from "openai";
import { agentConfig, type AgentConfig } from "./config";

export class ModelUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelUnavailableError";
  }
}

export interface ChatOptions {
  /** false turns off the model's reasoning pass: much faster. Default true. */
  reasoning?: boolean;
  timeoutMs?: number;
}

export interface ModelClient {
  /** One chat turn; returns the assistant's final text (never the reasoning). */
  chat(system: string, user: string, options?: ChatOptions): Promise<string>;
  /** Embeddings for retrieval; kind selects the NVIDIA query/passage encoder. */
  embed(texts: string[], kind: "query" | "passage"): Promise<number[][]>;
}

const EMBED_TIMEOUT_MS = 30_000;

async function postJson(url: string, apiKey: string, body: unknown): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json",
                   Accept: "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
        if (attempt < 1 && (res.status === 429 || res.status >= 500)) continue;
        throw new ModelUnavailableError(detail);
      }
      return await res.json();
    } catch (e) {
      if (e instanceof ModelUnavailableError) throw e;
      if (attempt < 1) continue;
      throw new ModelUnavailableError(`${(e as Error).name}: ${(e as Error).message}`);
    }
  }
}

export function createNemotronClient(config: AgentConfig = agentConfig()): ModelClient {
  const openai = new OpenAI({ apiKey: config.apiKey || "unset", baseURL: config.baseUrl,
                              timeout: config.timeoutMs, maxRetries: 1 });
  const requireEmbedKey = () => {
    if (!config.embedApiKey) throw new ModelUnavailableError("NEMOTRON_EMBED_API_KEY is not set");
  };

  return {
    async chat(system, user, { reasoning = true, timeoutMs } = {}) {
      if (!config.apiKey) throw new ModelUnavailableError("NEMOTRON_API_KEY is not set");
      if (!config.model) throw new ModelUnavailableError("NEMOTRON_MODEL is not set");
      let res;
      try {
        res = await openai.chat.completions.create(
          {
            model: config.model,
            temperature: 0,
            // Reasoning tokens count toward max_tokens, so leave room for them. Without reasoning the
            // largest reply (an extraction with 12 items) is well under 4000 tokens.
            max_tokens: reasoning ? 8000 : 4000,
            messages: [{ role: "system", content: system }, { role: "user", content: user }],
            // vLLM chat-template switch; only sent when turning reasoning off.
            ...(reasoning ? {} : { chat_template_kwargs: { enable_thinking: false } }),
          } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
          timeoutMs ? { timeout: timeoutMs } : undefined,
        );
      } catch (e) {
        throw new ModelUnavailableError(`${(e as Error).name}: ${(e as Error).message}`);
      }
      const choice = res.choices[0];
      if (choice?.finish_reason === "length") {
        throw new ModelUnavailableError("model reply was cut off at max_tokens");
      }
      return choice?.message?.content ?? "";
    },

    async embed(texts, kind) {
      requireEmbedKey();
      const out = (await postJson(`${config.embedBaseUrl}/embeddings`, config.embedApiKey, {
        model: config.embedModel,
        input: texts,
        input_type: kind,
        encoding_format: "float",
        truncate: "END",
      })) as { data?: { index: number; embedding: number[] }[] };
      if (!Array.isArray(out.data) || out.data.length !== texts.length) {
        throw new ModelUnavailableError("embedding response did not contain one vector per input");
      }
      return out.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}

/** Pull the JSON object out of a model reply (drops <think> blocks, even unclosed ones, and code fences). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?(<\/think>|$)/gi, "").replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new SyntaxError("no JSON object in model reply");
  return JSON.parse(cleaned.slice(start, end + 1));
}
