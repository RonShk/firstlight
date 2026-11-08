// Message intake: store what arrived, then queue an agent run. Never runs the agent inline.
import { config } from "../config";
import type { Sqlite } from "../db/sqlite";
import { PROMPT_VERSION } from "../agent/schemas";
import { openCase, syncTranscript, appendMessage, lastCustomerSeq, type CaseRecord, type Channel } from "./repository";
import { enqueueRun, type RunRecord } from "./runs";

export interface IntakeResult {
  case: CaseRecord;
  appended: number;
  run: RunRecord | null;
  deduplicated: boolean;
}

export function receive(db: Sqlite, input: {
  channel: Channel;
  address: string;
  customerId: string | null;
  /** Full thread (simulator) or a single new customer text (SMS/web). */
  turns?: { role: "customer" | "company"; text: string }[];
  text?: string;
}): IntakeResult {
  return db.tx(() => {
    const record = openCase(db, { channel: input.channel, address: input.address, customerId: input.customerId });
    let appended = 0;
    if (input.turns) appended = syncTranscript(db, record.id, input.turns);
    else if (input.text) { appendMessage(db, record.id, "customer", input.text); appended = 1; }
    if (!lastCustomerSeq(db, record.id)) return { case: record, appended, run: null, deduplicated: false };
    const { run, deduplicated } = enqueueRun(db, { caseId: record.id, trigger: "message", model: config().chat.model || "unconfigured", promptVersion: PROMPT_VERSION });
    return { case: record, appended, run, deduplicated };
  });
}
