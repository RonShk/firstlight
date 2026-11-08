// Append-only audit events. Every event carries caseId, runId (when applicable), a per-case sequence
// number and a timestamp. Large payloads (tool outputs, retrieved passages) are stored once as
// artifacts and referenced, not duplicated. Corrections are new events; nothing is overwritten.
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { json, parse, type Sqlite } from "../db/sqlite";
import { now } from "./db";

export type Actor = "customer" | "system" | "agent" | "tool" | "verifier" | "guard" | "reviewer" | "delivery";

export interface CaseEvent {
  id: number;
  caseId: string;
  runId: string | null;
  seq: number;
  at: string;
  actor: Actor;
  type: string;
  title: string;
  detail: unknown;
  toolCallId: string | null;
  ms: number | null;
  artifactId: string | null;
}

export interface NewEvent {
  caseId: string;
  runId?: string | null;
  actor: Actor;
  type: string;
  title: string;
  detail?: unknown;
  toolCallId?: string;
  ms?: number;
  /** Stored as an artifact when its JSON exceeds this many characters; the event keeps a preview. */
  artifact?: { kind: string; body: unknown };
}

const INLINE_LIMIT = 6_000;

/** In-process notifications so streams and workers wake immediately; other processes poll. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export function appendEvent(db: Sqlite, e: NewEvent): CaseEvent {
  return db.tx(() => {
    let artifactId: string | null = null;
    if (e.artifact) {
      const body = json(e.artifact.body);
      if (body.length > INLINE_LIMIT) {
        artifactId = randomUUID();
        db.run("INSERT INTO artifacts VALUES (?,?,?,?,?,?)", artifactId, e.caseId, e.runId ?? null, e.artifact.kind, body, now());
      }
    }
    const seq = (db.get<{ s: number | null }>("SELECT MAX(seq) AS s FROM events WHERE case_id=?", e.caseId)?.s ?? 0) + 1;
    const detail = e.artifact && !artifactId ? { ...(e.detail as object), output: e.artifact.body } : e.detail ?? {};
    const at = now();
    const r = db.run("INSERT INTO events(case_id,run_id,seq,at,actor,type,title,detail,tool_call_id,ms,artifact_id) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      e.caseId, e.runId ?? null, seq, at, e.actor, e.type, e.title, json(detail), e.toolCallId ?? null, e.ms ?? null, artifactId);
    const event: CaseEvent = { id: Number(r.lastInsertRowid), caseId: e.caseId, runId: e.runId ?? null, seq, at, actor: e.actor,
      type: e.type, title: e.title, detail, toolCallId: e.toolCallId ?? null, ms: e.ms ?? null, artifactId };
    queueMicrotask(() => bus.emit(`case:${e.caseId}`, event));
    return event;
  });
}

const toEvent = (r: Record<string, unknown>): CaseEvent => ({
  id: Number(r.id), caseId: String(r.case_id), runId: r.run_id ? String(r.run_id) : null, seq: Number(r.seq), at: String(r.at),
  actor: r.actor as Actor, type: String(r.type), title: String(r.title), detail: parse(r.detail),
  toolCallId: r.tool_call_id ? String(r.tool_call_id) : null, ms: r.ms == null ? null : Number(r.ms),
  artifactId: r.artifact_id ? String(r.artifact_id) : null,
});

export function caseEvents(db: Sqlite, caseId: string, afterSeq = 0): CaseEvent[] {
  return db.all("SELECT * FROM events WHERE case_id=? AND seq>? ORDER BY seq", caseId, afterSeq).map(toEvent);
}

export function runEvents(db: Sqlite, runId: string): CaseEvent[] {
  return db.all("SELECT * FROM events WHERE run_id=? ORDER BY seq", runId).map(toEvent);
}

export function artifact(db: Sqlite, id: string): { kind: string; body: unknown; caseId: string } | null {
  const r = db.get<{ kind: string; body: string; case_id: string }>("SELECT kind, body, case_id FROM artifacts WHERE id=?", id);
  return r ? { kind: r.kind, body: parse(r.body), caseId: r.case_id } : null;
}
