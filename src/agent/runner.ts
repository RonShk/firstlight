// The agent runtime: model -> tool calls -> observations -> repeat, until the model submits a decision
// that passes validation and the verifier agent. No insurance logic lives here: the runner manages the
// conversation, bounds (turns, tool calls, tokens, wall time), checkpoints and audit events.
import { z } from "zod";
import type { Config } from "../config";
import type { Sqlite } from "../db/sqlite";
import { findPolicyholder, type PolicyholderFile } from "../customers/directory";
import { appendEvent } from "../cases/events";
import { getCase, messages as caseMessages } from "../cases/repository";
import { saveCheckpoint, type RunRecord, type RunUsage } from "../cases/runs";
import type { Embedder } from "../knowledge/embeddings";
import type { Reranker } from "../knowledge/rerank";
import type { KnowledgeStore } from "../knowledge/store";
import { parseArguments } from "../tools/coerce";
import { executeTool, type ToolCall } from "../tools/executor";
import { functionSpec, toolRegistry, toolSpecs, TOOLS } from "../tools/registry";
import type { Evidence, ToolDefinition, TrustedRunContext } from "../tools/types";
import { caseBrief } from "./context";
import { FOLLOW_UP, sanitize, validateDecision, type Validation } from "./finalize";
import type { Guard, Screen } from "./guard";
import { AGENT_INSTRUCTIONS } from "./instructions";
import type { AgentModel, Message } from "./model";
import { Decision, FinishInput, type Finding } from "./schemas";
import { verifyDecision } from "./verifier";

export interface AgentDeps {
  db: Sqlite;
  model: AgentModel;
  /** The reviewing agent; null skips verification (recorded). */
  verifier: AgentModel | null;
  guard: Guard | null;
  knowledge: KnowledgeStore | null;
  embedder: Embedder | null;
  reranker: Reranker | null;
  limits: Config["limits"];
  tools?: ToolDefinition[];
  /** Resolve the case's customer. Defaults to the policyholder directory. */
  customerOf?: (customerId: string | null) => PolicyholderFile | null;
}

export interface RunResult {
  decision: Decision;
  citations: Validation["citations"];
  /** Why the reply must wait for a person; null to send. */
  hold: string | null;
  verified: boolean;
  usage: RunUsage;
}

interface Checkpoint {
  messages: Message[];
  evidence: [string, Evidence][];
  findings?: [string, Finding][];
  usage: RunUsage;
  screen: Screen | null;
  screened: boolean;
  nudges: number;
  truncations?: number;
  budgetNoted: boolean;
  /** Next turn offers only finish_review (after a malformed decision). */
  forceFinish?: boolean;
  /** How often each (tool, arguments) pair was requested: repeated identical calls signal a loop. */
  callCounts?: Record<string, number>;
  loopDetected?: boolean;
}

export class AgentGaveUpError extends Error {
  constructor(message: string, readonly usage: RunUsage) {
    super(message);
    this.name = "AgentGaveUpError";
  }
}

const FINISH = functionSpec("finish_review",
  "Submit your decision: severity, danger, summary, next action and the customer reply. Coverage findings are the ones you recorded with record_finding. Returns accepted, or issues to fix.",
  FinishInput);

