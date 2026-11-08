// Operational store: cases, messages, runs, append-only events, artifacts, claim drafts, review
// requests and the delivery outbox. SQLite in WAL mode, safe for several worker processes on one host.
import { Sqlite } from "../db/sqlite";
import { config } from "../config";

export const OPS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY, customer_id TEXT, channel TEXT NOT NULL, address TEXT NOT NULL,
    status TEXT NOT NULL, severity INTEGER, summary TEXT, decision TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(channel, address));
  CREATE TABLE IF NOT EXISTS case_messages (
    case_id TEXT NOT NULL REFERENCES cases(id), seq INTEGER NOT NULL, role TEXT NOT NULL,
    text TEXT NOT NULL, at TEXT NOT NULL, run_id TEXT, PRIMARY KEY (case_id, seq));
  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id), status TEXT NOT NULL,
    trigger TEXT NOT NULL, note TEXT, input_key TEXT NOT NULL, through_seq INTEGER NOT NULL,
    model TEXT NOT NULL, prompt_version TEXT NOT NULL, owner TEXT, lease_until INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0, checkpoint TEXT, decision TEXT, usage TEXT, error TEXT,
    created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
  CREATE INDEX IF NOT EXISTS runs_queue ON runs(status, created_at);
  CREATE INDEX IF NOT EXISTS runs_case ON runs(case_id, created_at);
  CREATE INDEX IF NOT EXISTS runs_key ON runs(input_key);
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL, run_id TEXT, seq INTEGER NOT NULL,
    at TEXT NOT NULL, actor TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, detail TEXT NOT NULL,
    tool_call_id TEXT, ms INTEGER, artifact_id TEXT, UNIQUE(case_id, seq));
  CREATE INDEX IF NOT EXISTS events_run ON events(run_id, id);
  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS tool_effects (
    idempotency_key TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT NOT NULL, tool TEXT NOT NULL,
    output TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS claim_drafts (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL,
    payload TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS review_requests (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT NOT NULL, priority TEXT NOT NULL,
    reason TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS outbox (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, channel TEXT NOT NULL,
    recipient TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT);
  CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status, created_at);
  CREATE TABLE IF NOT EXISTS filed_claims (
    id TEXT PRIMARY KEY, case_id TEXT NOT NULL UNIQUE, run_id TEXT, payload TEXT NOT NULL, filed_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS claim_settlements (
    claim_id TEXT PRIMARY KEY, amount_cents INTEGER NOT NULL CHECK(amount_cents>0), status TEXT NOT NULL,
    transaction_id TEXT, created_at TEXT NOT NULL);`;

/** Additive migrations for databases created by earlier versions. */
const MIGRATIONS = [
  "ALTER TABLE runs ADD COLUMN available_at INTEGER",
  "ALTER TABLE runs ADD COLUMN deferrals INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'reply'",
  // Claim lifecycle: pending (drafted, awaiting human confirmation) -> confirmed (filed) | denied.
  "ALTER TABLE filed_claims ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'",
  "ALTER TABLE filed_claims ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
  "ALTER TABLE filed_claims ADD COLUMN decided_at TEXT",
  "ALTER TABLE filed_claims ADD COLUMN decision_note TEXT",
];

export function openOps(file: string): Sqlite {
  const db = new Sqlite(file);
  db.exec(OPS_SCHEMA);
  for (const sql of MIGRATIONS) {
    try { db.exec(sql); } catch (e) { if (!/duplicate column/i.test((e as Error).message)) throw e; }
  }
  // Earlier builds used filed/approved; map them onto the confirmation lifecycle.
  db.exec("UPDATE filed_claims SET status='pending' WHERE status='filed'; UPDATE filed_claims SET status='confirmed' WHERE status='approved';");
  return db;
}

// One handle per process; survives Next.js dev reloads.
const g = globalThis as unknown as { __nightwatchOps?: Sqlite };
export const ops = (): Sqlite => (g.__nightwatchOps ??= openOps(config().opsDbPath));

export const now = () => new Date().toISOString();
