// Cases: one ongoing conversation per (channel, address), its messages, and the latest assessment
// (severity, summary, findings, unknowns, status). The customer id is resolved by the server.
import { randomUUID } from "node:crypto";
import { json, parse, type Sqlite } from "../db/sqlite";
import { now } from "./db";
import { appendEvent } from "./events";

export type Channel = "simulation" | "sms" | "web";
export type MessageRole = "customer" | "company" | "agent" | "reviewer";
export type CaseStatus = "open" | "investigating" | "awaiting_customer" | "responded" | "needs_review" | "emergency";

export interface CaseRecord {
  id: string;
  customerId: string | null;
  channel: Channel;
  address: string;
  status: CaseStatus;
  severity: number | null;
  summary: string | null;
  decision: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface CaseMessage {
  seq: number;
  role: MessageRole;
  text: string;
  at: string;
  runId: string | null;
}

const toCase = (r: Record<string, unknown>): CaseRecord => ({
  id: String(r.id), customerId: r.customer_id ? String(r.customer_id) : null, channel: r.channel as Channel,
  address: String(r.address), status: r.status as CaseStatus, severity: r.severity == null ? null : Number(r.severity),
  summary: r.summary ? String(r.summary) : null, decision: parse(r.decision), createdAt: String(r.created_at), updatedAt: String(r.updated_at),
});

export function openCase(db: Sqlite, input: { channel: Channel; address: string; customerId: string | null }): CaseRecord {
  return db.tx(() => {
    const existing = db.get("SELECT * FROM cases WHERE channel=? AND address=?", input.channel, input.address);
    if (existing) return toCase(existing);
    const id = `case_${randomUUID().slice(0, 12)}`;
    const at = now();
    db.run("INSERT INTO cases VALUES (?,?,?,?,?,?,?,?,?,?)", id, input.customerId, input.channel, input.address, "open", null, null, null, at, at);
    appendEvent(db, { caseId: id, actor: "system", type: "case.opened", title: "Case opened",
      detail: { channel: input.channel, customer_verified: !!input.customerId } });
    return toCase(db.get("SELECT * FROM cases WHERE id=?", id)!);
  });
}

export function getCase(db: Sqlite, id: string): CaseRecord | null {
  const r = db.get("SELECT * FROM cases WHERE id=?", id);
  return r ? toCase(r) : null;
}

export function messages(db: Sqlite, caseId: string): CaseMessage[] {
  return db.all<Record<string, unknown>>("SELECT * FROM case_messages WHERE case_id=? ORDER BY seq", caseId).map((r) => ({
    seq: Number(r.seq), role: r.role as MessageRole, text: String(r.text), at: String(r.at), runId: r.run_id ? String(r.run_id) : null,
  }));
}

export function appendMessage(db: Sqlite, caseId: string, role: MessageRole, text: string, runId: string | null = null): CaseMessage {
  return db.tx(() => {
    const seq = (db.get<{ s: number | null }>("SELECT MAX(seq) AS s FROM case_messages WHERE case_id=?", caseId)?.s ?? 0) + 1;
    const at = now();
    db.run("INSERT INTO case_messages VALUES (?,?,?,?,?,?)", caseId, seq, role, text, at, runId);
    db.run("UPDATE cases SET updated_at=? WHERE id=?", at, caseId);
    if (role === "customer") appendEvent(db, { caseId, actor: "customer", type: "message.received", title: "Customer message received", detail: { seq, text } });
    else if (role === "company") appendEvent(db, { caseId, actor: "system", type: "message.logged", title: "Company outreach logged", detail: { seq, text } });
    return { seq, role, text, at, runId };
  });
}

/**
 * Bring the stored transcript up to date with a client-supplied thread (the simulator resends the
 * whole thread). Agent replies we delivered count as company messages when comparing. Only turns past
 * the common prefix are appended; a resent identical thread appends nothing.
 */
export function syncTranscript(db: Sqlite, caseId: string, turns: { role: "customer" | "company"; text: string }[]): number {
  return db.tx(() => {
    const stored = messages(db, caseId).filter((m) => m.role !== "reviewer");
    const same = (m: CaseMessage, t: (typeof turns)[number]) => (m.role === "customer" ? "customer" : "company") === t.role && m.text === t.text;
    let i = 0;
    while (i < stored.length && i < turns.length && same(stored[i], turns[i])) i++;
    // The client may omit our own replies; skip stored agent messages it does not mention.
    let j = i;
    for (let k = i; k < stored.length && j < turns.length; k++) {
      if (same(stored[k], turns[j])) j++;
      else if (stored[k].role !== "agent") break;
    }
    const fresh = turns.slice(j);
    for (const t of fresh) appendMessage(db, caseId, t.role, t.text);
    return fresh.length;
  });
}

export function lastCustomerSeq(db: Sqlite, caseId: string): number {
  return db.get<{ s: number | null }>("SELECT MAX(seq) AS s FROM case_messages WHERE case_id=? AND role='customer'", caseId)?.s ?? 0;
}

export function updateCase(db: Sqlite, caseId: string, patch: { status?: CaseStatus; severity?: number | null; summary?: string | null; decision?: unknown }) {
  const current = getCase(db, caseId);
  if (!current) return;
  db.run("UPDATE cases SET status=?, severity=?, summary=?, decision=?, updated_at=? WHERE id=?",
    patch.status ?? current.status, patch.severity !== undefined ? patch.severity : current.severity,
    patch.summary !== undefined ? patch.summary : current.summary,
    patch.decision !== undefined ? json(patch.decision) : json(current.decision), now(), caseId);
}

export function listCases(db: Sqlite, limit = 200): CaseRecord[] {
  return db.all("SELECT * FROM cases ORDER BY updated_at DESC LIMIT ?", limit).map(toCase);
}