export async function executeRun(run: RunRecord, owner: string, deps: AgentDeps, signal: AbortSignal): Promise<RunResult> {
  const { db, limits } = deps;
  const record = getCase(db, run.caseId);
  if (!record) throw new Error(`Case ${run.caseId} not found`);
  const customer = (deps.customerOf ?? ((id) => (id ? findPolicyholder({ personaId: id }) : null)))(record.customerId);
  const tools = deps.tools ?? TOOLS;
  const registry = toolRegistry(tools);
  const specs = [...toolSpecs(tools), FINISH];
  const event = (e: Omit<Parameters<typeof appendEvent>[1], "caseId" | "runId">) => appendEvent(db, { caseId: run.caseId, runId: run.id, ...e });
  const transcript = caseMessages(db, run.caseId);
  const customerText = transcript.filter((m) => m.role === "customer" && m.seq <= run.throughSeq).map((m) => m.text).join("\n");

  const saved = run.checkpoint as Checkpoint | null;
  const cp: Checkpoint = saved ?? {
    messages: [], evidence: [], usage: { turns: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, revisions: 0 },
    screen: null, screened: false, nudges: 0, budgetNoted: false,
  };
  const ctx: TrustedRunContext = { caseId: run.caseId, runId: run.id, db, customer, knowledge: deps.knowledge,
    embedder: deps.embedder, reranker: deps.reranker, evidence: new Map(cp.evidence), findings: new Map(cp.findings ?? []), signal };
  const checkpoint = () => { cp.evidence = [...ctx.evidence]; cp.findings = [...ctx.findings]; saveCheckpoint(db, run.id, owner, cp, cp.usage); };

  if (!cp.screened) {
    cp.screen = await screen(deps.guard, customerText, undefined, signal, (s, error) => event({ actor: "guard", type: "guard.input",
      title: error ? "Input safety screen unavailable" : s!.safe ? "Input passed the safety screen" : `Input flagged: ${s!.categories.join(", ")}`,
      detail: error ? { error } : s }));
    cp.screened = true;
  }
  if (!cp.messages.length) {
    cp.messages = [{ role: "system", content: AGENT_INSTRUCTIONS }, { role: "user", content: caseBrief(db, record, run, customer, cp.screen) }];
    event({ actor: "system", type: "context.built", title: "Case context assembled for Nemotron",
      detail: { customer_verified: !!customer, transcript_messages: transcript.length, tools: tools.map((t) => t.name) } });
    checkpoint();
  }

  // Budgets detect loops (too many steps, repeated identical calls, runaway tokens), not slowness: a busy
  // GPU makes every step slow without making the investigation any less valid. The wall-clock limit is
  // only a safety net, measured per attempt so time spent re-queued after an outage does not count.
  const deadline = Date.now() + limits.runTimeoutMs;
  for (;;) {
    signal.throwIfAborted();
    const u = cp.usage;
    if (u.turns >= limits.maxTurns + 3) throw new AgentGaveUpError("Turn budget exhausted without an acceptable decision", u);
    if (Date.now() > deadline) throw new AgentGaveUpError(`Run exceeded the ${Math.round(limits.runTimeoutMs / 60_000)} minute safety limit`, u);
    const reason = u.turns >= limits.maxTurns ? `${u.turns} steps` : u.toolCalls >= limits.maxToolCalls ? `${u.toolCalls} tool calls`
      : u.promptTokens + u.completionTokens >= limits.maxTokens ? `${u.promptTokens + u.completionTokens} tokens`
      : cp.loopDetected ? "the same tool call repeated" : null;
    const exhausted = reason !== null;
    if (exhausted && !cp.budgetNoted) {
      cp.budgetNoted = true;
      cp.messages.push({ role: "user", content: "Investigation budget reached. Call finish_review now with what you have; findings you could not verify must be marked unclear." });
      event({ actor: "system", type: "budget.reached", title: `Investigation limit reached (${reason}); agent asked to conclude`, detail: { ...u, reason } });
    }

    const compacted = compact(cp.messages);
    if (compacted) event({ actor: "system", type: "context.compacted", title: `Older tool outputs elided to keep context small (${compacted} messages)`, detail: { elided: compacted } });
    // When concluding (budget reached, or fixing a malformed decision) only finish_review is offered.
    // It is never pinned with a named tool_choice: that switches vLLM to schema-guided decoding, which
    // measured ~3x slower on this model and produced truncated, unusable arguments.
    const onlyFinish = exhausted || !!cp.forceFinish;
    cp.forceFinish = false;
    const turn = await deps.model.turn(cp.messages, onlyFinish ? [FINISH] : specs, "auto", signal);
    u.turns++;
    u.promptTokens += turn.usage.promptTokens;
    u.completionTokens += turn.usage.completionTokens;
    if (turn.finishReason === "length") {
      // Never execute partial calls or repeat the same investigation after a cutoff.
      // A resumed checkpoint from older code may already contain cutoff nudges.
      cp.truncations = (cp.truncations ?? cp.messages.filter((m) => m.role === "user" && typeof m.content === "string" && m.content.startsWith("Your last response was cut off")).length) + 1;
      const giveUp = cp.truncations >= 2;
      event({ actor: "system", type: "model.truncated",
        title: giveUp ? "Final response exceeded output limit; routing to human review" : "Response exceeded output limit; requesting one concise final decision",
        detail: { completion_tokens: turn.usage.completionTokens, content_chars: turn.content?.length ?? 0,
          tool_calls: turn.toolCalls.length, argument_chars: turn.toolCalls.reduce((n, t) => n + t.arguments.length, 0), attempt: cp.truncations } });
      cp.forceFinish = true;
      cp.messages.push({ role: "user", content: "Your last response was cut off. Call finish_review now with a short summary and reply. Omit inline findings (recorded findings are merged automatically). Keep arrays short. Mark unverified coverage unclear and use human_review when needed. Do not repeat policy text or continue investigating." });
      checkpoint();
      if (giveUp) throw new AgentGaveUpError("Model output exceeded the token limit on the final recovery attempt", u);
      continue;
    }
    cp.messages.push({ role: "assistant", content: turn.content ?? "",
      ...(turn.toolCalls.length ? { tool_calls: turn.toolCalls.map((t) => ({ id: t.id, type: "function" as const, function: { name: t.name, arguments: t.arguments } })) } : {}) });
    if (turn.content) event({ actor: "agent", type: "agent.note", title: "Agent explanation", detail: { text: turn.content.slice(0, 2_000) } });

    if (!turn.toolCalls.length) {
      if (++cp.nudges > 2) throw new AgentGaveUpError("Model stopped calling tools", u);
      cp.messages.push({ role: "user", content: "Continue the investigation with tool calls, then call finish_review. Do not answer in plain text." });
      checkpoint();
      continue;
    }

    const finishes = turn.toolCalls.filter((t) => t.name === "finish_review");
    const actions = turn.toolCalls.filter((t) => t.name !== "finish_review");
    const results = await runActions(registry, actions, ctx);
    u.toolCalls += actions.length;
    cp.callCounts ??= {};
    for (const a of actions) {
      const key = `${a.name}:${canonicalArgs(a.arguments)}`;
      cp.callCounts[key] = (cp.callCounts[key] ?? 0) + 1;
      if (cp.callCounts[key] >= 3 && !cp.loopDetected) {
        cp.loopDetected = true;
        event({ actor: "system", type: "loop.detected", title: `Loop detected: ${a.name} called 3 times with the same arguments`, detail: { tool: a.name } });
      }
    }
    actions.forEach((call, i) => cp.messages.push({ role: "tool", tool_call_id: call.id, content: results[i] }));

    let accepted: RunResult | null = null;
    // Models occasionally emit a complete finish_review plus a fragment in one turn: review the best one.
    const chosen = pickFinish(finishes);
    for (const call of finishes) {
      if (call !== chosen) { cp.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ignored: "Duplicate finish_review in the same turn; another call was reviewed." }) }); continue; }
      const review = await reviewFinish(call, { deps, ctx, customer, transcript, cp, event, signal, registry });
      cp.messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(review.feedback) });
      accepted = review.result;
    }
    checkpoint();
    if (accepted) return finishRun(accepted, { deps, ctx, customerText, event, signal });
  }
}

