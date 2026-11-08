// Replies are persisted before they are sent, and delivery is tracked separately:
//   held (needs a reviewer) | pending -> sending -> sent | failed, or cancelled when stale.
// "Generated" and "sent" are different states. A reply is cancelled, not sent, when a newer customer
// message arrived after the run that wrote it.
import { randomUUID } from "node:crypto";
import type { Sqlite } from "../db/sqlite";
import { now } from "../cases/db";
import { appendEvent } from "../cases/events";
import { getCase, type CaseRecord, type Channel } from "../cases/repository";
import { getRun, isStale } from "../cases/runs";

export type OutboxStatus = "held" | "pending" | "sending" | "sent" | "failed" | "cancelled";

export interface OutboxMessage {
  id: string;
  caseId: string;
  runId: string;
  channel: Channel;
  recipient: string;
  body: string;
  status: OutboxStatus;
  /** "reply" is the agent's own answer; "fallback" is the generic message sent when a run failed. */
  kind: "reply" | "fallback";
  attempts: number;
  lastError: string | null;
  createdAt: string;
  sentAt: string | null;
}

export interface DeliveryAdapter {
  send(message: OutboxMessage, record: CaseRecord, db: Sqlite): Promise<void>;
}

const MAX_ATTEMPTS = 3;

/** What "delivered" means per channel. Simulation and web replies never leave this app. */
const DELIVERED_TO: Record<Channel, string> = {
  simulation: "shown on the simulated phone (demo only; no real SMS sent)",
  web: "shown in the web chat (no SMS sent)",
  sms: "sent by SMS",
};

const toMessage = (r: Record<string, unknown>): OutboxMessage => ({
  id: String(r.id), caseId: String(r.case_id), runId: String(r.run_id), channel: r.channel as Channel, recipient: String(r.recipient),
  body: String(r.body), status: r.status as OutboxStatus, kind: (r.kind === "fallback" ? "fallback" : "reply"), attempts: Number(r.attempts), lastError: r.last_error ? String(r.last_error) : null,
  createdAt: String(r.created_at), sentAt: r.sent_at ? String(r.sent_at) : null,
});

/** Call inside the run-completion transaction. `hold` keeps the reply for a reviewer instead of sending. */
export function queueReply(db: Sqlite, input: { caseId: string; runId: string; body: string; hold?: string | null; kind?: "reply" | "fallback" }) {
  const record = getCase(db, input.caseId)!;
  const id = `msg_${randomUUID().slice(0, 12)}`;
  const status: OutboxStatus = input.hold ? "held" : "pending";
  db.run("INSERT INTO outbox(id,case_id,run_id,channel,recipient,body,status,kind,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
    id, input.caseId, input.runId, record.channel, record.address, input.body, status, input.kind ?? "reply", now());
  appendEvent(db, { caseId: input.caseId, runId: input.runId, actor: "system", type: "reply.prepared",
    title: input.kind === "fallback" ? "Generic fallback reply prepared (the agent did not finish)" : "Agent reply prepared",
    detail: { outbox_id: id, kind: input.kind ?? "reply", body: input.body } });
  appendEvent(db, { caseId: input.caseId, runId: input.runId, actor: "delivery", type: input.hold ? "delivery.held" : "delivery.queued",
    title: input.hold ? "Reply held for human approval" : "Reply queued for delivery", detail: { outbox_id: id, reason: input.hold ?? null } });
  return id;
}

export function outboxFor(db: Sqlite, runId: string): OutboxMessage | null {
  const r = db.get("SELECT * FROM outbox WHERE run_id=?", runId);
  return r ? toMessage(r) : null;
}

export function releaseHeld(db: Sqlite, outboxId: string, by: string): boolean {
  return db.tx(() => {
    const r = db.get("SELECT * FROM outbox WHERE id=? AND status='held'", outboxId);
    if (!r) return false;
    const m = toMessage(r);
    db.run("UPDATE outbox SET status='pending' WHERE id=?", outboxId);
    appendEvent(db, { caseId: m.caseId, runId: m.runId, actor: "reviewer", type: "reviewer.reply_approved", title: "Reviewer approved the held reply", detail: { outbox_id: outboxId, by } });
    return true;
  });
}

/** Deliver every pending message once. Safe to call concurrently from several workers. */
export async function deliverPending(db: Sqlite, adapters: Partial<Record<Channel, DeliveryAdapter>>): Promise<number> {
  let delivered = 0;
  for (;;) {
    const message = db.tx(() => {
      const r = db.get("SELECT * FROM outbox WHERE status='pending' ORDER BY created_at LIMIT 1");
      if (!r) return null;
      db.run("UPDATE outbox SET status='sending', attempts=attempts+1 WHERE id=?", String(r.id));
      return { ...toMessage(r), attempts: Number(r.attempts) + 1 };
    });
    if (!message) return delivered;

    const run = getRun(db, message.runId);
    if (run && isStale(db, run)) {
      db.tx(() => {
        db.run("UPDATE outbox SET status='cancelled', last_error=? WHERE id=?", "Superseded by a newer customer message", message.id);
        appendEvent(db, { caseId: message.caseId, runId: message.runId, actor: "delivery", type: "delivery.cancelled",
          title: "Reply not sent: customer sent newer information", detail: { outbox_id: message.id } });
      });
      continue;
    }
    const adapter = adapters[message.channel];
    try {
      if (!adapter) throw new Error(`No delivery adapter for channel ${message.channel}`);
      await adapter.send(message, getCase(db, message.caseId)!, db);
      db.tx(() => {
        db.run("UPDATE outbox SET status='sent', sent_at=?, last_error=NULL WHERE id=?", now(), message.id);
        appendEvent(db, { caseId: message.caseId, runId: message.runId, actor: "delivery", type: "delivery.sent",
          title: `${message.kind === "fallback" ? "Fallback reply" : "Reply"} ${DELIVERED_TO[message.channel]}`,
          detail: { outbox_id: message.id, kind: message.kind, channel: message.channel, attempts: message.attempts, body: message.body } });
      });
      delivered++;
    } catch (e) {
      const error = (e as Error).message;
      const final = message.attempts >= MAX_ATTEMPTS;
      db.tx(() => {
        db.run("UPDATE outbox SET status=?, last_error=? WHERE id=?", final ? "failed" : "pending", error, message.id);
        appendEvent(db, { caseId: message.caseId, runId: message.runId, actor: "delivery", type: final ? "delivery.failed" : "delivery.retrying",
          title: final ? "Delivery failed" : "Delivery attempt failed, will retry", detail: { outbox_id: message.id, error, attempts: message.attempts } });
      });
      if (!final) return delivered; // back off until the next sweep
    }
  }
}
