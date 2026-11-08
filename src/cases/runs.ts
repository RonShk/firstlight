// Run lifecycle. A run is one attempt to process new information on a case.
//   queued -> running (leased by one worker) -> completed | failed
//   queued/running -> superseded, when newer customer information arrives before it finished.
// One active run per case; different cases run concurrently. Leases expire, so a crashed worker's
// run is picked up again from its last checkpoint. Identical input (same case, same last customer
// message, same trigger, model and prompt version) returns the existing run instead of re-running.
import { createHash, randomUUID } from "node:crypto";
import { json, parse, type Sqlite } from "../db/sqlite";
import { now } from "./db";
import { appendEvent, bus } from "./events";
import { lastCustomerSeq } from "./repository";
import { explainFailure } from "../agent/failure";

export type RunStatus = "queued" | "running" | "completed" | "failed" | "superseded";
export type RunTrigger = "message" | "reviewer";

export interface RunUsage { turns: number; toolCalls: number; promptTokens: number; completionTokens: number; revisions: number }

export interface RunRecord {
  id: string;
  caseId: string;
  status: RunStatus;
  trigger: RunTrigger;
  note: string | null;
  throughSeq: number;
  model: string;
  promptVersion: string;
  owner: string | null;
  attempts: number;
  checkpoint: unknown;
  decision: unknown;
  usage: RunUsage | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export class LeaseLostError extends Error {
  constructor(runId: string) {
    super(`Run ${runId} is no longer owned by this worker (superseded or lease expired)`);
    this.name = "LeaseLostError";
  }
}

export const LEASE_MS = 60_000;
const MAX_ATTEMPTS = 3;

const toRun = (r: Record<string, unknown>): RunRecord => ({
  id: String(r.id), caseId: String(r.case_id), status: r.status as RunStatus, trigger: r.trigger as RunTrigger,
  note: r.note ? String(r.note) : null, throughSeq: Number(r.through_seq), model: String(r.model), promptVersion: String(r.prompt_version),
  owner: r.owner ? String(r.owner) : null, attempts: Number(r.attempts), checkpoint: parse(r.checkpoint), decision: parse(r.decision),
  usage: parse(r.usage), error: r.error ? String(r.error) : null, createdAt: String(r.created_at),
  startedAt: r.started_at ? String(r.started_at) : null, finishedAt: r.finished_at ? String(r.finished_at) : null,
});

export function getRun(db: Sqlite, id: string): RunRecord | null {
  const r = db.get("SELECT * FROM runs WHERE id=?", id);
  return r ? toRun(r) : null;
}

export function caseRuns(db: Sqlite, caseId: string): RunRecord[] {
  return db.all("SELECT * FROM runs WHERE case_id=? ORDER BY created_at", caseId).map(toRun);
}

export function enqueueRun(db: Sqlite, input: { caseId: string; trigger: RunTrigger; note?: string | null; model: string; promptVersion: string;
  /** Always create a new run, even if an identical one already completed (manual re-run). */
  force?: boolean }):
  { run: RunRecord; deduplicated: boolean } {
  return db.tx(() => {
    const throughSeq = lastCustomerSeq(db, input.caseId);
    const key = createHash("sha256").update(json([input.caseId, throughSeq, input.trigger, input.note ?? null, input.model, input.promptVersion,
      input.force ? randomUUID() : null])).digest("hex");
    const existing = db.get("SELECT * FROM runs WHERE input_key=? AND status IN ('queued','running','completed') ORDER BY created_at DESC LIMIT 1", key);
    if (existing) return { run: toRun(existing), deduplicated: true };

    for (const old of db.all<{ id: string; status: string }>("SELECT id, status FROM runs WHERE case_id=? AND status IN ('queued','running')", input.caseId)) {
      db.run("UPDATE runs SET status='superseded', owner=NULL, lease_until=NULL, finished_at=? WHERE id=?", now(), old.id);
      appendEvent(db, { caseId: input.caseId, runId: old.id, actor: "system", type: "run.superseded",
        title: "Run superseded by newer information", detail: { was: old.status } });
    }
    const id = `run_${randomUUID().slice(0, 12)}`;
    db.run(`INSERT INTO runs(id,case_id,status,trigger,note,input_key,through_seq,model,prompt_version,created_at)
            VALUES (?,?,'queued',?,?,?,?,?,?,?)`, id, input.caseId, input.trigger, input.note ?? null, key, throughSeq, input.model, input.promptVersion, now());
    appendEvent(db, { caseId: input.caseId, runId: id, actor: "system", type: "run.queued",
      title: input.trigger === "reviewer" ? "Reviewer requested further investigation" : input.force ? "Manual re-run requested" : "New information queued for the agent",
      detail: { through_seq: throughSeq, model: input.model, prompt_version: input.promptVersion, note: input.note ?? null } });
    queueMicrotask(() => bus.emit("work"));
    return { run: getRun(db, id)!, deduplicated: false };
  });
}

/** Lease the oldest runnable run whose case has no other active run. */
export function claimRun(db: Sqlite, owner: string, leaseMs = LEASE_MS): RunRecord | null {
  return db.tx(() => {
    const t = Date.now();
    for (const dead of db.all<{ id: string; case_id: string }>("SELECT id, case_id FROM runs WHERE status='running' AND lease_until < ? AND attempts >= ?", t, MAX_ATTEMPTS)) {
      db.run("UPDATE runs SET status='failed', error='Exceeded retry attempts', owner=NULL, finished_at=? WHERE id=?", now(), dead.id);
      appendEvent(db, { caseId: dead.case_id, runId: dead.id, actor: "system", type: "run.failed", title: `Agent run failed: ${explainFailure("Exceeded retry attempts")!.summary}`,
        detail: { ...explainFailure("Exceeded retry attempts"), error: "Exceeded retry attempts" } });
    }
    const row = db.get<Record<string, unknown>>(`
      SELECT r.* FROM runs r WHERE ((r.status='queued' AND COALESCE(r.available_at, 0) <= ?) OR (r.status='running' AND r.lease_until < ?))
        AND NOT EXISTS (SELECT 1 FROM runs o WHERE o.case_id=r.case_id AND o.id<>r.id AND o.status='running' AND o.lease_until >= ?)
      ORDER BY r.created_at LIMIT 1`, t, t, t);
    if (!row) return null;
    const resumed = row.status === "running";
    db.run("UPDATE runs SET status='running', owner=?, lease_until=?, attempts=attempts+1, started_at=COALESCE(started_at, ?) WHERE id=?",
      owner, t + leaseMs, now(), row.id as string);
    appendEvent(db, { caseId: String(row.case_id), runId: String(row.id), actor: "system", type: resumed ? "run.resumed" : "run.started",
      title: resumed ? "Run resumed from checkpoint by another worker" : "Agent run started", detail: { worker: owner } });
    return getRun(db, String(row.id));
  });
}

export const MAX_DEFERRALS = 6;

/**
 * Put a running run back in the queue after a transient infrastructure failure (connection drop, model
 * stall, overload). It resumes from its checkpoint after `delayMs`. Returns false once the run has been
 * deferred too often or is no longer owned.
 */
export function deferRun(db: Sqlite, runId: string, owner: string, delayMs: number, reason: string): boolean {
  return db.tx(() => {
    if (!owns(db, runId, owner)) return false;
    const deferrals = db.get<{ n: number }>("SELECT deferrals AS n FROM runs WHERE id=?", runId)!.n;
    if (deferrals >= MAX_DEFERRALS) return false;
    db.run("UPDATE runs SET status='queued', owner=NULL, lease_until=NULL, attempts=0, deferrals=deferrals+1, available_at=? WHERE id=?",
      Date.now() + delayMs, runId);
    const run = getRun(db, runId)!;
    appendEvent(db, { caseId: run.caseId, runId, actor: "system", type: "run.deferred",
      title: `Paused after a temporary model problem; resuming from the last step in ~${Math.round(delayMs / 1000)}s`,
      detail: { reason, retry: deferrals + 1, of: MAX_DEFERRALS } });
    queueMicrotask(() => bus.emit("work"));
    return true;
  });
}

export function owns(db: Sqlite, runId: string, owner: string): boolean {
  return !!db.get("SELECT 1 AS ok FROM runs WHERE id=? AND owner=? AND status='running' AND lease_until >= ?", runId, owner, Date.now());
}

export function heartbeat(db: Sqlite, runId: string, owner: string, leaseMs = LEASE_MS): boolean {
  return Number(db.run("UPDATE runs SET lease_until=? WHERE id=? AND owner=? AND status='running'", Date.now() + leaseMs, runId, owner).changes) > 0;
}

export function saveCheckpoint(db: Sqlite, runId: string, owner: string, checkpoint: unknown, usage: RunUsage) {
  db.tx(() => {
    if (!owns(db, runId, owner)) throw new LeaseLostError(runId);
    db.run("UPDATE runs SET checkpoint=?, usage=?, lease_until=? WHERE id=?", json(checkpoint), json(usage), Date.now() + LEASE_MS, runId);
  });
}

/** Mark completed; `effects` runs in the same transaction (case update, outbox insert). */
export function completeRun(db: Sqlite, runId: string, owner: string, decision: unknown, usage: RunUsage, effects: (run: RunRecord) => void) {
  db.tx(() => {
    if (!owns(db, runId, owner)) throw new LeaseLostError(runId);
    db.run("UPDATE runs SET status='completed', decision=?, usage=?, owner=NULL, lease_until=NULL, finished_at=? WHERE id=?", json(decision), json(usage), now(), runId);
    effects(getRun(db, runId)!);
  });
}

export function failRun(db: Sqlite, runId: string, owner: string, error: string, usage: RunUsage | null, effects: (run: RunRecord) => void): boolean {
  return db.tx(() => {
    if (!owns(db, runId, owner)) return false;
    db.run("UPDATE runs SET status='failed', error=?, usage=?, owner=NULL, lease_until=NULL, finished_at=? WHERE id=?", error, json(usage), now(), runId);
    const run = getRun(db, runId)!;
    const why = explainFailure(error)!;
    appendEvent(db, { caseId: run.caseId, runId, actor: "system", type: "run.failed", title: `Agent run failed: ${why.summary}`,
      detail: { reason: why.summary, explanation: why.explanation, retryable: why.retryable, error } });
    effects(run);
    return true;
  });
}

/** True when a customer message newer than this run's input exists: its reply would be outdated. */
export function isStale(db: Sqlite, run: Pick<RunRecord, "caseId" | "throughSeq">): boolean {
  return lastCustomerSeq(db, run.caseId) > run.throughSeq;
}
