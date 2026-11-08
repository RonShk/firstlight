// Read models for the API and UI, assembled from persisted records only.
import type { Sqlite } from "../db/sqlite";
import { parse } from "../db/sqlite";
import type { StoredDecision } from "../workers/agent-worker";
import { caseEvents, runEvents, type CaseEvent } from "./events";
import { getCase, messages, type CaseMessage, type CaseRecord } from "./repository";
import { caseRuns, getRun, type RunRecord } from "./runs";
import { outboxFor, type OutboxMessage } from "../delivery/outbox";
import { queueStats, runProgress, type QueueStats, type RunProgress } from "./progress";
import { isInvestigationLimit, explainFailure, type FailureExplanation } from "../agent/failure";

export interface RunSummary {
  id: string;
  caseId: string;
  status: RunRecord["status"];
  trigger: RunRecord["trigger"];
  model: string;
  promptVersion: string;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  usage: RunRecord["usage"];
  error: string | null;
  decision: StoredDecision | null;
  reply: Pick<OutboxMessage, "id" | "status" | "kind" | "body" | "sentAt" | "lastError"> | null;
  /** Latest event title, for progress display. */
  activity: string | null;
  /** Phase, queue position, elapsed time and ETA. */
  progress: RunProgress;
  /** Why the run failed, in plain language, with the raw error. Null unless failed. */
  failure: FailureExplanation | null;
  /** A bounded investigation ended and a human review task was actually queued. */
  humanInterventionNeeded: boolean;
}

export interface RunView extends RunSummary {
  events: CaseEvent[];
}

export function runSummary(db: Sqlite, run: RunRecord, stats: QueueStats = queueStats(db)): RunSummary {
  const out = outboxFor(db, run.id);
  const last = db.get<{ title: string }>("SELECT title FROM events WHERE run_id=? ORDER BY id DESC LIMIT 1", run.id);
  return {
    id: run.id, caseId: run.caseId, status: run.status, trigger: run.trigger, model: run.model, promptVersion: run.promptVersion,
    createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, usage: run.usage, error: run.error,
    decision: run.decision as StoredDecision | null,
    reply: out ? { id: out.id, status: out.status, kind: out.kind, body: out.body, sentAt: out.sentAt, lastError: out.lastError } : null,
    activity: last?.title ?? null,
    progress: runProgress(db, run, stats, out?.status ?? null),
    failure: run.status === "failed" ? explainFailure(run.error) : null,
    humanInterventionNeeded: run.status === "failed" && isInvestigationLimit(run.error) &&
      !!db.get("SELECT id FROM review_requests WHERE run_id=? AND status='queued' LIMIT 1", run.id),
  };
}

export function runView(db: Sqlite, id: string): RunView | null {
  const run = getRun(db, id);
  return run ? { ...runSummary(db, run), events: runEvents(db, id) } : null;
}

export interface CaseView {
  case: CaseRecord;
  messages: CaseMessage[];
  runs: RunSummary[];
  reviewRequests: { id: string; run_id: string; priority: string; reason: string; status: string; created_at: string }[];
  claimDrafts: { id: string; run_id: string; status: string; payload: unknown; created_at: string }[];
  events: CaseEvent[];
}

export function caseView(db: Sqlite, id: string): CaseView | null {
  const record = getCase(db, id);
  if (!record) return null;
  const stats = queueStats(db);
  return {
    case: record,
    messages: messages(db, id),
    runs: caseRuns(db, id).map((r) => runSummary(db, r, stats)),
    reviewRequests: db.all("SELECT id, run_id, priority, reason, status, created_at FROM review_requests WHERE case_id=? ORDER BY created_at", id),
    claimDrafts: db.all<Record<string, unknown>>("SELECT * FROM claim_drafts WHERE case_id=? ORDER BY created_at", id)
      .map((r) => ({ id: String(r.id), run_id: String(r.run_id), status: String(r.status), payload: parse(r.payload), created_at: String(r.created_at) })),
    events: caseEvents(db, id),
  };
}
