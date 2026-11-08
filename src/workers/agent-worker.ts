// Executes queued runs outside HTTP requests. Each worker loop leases one run at a time, heartbeats
// its lease, checkpoints after every step, and completes or fails it transactionally (case update +
// outbox insert). Losing the lease (superseded by newer information) aborts the run; its reply is
// never written. Several loops run per process, and several processes can share the SQLite file.
import { randomUUID } from "node:crypto";
import { config, chatConfigured } from "../config";
import type { Sqlite } from "../db/sqlite";
import { executeRun, type AgentDeps } from "../agent/runner";
import { nemotronGuard } from "../agent/guard";
import { nemotron } from "../agent/model";
import { FALLBACK_REPLY } from "../agent/finalize";
import { explainFailure } from "../agent/failure";
import type { Decision } from "../agent/schemas";
import { now, ops } from "../cases/db";
import { appendEvent, bus } from "../cases/events";
import { updateCase, type CaseStatus } from "../cases/repository";
import { claimRun, completeRun, deferRun, failRun, getRun, heartbeat, LeaseLostError, type RunRecord } from "../cases/runs";
import { TransientModelError } from "../agent/model";
import { startCapacity, stopCapacity } from "./capacity";
import { autoFileReady } from "../cases/claim-files";
import { deliverPending, queueReply, type DeliveryAdapter } from "../delivery/outbox";
import { simulatorDelivery } from "../delivery/simulator";
import { smsDelivery } from "../delivery/sms";
import { nvidiaEmbedder } from "../knowledge/embeddings";
import { nvidiaReranker } from "../knowledge/rerank";
import { knowledge, knowledgeAvailable } from "../knowledge/store";
import type { Channel } from "../cases/repository";

export const ADAPTERS: Partial<Record<Channel, DeliveryAdapter>> = { simulation: simulatorDelivery, web: simulatorDelivery, sms: smsDelivery() };

export function defaultAgentDeps(db: Sqlite = ops()): AgentDeps {
  const c = config();
  const model = nemotron(c);
  return { db, model, verifier: process.env.AGENT_VERIFIER === "off" ? null : model, guard: nemotronGuard(c),
    knowledge: knowledgeAvailable() ? knowledge() : null, embedder: nvidiaEmbedder(c), reranker: nvidiaReranker(c), limits: c.limits };
}

export interface StoredDecision {
  decision: Decision;
  citations: unknown[];
  verified: boolean;
}

function caseStatus(d: Decision): CaseStatus {
  if (d.immediate_danger) return "emergency";
  return d.next_action === "human_review" ? "needs_review" : d.next_action === "ask_customer" ? "awaiting_customer" : "responded";
}

function ensureReview(db: Sqlite, run: RunRecord, priority: "urgent" | "high" | "normal", reason: string) {
  if (db.get("SELECT 1 AS ok FROM review_requests WHERE run_id=?", run.id)) return;
  const id = `review_${randomUUID().slice(0, 10)}`;
  db.run("INSERT INTO review_requests VALUES (?,?,?,?,?,?,?)", id, run.caseId, run.id, priority, reason, "queued", now());
  appendEvent(db, { caseId: run.caseId, runId: run.id, actor: "system", type: "review.requested", title: `Queued for ${priority} human review`, detail: { review_request_id: id, reason } });
}

