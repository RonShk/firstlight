// Incoming customer text. Customers text us first after a disaster; we never contact them unprompted.
//   1. Acknowledgment, before any processing.
//   2. Danger check (a short dedicated Nemotron call). Danger: reply "Call 911 now.", flag for a
//      human, stop. No claim processing.
//   3. Nemotron's read: summary, people, items with triage 1-3. Not a loss report: help reply, stop.
//   4. Claim assessment (policy RAG per item), then an update to the customer.
// Any failure, expected or not, still sends the customer an update and flags the case for a human.
// Every message goes back to the sender only; customer data is never forwarded to anyone else.

import { randomUUID } from "node:crypto";
import { assessClaim, checkDanger, emergencyResult, extractClaim, type AgentDeps } from "./analyze";
import { agentConfig } from "./config";
import { createNemotronClient } from "./nemotron";
import {
  ACK_MESSAGE, EMERGENCY_MESSAGE, NOT_A_CLAIM_MESSAGE, consoleNotifier, updateMessage, type Notifier,
} from "./notify";
import { loadPolicyIndex } from "./policy-docs";
import type { AgentUnavailable, AnalysisResult } from "./schemas";

export interface IncomingText {
  from: string;
  text: string;
}

export interface SentMessage {
  kind: "ack" | "emergency" | "update" | "info";
  body: string;
  sent_at: string;
  delivered: boolean;
  error?: string;
}

export interface PipelineResult {
  analysis_id: string;
  from: string;
  text: string;
  received_at: string;
  messages: SentMessage[];
  result: AnalysisResult;
}

export type PipelineDeps = AgentDeps & { notifier: Notifier };

export function defaultDeps(): PipelineDeps {
  const config = agentConfig();
  return { config, client: createNemotronClient(config), index: loadPolicyIndex(), notifier: consoleNotifier };
}

export async function handleIncomingText(msg: IncomingText, deps: PipelineDeps): Promise<PipelineResult> {
  const received_at = new Date().toISOString();
  const text = msg.text.trim();
  const messages: SentMessage[] = [];
  const send = async (kind: SentMessage["kind"], body: string) => {
    const sent: SentMessage = { kind, body, sent_at: new Date().toISOString(), delivered: true };
    try {
      await deps.notifier.send(msg.from, body);
    } catch (e) {
      // A failed text must not stop the pipeline; the record shows it was not delivered.
      sent.delivered = false;
      sent.error = (e as Error).message;
    }
    messages.push(sent);
  };
  const done = (result: AnalysisResult): PipelineResult =>
    ({ analysis_id: randomUUID(), from: msg.from, text, received_at, messages, result });

  if (!text) {
    await send("info", NOT_A_CLAIM_MESSAGE); // nothing to analyze; no model call
    return done({ status: "not_a_claim" });
  }

  await send("ack", ACK_MESSAGE); // before any processing starts

  try {
    const danger = await checkDanger(text, deps);
    if (danger.danger) {
      await send("emergency", EMERGENCY_MESSAGE); // before reading the claim; no claim processing
      return done(emergencyResult(danger));
    }

    const extraction = await extractClaim(text, deps);
    if (!extraction.is_claim) {
      await send("info", NOT_A_CLAIM_MESSAGE);
      return done({ status: "not_a_claim" });
    }

    const result = await assessClaim(extraction, deps);
    await send("update", updateMessage(result));
    return done(result);
  } catch (e) {
    // Model down, unusable output, or a bug: the customer still hears back and a human takes over.
    const error = (e as Error).message || String(e);
    console.error(`[agent] analysis failed, flagged for human review: ${(e as Error).name}: ${error}`);
    const result: AgentUnavailable = { status: "agent_unavailable", flagged_for_human: true, error };
    await send("update", updateMessage(result));
    return done(result);
  }
}
