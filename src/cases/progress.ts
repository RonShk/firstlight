// Live progress and ETA for runs. Estimates come from how long recent runs actually took, the number
// of runs ahead in the queue, and how many workers are processing in parallel.
import { config } from "../config";
import type { Sqlite } from "../db/sqlite";
import type { RunRecord } from "./runs";
import { capacity, type CapacityState } from "../workers/capacity";
import { explainFailure } from "../agent/failure";

export interface QueueStats {
  running: number;
  queued: number;
  /** Runs processed in parallel (observed or configured, whichever is higher). */
  parallel: number;
  /** Median duration of recent completed runs, seconds. */
  typicalRunSeconds: number;
  /** Seconds until everything currently queued is done. */
  drainSeconds: number;
  /** The adaptive concurrency controller's state, when this process runs workers. */
  capacity: CapacityState | null;
}

export interface RunProgress {
  phase: "queued" | "investigating" | "verifying" | "delivering" | "done" | "failed" | "superseded";
  label: string;
  queuePosition: number | null;
  elapsedSeconds: number | null;
  /** Estimated seconds until this run's reply is ready; null when unknown or done. */
  etaSeconds: number | null;
  step: number | null;
}

const DEFAULT_RUN_SECONDS = 150;

export function queueStats(db: Sqlite): QueueStats {
  const counts = db.all<{ status: string; n: number }>("SELECT status, COUNT(*) AS n FROM runs WHERE status IN ('queued','running') GROUP BY status");
  const running = counts.find((c) => c.status === "running")?.n ?? 0;
  const queued = counts.find((c) => c.status === "queued")?.n ?? 0;
  const durations = db.all<{ d: number }>(`SELECT (julianday(finished_at) - julianday(started_at)) * 86400 AS d FROM runs
    WHERE status='completed' AND started_at IS NOT NULL ORDER BY finished_at DESC LIMIT 20`).map((r) => r.d).sort((a, b) => a - b);
  const typicalRunSeconds = Math.round(durations.length ? durations[Math.floor(durations.length / 2)] : DEFAULT_RUN_SECONDS);
  const cap = capacity()?.state() ?? null;
  const parallel = Math.max(1, running, cap?.target ?? config().workers.concurrency);
  const drainSeconds = running + queued ? Math.round(Math.ceil((running + queued) / parallel) * typicalRunSeconds) : 0;
  return { running, queued, parallel, typicalRunSeconds, drainSeconds, capacity: cap };
}

const fmt = (s: number) => (s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)}s` : `${Math.round(s / 60)} min`);

export function runProgress(db: Sqlite, run: RunRecord, stats: QueueStats, replyStatus: string | null): RunProgress {
  const base = { queuePosition: null, elapsedSeconds: null, etaSeconds: null, step: null };
  if (run.status === "superseded") return { ...base, phase: "superseded", label: "Replaced by a newer run" };
  if (run.status === "failed") return { ...base, phase: "failed", label: `Failed: ${explainFailure(run.error)?.summary ?? "unknown error"}` };
  if (run.status === "completed") {
    return replyStatus === "pending" || replyStatus === "sending"
      ? { ...base, phase: "delivering", label: "Delivering reply", etaSeconds: 5 }
      : { ...base, phase: "done", label: "Done" };
  }
  const typical = stats.typicalRunSeconds;
  if (run.status === "queued") {
    const ahead = db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE status='queued' AND created_at < ?", run.createdAt)?.n ?? 0;
    const position = ahead + 1;
    // Wait for a free worker (half a run on average), then for the batches ahead, then our own run.
    const start = typical * 0.5 + Math.floor(ahead / stats.parallel) * typical;
    const eta = Math.round(start + typical);
    return { ...base, phase: "queued", queuePosition: position, etaSeconds: eta,
      label: `Queued · #${position} of ${stats.queued} · starts in ~${fmt(start)} · reply in ~${fmt(eta)}` };
  }
  const elapsed = Math.round((Date.now() - Date.parse(run.startedAt ?? run.createdAt)) / 1000);
  const step = run.usage?.turns ?? 0;
  const lastEvent = db.get<{ type: string; at: string }>("SELECT type, at FROM events WHERE run_id=? ORDER BY id DESC LIMIT 1", run.id);
  const last = lastEvent?.type ?? "";
  const verifying = last === "decision.proposed" || last.startsWith("verifier") || last.startsWith("guard.output");
  const remaining = Math.max(10, typical - elapsed);
  // Between events the run is almost always waiting on a Nemotron call; say so once it is noticeable.
  const quiet = lastEvent ? Math.round((Date.now() - Date.parse(lastEvent.at)) / 1000) : 0;
  const waiting = quiet >= 30 ? ` · waiting on Nemotron ${fmt(quiet)}` : "";
  return { queuePosition: null, elapsedSeconds: elapsed, step, etaSeconds: remaining,
    phase: verifying ? "verifying" : "investigating",
    label: `${verifying ? "Verifying decision" : `Investigating · step ${step + 1}`} · ${fmt(elapsed)} elapsed${waiting} · ${elapsed > typical ? "running long" : `~${fmt(remaining)} left`}` };
}