/** Process one leased run to completion. Returns false when the run was superseded mid-flight. */
export async function processRun(run: RunRecord, owner: string, deps: AgentDeps): Promise<boolean> {
  const { db } = deps;
  const controller = new AbortController();
  const beat = setInterval(() => { if (!heartbeat(db, run.id, owner)) controller.abort(new LeaseLostError(run.id)); }, 10_000);
  try {
    const result = await executeRun(run, owner, deps, controller.signal);
    const d = result.decision;
    const stored: StoredDecision = { decision: d, citations: result.citations, verified: result.verified };
    completeRun(db, run.id, owner, stored, result.usage, (r) => {
      updateCase(db, r.caseId, { status: caseStatus(d), severity: d.severity, summary: d.summary, decision: d });
      if (d.next_action === "human_review" || d.immediate_danger) {
        ensureReview(db, r, d.immediate_danger ? "urgent" : d.severity >= 70 ? "high" : "normal", d.decision_reason);
      }
      queueReply(db, { caseId: r.caseId, runId: r.id, body: d.reply, hold: result.hold });
      appendEvent(db, { caseId: r.caseId, runId: r.id, actor: "system", type: "run.completed", title: "Agent run completed",
        detail: { usage: result.usage, verified: result.verified } });
    });
    // A verified review that proves every reported loss covered files the claim on its own.
    try { autoFileReady(db, [run.caseId]); } catch (e) { console.error(`[claims] auto-file ${run.caseId}: ${(e as Error).message}`); }
    return true;
  } catch (e) {
    const lost = e instanceof LeaseLostError || controller.signal.reason instanceof LeaseLostError || getRun(db, run.id)?.status === "superseded";
    if (lost) {
      appendEvent(db, { caseId: run.caseId, runId: run.id, actor: "system", type: "run.stopped", title: "Run stopped: newer information superseded it", detail: {} });
      return false;
    }
    const message = (e as Error).message || String(e);
    // Connection drops, model stalls and overload are not the run's fault: re-queue it to resume from its
    // checkpoint after a backoff. Only repeated infrastructure failures fail the run.
    if (e instanceof TransientModelError) {
      const deferrals = db.get<{ n: number }>("SELECT deferrals AS n FROM runs WHERE id=?", run.id)?.n ?? 0;
      if (deferRun(db, run.id, owner, Math.min(120_000, 10_000 * 2 ** deferrals), message)) {
        console.warn(`[agent] run ${run.id} deferred: ${message}`);
        return true;
      }
    }
    const retried = e instanceof TransientModelError ? db.get<{ n: number }>("SELECT deferrals AS n FROM runs WHERE id=?", run.id)?.n ?? 0 : 0;
    const error = retried ? `${message} (after ${retried} automatic retries)` : message;
    console.error(`[agent] run ${run.id} failed: ${error}`);
    failRun(db, run.id, owner, error, (getRun(db, run.id)?.usage ?? null), (r) => {
      updateCase(db, r.caseId, { status: "needs_review" });
      ensureReview(db, r, "high", `Automated review failed: ${explainFailure(error)!.summary}`.slice(0, 400));
      queueReply(db, { caseId: r.caseId, runId: r.id, body: FALLBACK_REPLY, kind: "fallback" });
    });
    return true;
  } finally {
    clearInterval(beat);
  }
}

interface WorkerPool { stop(): void; owners: string[] }
const g = globalThis as unknown as { __nightwatchWorkers?: WorkerPool };

/** Start in-process worker loops once per process (idempotent; survives dev reloads). */
export function startWorkers(options: { concurrency?: number; deps?: () => AgentDeps } = {}): WorkerPool | null {
  if (g.__nightwatchWorkers) return g.__nightwatchWorkers;
  const c = config();
  if (!chatConfigured(c)) { console.warn("[agent] Nemotron not configured; workers not started"); return null; }
  const makeDeps = options.deps ?? (() => defaultAgentDeps());
  let stopped = false;
  const wake = new Set<() => void>();
  const onWork = () => { for (const w of wake) w(); };
  bus.on("work", onWork);
  const idle = () => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(t); wake.delete(done); resolve(); };
    const t = setTimeout(done, 1_000);
    wake.add(done);
  });
  // Loops are cheap (they mostly wait on network I/O); the capacity controller decides how many may
  // hold a run at once, based on live GPU load. An explicit `concurrency` pins it (tests, CLI).
  const controller = options.concurrency ? null : startCapacity(c);
  const loops = options.concurrency ?? controller!.options.max;
  const owners = Array.from({ length: loops }, (_, i) => `worker-${process.pid}-${i}-${randomUUID().slice(0, 4)}`);
  for (const owner of owners) {
    void (async () => {
      let deps: AgentDeps | null = null;
      while (!stopped) {
        let slot = false;
        try {
          deps ??= makeDeps();
          slot = controller ? controller.tryAcquire() : true;
          if (!slot) { await idle(); continue; }
          const run = claimRun(deps.db, owner);
          if (!run) { controller?.release(); slot = false; await idle(); continue; }
          await processRun(run, owner, deps);
          controller?.release(); slot = false;
          await deliverPending(deps.db, ADAPTERS);
        } catch (e) {
          if (slot) controller?.release();
          console.error(`[agent] worker ${owner}: ${(e as Error).message}`);
          await idle();
        }
      }
    })();
  }
  const sweep = setInterval(() => { void deliverPending(ops(), ADAPTERS).catch((e) => console.error(`[delivery] ${(e as Error).message}`)); }, 2_000);
  g.__nightwatchWorkers = { owners, stop() { stopped = true; clearInterval(sweep); bus.off("work", onWork); onWork(); stopCapacity(); g.__nightwatchWorkers = undefined; } };
  console.log(`[agent] ${owners.length} worker loop(s) started${controller ? `; concurrency adapts to GPU load (${controller.options.min}-${controller.options.max}, starting at ${controller.options.initial})` : ""}`);
  return g.__nightwatchWorkers;
}
