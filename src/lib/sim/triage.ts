import type { Persona, ThreadMessage, TriageStatus, WorldTruth } from "../../types/sim";
import type { PipelineResult } from "../agent/pipeline";
import type { ClaimRoute } from "../../types/sim";

// All timings are sim minutes after the tornado reaches that person's home.
/** First check-in goes out. */
export const OUTREACH_AT = 1;
/** No reply by now → follow-up text and the person turns "silent". */
export const SILENT_AFTER = 30;
/** Still silent by now → escalated to the local agent for a call / welfare check. */
export const ESCALATE_AFTER = 60;

export interface Turn {
  from: "policyholder" | "state_farm";
  text: string;
}

// ── Reading a /api/agent/analyze result ──────────────────────────────

const TRIAGE_SEVERITY = { 1: 20, 2: 50, 3: 80, 4: 95 } as const;

/** 0-100 severity for the dashboard, from the pipeline's triage 1-4. Null when the model didn't assess it. */
export function severityOf(r: PipelineResult): number | null {
  const a = r.result;
  if (a.status === "complete" || a.status === "emergency") return TRIAGE_SEVERITY[a.triage];
  if (a.status === "not_a_claim") return 5;
  return null;
}

/** The route the pipeline chose: anything flagged goes to a human; a claim with every item approved is paid now. */
export function routeOf(r: PipelineResult): ClaimRoute {
  const a = r.result;
  if (a.status === "not_a_claim") return "none";
  if (a.status === "complete" && !a.flagged_for_human) return "auto_approve";
  return "human_review";
}

/** One line on why: the danger reason, the claim summary, or the error. */
export function reasonOf(r: PipelineResult): string {
  const a = r.result;
  if (a.status === "emergency") return a.reason;
  if (a.status === "complete") return a.summary;
  if (a.status === "not_a_claim") return "Not a loss report";
  return `Agent unavailable: ${a.error}`;
}

/** The last text sent back to the customer (the update, 911 line, or help reply; not the "Received" ack). */
export function replyOf(r: PipelineResult): string {
  return r.messages.filter((m) => m.kind !== "ack").at(-1)?.body ?? r.messages.at(-1)?.body ?? "";
}

/** One call to the Nemotron agent for one version of a conversation. */
export interface AgentRun {
  key: string;
  conversation: Turn[];
  status: "queued" | "running" | "done" | "error";
  /** Sim minute the agent's reply lands on the phone. */
  finishedAt?: number;
  result?: PipelineResult;
  error?: string;
}

export interface TriageEntry {
  persona: Persona;
  truth: WorldTruth;
  status: TriageStatus;
  priority: number;
  priorityReason: string;
  thread: ThreadMessage[];
  /** Conversation is ready for (another) agent pass. */
  conversation: Turn[] | null;
  conversationKey: string | null;
  run?: AgentRun;
  /** Most recent completed assessment, even if a newer message is being re-analyzed. */
  result?: PipelineResult;
  hasLiveMessages: boolean;
}

function vulnerabilityBonus(p: Persona): number {
  return Math.min(10, p.vulnerabilities.length * 3.5);
}

export function statusFromSeverity(severity: number): TriageStatus {
  if (severity >= 70) return "critical";
  if (severity >= 30) return "needs_help";
  return "safe";
}

/** Everything on the policyholder's phone at sim minute t. */
function buildThread(p: Persona, truth: WorldTruth, t: number, live: ThreadMessage[], runs: AgentRun[]): ThreadMessage[] {
  const name = p.name.split(" ")[0];
  const at0 = truth.impactAt;
  if (t < at0 + OUTREACH_AT) return [...live];
  const thread: ThreadMessage[] = [
    {
      at: at0 + OUTREACH_AT,
      from: "system",
      text: `State Farm: ${name}, a tornado was reported near ${p.address.street}. Are you and your household safe? Reply SAFE, or tell us what happened and we'll start your claim.`,
    },
  ];
  truth.messages.forEach((text, i) => {
    if (truth.replyTimes[i] !== undefined && truth.replyTimes[i] <= t) thread.push({ at: truth.replyTimes[i], from: "persona", text });
  });
  thread.push(...live);
  const firstReply = Math.min(truth.replyTimes[0] ?? Infinity, ...live.map((m) => m.at));
  if (firstReply > at0 + SILENT_AFTER && t >= at0 + SILENT_AFTER) {
    thread.push({ at: at0 + SILENT_AFTER, from: "system", text: `Checking on you again, ${name}. Reply 1 if you're safe, 2 if you need help. We're here.` });
  }
  for (const run of runs) {
    if (run.status === "done" && run.result && run.finishedAt !== undefined) thread.push({ at: run.finishedAt, from: "agent", text: replyOf(run.result) });
  }
  return thread.sort((a, b) => a.at - b.at);
}

