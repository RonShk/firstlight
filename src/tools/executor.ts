// Central tool execution: argument validation, effect permissions, timeouts, retries, idempotent
// writes, output validation, and an audit event for every request, result and failure.
import { createHash } from "node:crypto";
import { json, parse } from "../db/sqlite";
import { now } from "../cases/db";
import { appendEvent } from "../cases/events";
import { parseArguments } from "./coerce";
import { ToolError, type ToolDefinition, type TrustedRunContext } from "./types";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolOutcome {
  ok: boolean;
  /** JSON returned to the model. */
  content: string;
  output?: unknown;
  ms: number;
}

export interface ExecutorPolicy {
  allowWrites: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function executeTool(
  registry: Map<string, ToolDefinition>, call: ToolCall, ctx: TrustedRunContext, policy: ExecutorPolicy,
): Promise<ToolOutcome> {
  const started = Date.now();
  const base = { caseId: ctx.caseId, runId: ctx.runId, toolCallId: call.id };
  const fail = (code: string, message: string, detail: object = {}): ToolOutcome => {
    appendEvent(ctx.db, { ...base, actor: "tool", type: code === "invalid_input" || code === "forbidden" ? "tool.rejected" : "tool.failed",
      title: `${call.name}: ${message}`.slice(0, 160), detail: { tool: call.name, code, message, ...detail }, ms: Date.now() - started });
    return { ok: false, content: json({ error: code, message, ...detail }), ms: Date.now() - started };
  };

  const tool = registry.get(call.name);
  if (!tool) return fail("not_found", `Unknown tool ${call.name}`, { available: [...registry.keys()] });

  let args: unknown;
  try {
    args = parseArguments(call.arguments);
  } catch {
    return fail("invalid_input", "Arguments are not valid JSON");
  }
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    return fail("invalid_input", "Arguments do not match the tool schema",
      { issues: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) });
  }
  const input = parsed.data as { purpose: string } & Record<string, unknown>;
  if (tool.effect === "write" && !policy.allowWrites) return fail("forbidden", "Write actions are not permitted in this run");

  appendEvent(ctx.db, { ...base, actor: "agent", type: "tool.requested", title: tool.title(input),
    detail: { tool: tool.name, effect: tool.effect, purpose: input.purpose, input } });

  let key: string | null = null;
  if (tool.effect === "write") {
    if (!tool.idempotencyKey) return fail("failed", "Write tool has no idempotency key");
    key = createHash("sha256").update(json([tool.name, ctx.caseId, tool.idempotencyKey(input, ctx)])).digest("hex");
    const prior = ctx.db.get<{ output: string }>("SELECT output FROM tool_effects WHERE idempotency_key=?", key);
    if (prior) {
      appendEvent(ctx.db, { ...base, actor: "tool", type: "tool.completed", title: `${tool.name}: already done (idempotent replay)`,
        detail: { tool: tool.name, replayed: true }, artifact: { kind: "tool_output", body: parse(prior.output) }, ms: Date.now() - started });
      return { ok: true, content: prior.output, output: parse(prior.output), ms: Date.now() - started };
    }
  }

  const attempts = tool.effect === "read" ? 1 + (tool.retries ?? 1) : 1;
  let lastError: ToolError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(250 * 2 ** attempt);
    const timeout = AbortSignal.timeout(tool.timeoutMs);
    const signal = AbortSignal.any([ctx.signal, timeout]);
    try {
      const raw = await abortable(tool.execute(input, { ...ctx, signal }), signal);
      const output = tool.outputSchema.parse(raw);
      const content = json(output);
      if (key) ctx.db.run("INSERT OR IGNORE INTO tool_effects VALUES (?,?,?,?,?,?)", key, ctx.caseId, ctx.runId, tool.name, content, now());
      appendEvent(ctx.db, { ...base, actor: "tool", type: "tool.completed", title: `${tool.name} completed`,
        detail: { tool: tool.name, attempt: attempt + 1 }, artifact: { kind: "tool_output", body: output }, ms: Date.now() - started });
      return { ok: true, content, output, ms: Date.now() - started };
    } catch (e) {
      if (ctx.signal.aborted) throw ctx.signal.reason ?? e;
      lastError = e instanceof ToolError ? e
        : timeout.aborted ? new ToolError("timeout", `Timed out after ${tool.timeoutMs} ms`)
        : new ToolError("failed", (e as Error).message);
      if (!["unavailable", "timeout"].includes(lastError.code)) break;
    }
  }
  return fail(lastError!.code, lastError!.message);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