const CONTEXT_BUDGET_CHARS = 90_000;
const KEEP_RECENT_TOOL_OUTPUTS = 4;

/**
 * Keep the prompt bounded: once the conversation is large, replace older tool outputs with a stub that
 * lists the passages they contained. Evidence stays in the run (citations still verify), and the model
 * can re-read any passage with read_section. Returns how many messages were elided.
 */
function compact(messages: Message[]): number {
  const size = () => messages.reduce((n, m) => n + (typeof m.content === "string" ? m.content.length : 0), 0);
  if (size() <= CONTEXT_BUDGET_CHARS) return 0;
  const tools = messages.map((m, i) => [m, i] as const).filter(([m]) => m.role === "tool" && typeof m.content === "string" && !m.content.startsWith('{"elided"'));
  let elided = 0;
  for (const [m, i] of tools.slice(0, -KEEP_RECENT_TOOL_OUTPUTS)) {
    const ids = [...new Set(String(m.content).match(/[A-Z]{2,}(?:-[A-Z]+)+#\d+/g) ?? [])];
    messages[i] = { ...m, content: JSON.stringify({ elided: "Earlier tool output removed to save context. Use read_section to re-read a passage.", passages: ids.slice(0, 20) }) } as Message;
    elided++;
    if (size() <= CONTEXT_BUDGET_CHARS) break;
  }
  return elided;
}

/** Arguments without the free-text purpose, key-sorted, so rephrased purposes still count as repeats. */
function canonicalArgs(raw: string): string {
  try {
    const { purpose: _purpose, ...rest } = (parseArguments(raw) ?? {}) as Record<string, unknown>;
    void _purpose;
    return JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]]));
  } catch {
    return raw;
  }
}

