// Outbound customer messages. The console notifier stands in until an SMS provider is wired in.
// Messages only ever go back to the customer who texted; nothing is forwarded to anyone else.

import type { AgentUnavailable, ClaimAnalysis } from "./schemas";

export interface Notifier {
  send(to: string, body: string): Promise<void>;
}

const maskPhone = (to: string) => (to.length > 4 ? `***${to.slice(-4)}` : "***");

export const consoleNotifier: Notifier = {
  async send(to, body) {
    console.log(`[sms -> ${maskPhone(to)}] ${body}`);
  },
};

export const ACK_MESSAGE = "Received. We're reviewing your message and will send you an update shortly.";

/** The only reply to a triage 4 text. Nothing is sent to authorities or anyone else. */
export const EMERGENCY_MESSAGE = "Call 911 now.";

/** Reply to a text that is not a loss report; it is not logged as a claim. */
export const NOT_A_CLAIM_MESSAGE =
  "Hi! This number is for State Farm claims after a disaster. Text us what happened to you, your " +
  "home, or your car and we'll start your claim. For policy or billing questions, contact your agent. " +
  "If anyone is in danger, call 911.";

const PRIORITY = { 1: "standard", 2: "elevated", 3: "urgent" } as const;

/** The update after processing. Triage 4 never gets one: those customers only get EMERGENCY_MESSAGE. */
export function updateMessage(result: ClaimAnalysis | AgentUnavailable): string {
  if (result.status !== "complete") {
    // The text may never have been checked for danger, so always include the 911 line.
    return "We received your message. Our automated review is unavailable right now, so a claims " +
      "specialist will review it and contact you. If anyone is in danger right now, call 911.";
  }
  const approved = result.items.filter((i) => i.approved);
  const review = result.items.length - approved.length;
  const parts = [`Update: we've logged your claim as ${PRIORITY[result.triage]} priority.`];
  if (approved.length) {
    parts.push(`Approved for an advance payment: ${approved.map((i) => i.description).join("; ")}.`);
  }
  if (review) parts.push(`${review} item(s) need review by a claims specialist, who will contact you.`);
  if (!result.items.length) parts.push("A claims specialist will contact you for details.");
  return parts.join(" ");
}
