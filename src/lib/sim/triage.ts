import type { Persona, ThreadMessage, TriageStatus, WorldTruth } from "../../types/sim";
import type { RunSummary } from "../../types/agent";

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

/** One agent run (server-side) for one version of a conversation. */
export interface AgentRun {
  key: string;
  conversation: Turn[];
  status: "queued" | "running" | "done" | "error";
  caseId?: string;
  runId?: string;
  /** Sim minute the agent's reply lands on the phone. */
  finishedAt?: number;
  result?: RunSummary;
  error?: string;
}

/** The accepted decision of a run, if it produced one. */
export const decisionOf = (run?: { result?: RunSummary } | null) => run?.result?.decision?.decision ?? null;

/** True when the run's reply was actually delivered to the (simulated) phone. */
export const replyDelivered = (run?: { result?: RunSummary } | null) => run?.result?.reply?.status === "sent";

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
  /** Most recent completed run, even if a newer message is being re-analyzed. */
  result?: RunSummary;
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
    if (run.status !== "queued" && replyDelivered(run) && run.finishedAt !== undefined) thread.push({ at: run.finishedAt, from: "agent", text: run.result!.reply!.body });
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
  const result = [...runs].reverse().find((r) => r.status === "done" && decisionOf(r))?.result;
  const current = !!run && run.key === key;

  let status: TriageStatus;
  let priority: number;
  let priorityReason: string;
  const decided = current ? decisionOf(run) : null;
  if (replied && current && run.status === "done" && decided) {
    status = decided.immediate_danger ? "critical" : statusFromSeverity(decided.severity);
    priority = decided.severity * 0.86 + vulnerabilityBonus(p);
    priorityReason = decided.severity_reason || decided.summary;
  } else if (replied && (!agentOnline || (current && run.status === "error"))) {
    status = "unassessed";
    priority = 55 + vulnerabilityBonus(p);
    priorityReason = run?.result?.humanInterventionNeeded ? "Human intervention needed. Queued for claims review." : !agentOnline ? "Replied. Agent offline, needs a person to read it." : `Agent error: ${run?.error ?? "unknown"}`;
  } else if (replied) {
    status = "analyzing";
    const previous = result?.decision?.decision;
    priority = (previous ? previous.severity * 0.86 : 55) + vulnerabilityBonus(p);
    priorityReason = previous ? "New message, re-assessing" : run?.result?.activity ?? "Nemotron is reading their message";
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
  const scored = entries.filter((e) => !e.hasLiveMessages && e.run?.status === "done" && e.run.key === e.conversationKey && decisionOf(e.run));
  let within = 0;
  let err = 0;
  let route = 0;
  let criticalTotal = 0;
  let criticalMissed = 0;
  for (const e of scored) {
    const d = decisionOf(e.run)!;
    const diff = Math.abs(d.severity - e.truth.severity);
    err += diff;
    if (diff <= 10) within++;
    // There is no auto-approval: the agent either hands the case to a person or handles it by message.
    const toHuman = d.next_action === "human_review";
    if (toHuman === (e.truth.expectedRoute === "human_review")) route++;
    if (e.truth.severity >= 90) {
      criticalTotal++;
      if (!toHuman) criticalMissed++;
    }
  }
  return { scored: scored.length, severityWithin10: within, severityMae: scored.length ? err / scored.length : 0, routeCorrect: route, criticalTotal, criticalMissed };
}