function pickFinish(calls: ToolCall[]): ToolCall | undefined {
  const parse = (c: ToolCall) => { try { return parseArguments(c.arguments); } catch { return null; } };
  return calls.find((c) => FinishInput.safeParse(parse(c)).success) ?? [...calls].sort((a, b) => b.arguments.length - a.arguments.length)[0];
}

function mergeFindings(recorded: Map<string, Finding>, inline: Finding[] | undefined): Finding[] {
  const key = (item: string) => item.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const out = [...recorded.values()];
  for (const f of inline ?? []) if (!recorded.has(key(f.item))) out.push(f);
  return out.slice(0, 10);
}

async function runActions(registry: Map<string, ToolDefinition>, calls: ToolCall[], ctx: TrustedRunContext): Promise<string[]> {
  const out = new Array<string>(calls.length);
  // Reads run concurrently; writes run one at a time, in the order the model asked for them.
  const reads = calls.map((c, i) => [c, i] as const).filter(([c]) => registry.get(c.name)?.effect !== "write");
  await Promise.all(reads.map(async ([c, i]) => { out[i] = (await executeTool(registry, c, ctx, { allowWrites: true })).content; }));
  for (const [i, c] of calls.entries()) if (out[i] === undefined) out[i] = (await executeTool(registry, c, ctx, { allowWrites: true })).content;
  return out;
}

interface ReviewEnv {
  deps: AgentDeps;
  ctx: TrustedRunContext;
  customer: PolicyholderFile | null;
  transcript: ReturnType<typeof caseMessages>;
  cp: Checkpoint;
  event: (e: Omit<Parameters<typeof appendEvent>[1], "caseId" | "runId">) => unknown;
  signal: AbortSignal;
  registry: Map<string, ToolDefinition>;
}

async function reviewFinish(call: ToolCall, env: ReviewEnv): Promise<{ feedback: object; result: RunResult | null }> {
  const { deps, ctx, customer, cp, event } = env;
  const u = cp.usage;
  const canRevise = u.revisions < deps.limits.maxRevisions;
  let raw: unknown = null;
  try { raw = parseArguments(call.arguments); } catch { /* reported below */ }
  const parsedInput = FinishInput.safeParse(raw);
  // Recorded findings first; findings sent inline with finish_review are kept only for items not recorded.
  const parsed = parsedInput.success ? Decision.safeParse({ ...parsedInput.data, findings: mergeFindings(ctx.findings, parsedInput.data.findings) }) : parsedInput;

  if (!parsed.success) {
    const issues = shapeIssues(raw, parsed.error);
    event({ actor: "system", type: "decision.rejected", title: "Decision did not match the required shape", toolCallId: call.id,
      detail: { issues, received_keys: raw && typeof raw === "object" ? Object.keys(raw) : typeof raw, arguments_preview: call.arguments.slice(0, 600) } });
    if (canRevise) {
      u.revisions++;
      cp.forceFinish = true;
      return { feedback: { accepted: false, issues, note: "Call finish_review again with every field as real JSON (arrays as arrays, not strings)." }, result: null };
    }
    throw new AgentGaveUpError(`Decision never matched the schema: ${z.prettifyError(parsed.error).slice(0, 300)}`, u);
  }

  let decision = parsed.data as Decision;
  const completedTools = new Set(env.deps.db.all<{ tool: string }>(
    "SELECT DISTINCT json_extract(detail, '$.tool') AS tool FROM events WHERE run_id=? AND type='tool.completed'", ctx.runId).map((r) => r.tool));
  // A reply that says someone will follow up is made true rather than rejected: queue the review.
  if (FOLLOW_UP.test(decision.reply) && decision.next_action !== "human_review" && !completedTools.has("request_human_review") && !completedTools.has("prepare_claim")) {
    const out = await executeTool(env.registry, { id: `followup_${call.id}`, name: "request_human_review", arguments: JSON.stringify({
      purpose: "System: the reply tells the customer someone will follow up, so a follow-up is queued to keep that promise.",
      priority: decision.severity >= 70 ? "high" : "normal", reason: `Follow-up promised to the customer: ${decision.summary}`.slice(0, 400) }) }, ctx, { allowWrites: true });
    if (out.ok) completedTools.add("request_human_review");
  }
  const validation = validateDecision(decision, ctx.evidence, customer, { completedTools });
  event({ actor: "agent", type: "decision.proposed", title: `Decision proposed: ${decision.next_action.replace("_", " ")}, severity ${decision.severity}`,
    detail: { decision }, toolCallId: call.id });
  if (validation.issues.length) {
    event({ actor: "system", type: "decision.rejected", title: `Grounding checks found ${validation.issues.length} issue(s)`, detail: { issues: validation.issues }, toolCallId: call.id });
    if (canRevise) { u.revisions++; return { feedback: { accepted: false, issues: validation.issues }, result: null }; }
    decision = sanitize(decision, ctx.evidence, customer, "grounding checks still failing after revisions");
    event({ actor: "system", type: "decision.sanitized", title: "Unverified findings downgraded; routed to a human", detail: { decision } });
    return accept(decision, false, env);
  }

  if (!deps.verifier) {
    event({ actor: "verifier", type: "verifier.skipped", title: "Verifier agent not configured", detail: {} });
    return accept(decision, false, env);
  }
  const started = Date.now();
  try {
    const { verdict, usage } = await verifyDecision(deps.verifier, { decision, transcript: env.transcript, customer, evidence: ctx.evidence, signal: env.signal });
    u.promptTokens += usage.promptTokens;
    u.completionTokens += usage.completionTokens;
    event({ actor: "verifier", type: "verifier.reviewed", ms: Date.now() - started,
      title: verdict.verdict === "approve" ? "Verifier agent approved the decision" : `Verifier agent requested ${verdict.issues.length} revision(s)`, detail: verdict });
    if (verdict.verdict === "revise" && verdict.issues.length) {
      if (canRevise) { u.revisions++; return { feedback: { accepted: false, reviewer_issues: verdict.issues, severity_check: verdict.severity_check }, result: null }; }
      decision = sanitize(decision, ctx.evidence, customer, `Verifier concerns unresolved: ${verdict.issues.join(" | ")}`);
      event({ actor: "system", type: "decision.sanitized", title: "Unresolved verifier concerns routed to a human with a safe reply", detail: { decision } });
      return accept(decision, false, env);
    }
    return accept(decision, true, env);
  } catch (e) {
    if (env.signal.aborted) throw e;
    event({ actor: "verifier", type: "verifier.unavailable", title: "Verifier agent unavailable; decision recorded as unverified", detail: { error: (e as Error).message } });
    return accept(decision, false, env);
  }
}