/** What the agent gets: the thread up to the policyholder's latest message. */
function conversationFrom(thread: ThreadMessage[]): Turn[] {
  const turns: Turn[] = thread.map((m) => ({ from: m.from === "persona" ? "policyholder" : "state_farm", text: m.text }));
  let last = turns.length - 1;
  while (last >= 0 && turns[last].from !== "policyholder") last--;
  return turns.slice(0, last + 1);
}

export function conversationKey(turns: Turn[]): string {
  return turns.map((t) => `${t.from[0]}:${t.text}`).join("␞");
}

export function triageAt(p: Persona, truth: WorldTruth, t: number, live: ThreadMessage[], runs: AgentRun[], agentOnline: boolean): TriageEntry {
  const since = t - truth.impactAt;
  const thread = buildThread(p, truth, t, live, runs);
  const delivered = truth.replyTimes.filter((r) => r <= t).length;
  const replied = delivered > 0 || live.length > 0;
  const ready = (delivered > 0 && delivered === truth.replyTimes.length) || live.length > 0;
  const conversation = ready ? conversationFrom(thread) : null;
  const key = conversation ? conversationKey(conversation) : null;
  const run = runs.at(-1);
  const result = [...runs].reverse().find((r) => r.status === "done")?.result;
  const current = !!run && run.key === key;
  const severity = current && run.status === "done" && run.result ? severityOf(run.result) : null;
  const lastSeverity = result ? severityOf(result) : null;

  let status: TriageStatus;
  let priority: number;
  let priorityReason: string;
  if (replied && severity !== null) {
    status = statusFromSeverity(severity);
    priority = severity * 0.86 + vulnerabilityBonus(p);
    priorityReason = reasonOf(run!.result!);
  } else if (replied && (!agentOnline || (current && (run.status === "error" || run.status === "done")))) {
    // Offline, a failed request, or a 200 with agent_unavailable: a person has to read it.
    status = "unassessed";
    priority = 55 + vulnerabilityBonus(p);
    priorityReason = !agentOnline
      ? "Replied. Agent offline, needs a person to read it."
      : run!.status === "error"
        ? `Agent error: ${run!.error ?? "unknown"}`
        : reasonOf(run!.result!);
  } else if (replied) {
    status = "analyzing";
    priority = (lastSeverity ?? 55) * (lastSeverity === null ? 1 : 0.86) + vulnerabilityBonus(p);
    priorityReason = result ? "New message, re-assessing" : "Nemotron is reading their message";
  } else if (since >= SILENT_AFTER) {
    status = "silent";
    priority = 46 + Math.min(26, (since - SILENT_AFTER) * 0.4) + vulnerabilityBonus(p) * 1.2 + truth.intensity * 10;
    const why = [`No reply for ${Math.round(since - OUTREACH_AT)} min`];
    if (truth.intensity > 0.7) why.push("in the damage core");
    if (p.vulnerabilities.length) why.push(p.vulnerabilities[0].toLowerCase());
    if (since >= ESCALATE_AFTER) why.push("escalated to agent for a welfare call");
    priorityReason = why.join(" · ");
  } else {
    status = since >= OUTREACH_AT ? "awaiting" : "monitoring";
    priority = 15 + truth.intensity * 20;
    priorityReason = since >= OUTREACH_AT ? "Check-in sent, waiting for a reply" : since >= 0 ? "Tornado passing now" : "In the projected path";
  }

  return {
    persona: p,
    truth,
    status,
    priority: Math.min(99, Math.round(priority)),
    priorityReason,
    thread,
    conversation,
    conversationKey: key,
    run,
    result,
    hasLiveMessages: live.length > 0,
  };
}

export const STATUS_ORDER: TriageStatus[] = ["critical", "silent", "analyzing", "unassessed", "needs_help", "awaiting", "safe", "monitoring"];

export interface AgentAccuracy {
  scored: number;
  severityWithin10: number;
  severityMae: number;
  routeCorrect: number;
  criticalTotal: number;
  criticalMissed: number;
}

/** Score the agent against the simulator's hidden truth. Live-typed conversations aren't scored. */
export function scoreAgent(entries: TriageEntry[]): AgentAccuracy {
  const scored = entries.filter((e) => !e.hasLiveMessages && e.run?.status === "done" && e.run.key === e.conversationKey && !!e.run.result && severityOf(e.run.result) !== null);
  let within = 0;
  let err = 0;
  let route = 0;
  let criticalTotal = 0;
  let criticalMissed = 0;
  for (const e of scored) {
    const r = e.run!.result!;
    const diff = Math.abs(severityOf(r)! - e.truth.severity);
    err += diff;
    if (diff <= 10) within++;
    if (routeOf(r) === e.truth.expectedRoute) route++;
    if (e.truth.severity >= 90) {
      criticalTotal++;
      if (routeOf(r) !== "human_review") criticalMissed++;
    }
  }
  return { scored: scored.length, severityWithin10: within, severityMae: scored.length ? err / scored.length : 0, routeCorrect: route, criticalTotal, criticalMissed };
}