/** Schema errors phrased so the model can fix them; a field sent as broken JSON text is called out explicitly. */
function shapeIssues(raw: unknown, error: z.ZodError): string[] {
  const issues: string[] = [];
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string" && /^\s*[[{]/.test(value)) {
        try { JSON.parse(value); } catch (e) {
          issues.push(`${key} must be a JSON array/object, not a string; the text you sent is not valid JSON (${(e as Error).message}). Send ${key} as a real array.`);
        }
      }
    }
  }
  for (const i of error.issues.slice(0, 8)) {
    const key = String(i.path[0] ?? "");
    if (issues.some((x) => x.startsWith(`${key} must be`))) continue;
    issues.push(`${i.path.join(".") || "(root)"}: ${i.message}`);
  }
  return issues;
}

function accept(decision: Decision, verified: boolean, env: ReviewEnv): { feedback: object; result: RunResult } {
  const { citations } = validateDecision(decision, env.ctx.evidence, env.customer);
  env.event({ actor: "system", type: "decision.accepted", title: verified ? "Decision accepted (grounded and verified)" : "Decision accepted",
    detail: { decision, citations, verified } });
  return { feedback: { accepted: true }, result: { decision, citations, hold: null, verified, usage: env.cp.usage } };
}

async function finishRun(result: RunResult, env: { deps: AgentDeps; ctx: TrustedRunContext; customerText: string; event: ReviewEnv["event"]; signal: AbortSignal }): Promise<RunResult> {
  const out = await screen(env.deps.guard, env.customerText, result.decision.reply, env.signal, (s, error) => env.event({ actor: "guard", type: "guard.output",
    title: error ? "Reply safety screen unavailable" : s!.safe ? "Reply passed the safety screen" : `Reply flagged: ${s!.categories.join(", ")}`,
    detail: error ? { error } : s }));
  if (out && !out.safe) result = { ...result, hold: `Safety screen flagged the reply (${out.categories.join(", ") || "unspecified"})` };
  return result;
}

async function screen(guard: Guard | null, text: string, reply: string | undefined, signal: AbortSignal,
  record: (s: Screen | null, error?: string) => void): Promise<Screen | null> {
  if (!guard || !text) return null;
  try {
    const s = await guard.screen(text, reply, signal);
    record(s);
    return s;
  } catch (e) {
    if (signal.aborted) throw e;
    record(null, (e as Error).message);
    return null;
  }
}
