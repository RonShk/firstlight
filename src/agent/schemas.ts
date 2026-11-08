// Typed decisions, findings and replies. The agent submits a Decision through the finish_review tool.
import { z } from "zod";

export const PROMPT_VERSION = "agentic-rag-2026-11-08";

export const Citation = z.object({
  chunk_id: z.string().describe("chunk_id of a passage you retrieved in this run."),
  quote: z.string().trim().min(20).max(600).describe("Exact words copied from that passage."),
});

/** Models often write the string "null" or leave a field empty; treat those as null. */
const nullish = (v: unknown) => (v === undefined || v === "" || (typeof v === "string" && /^(null|none|n\/a)$/i.test(v.trim())) ? null : v);

export const Finding = z.object({
  item: z.string().trim().min(2).max(200).describe("The reported loss or need, e.g. 'Roof partly torn off'."),
  coverage: z.preprocess((v) => nullish(v) ?? "Not determined", z.string().trim().min(2).max(80))
    .describe("Coverage part, e.g. 'Coverage A Dwelling', 'Coverage C Loss of Use', 'Comprehensive'."),
  policy_id: z.preprocess(nullish, z.string().nullable()).describe("The customer's policy this falls under; null when they have none for it."),
  status: z.enum(["likely_covered", "likely_excluded", "unclear", "no_policy"]),
  explanation: z.string().trim().min(5).max(700).describe("Why, in one to three sentences, including conditions and what is still unknown."),
  citations: z.array(Citation).max(4).default([]),
});

export const Decision = z.object({
  severity: z.number().int().min(0).max(100),
  severity_reason: z.string().trim().min(3).max(300),
  immediate_danger: z.boolean().describe("True only when someone is in present danger (trapped, injured, cannot breathe, fire, needs urgent medical help)."),
  summary: z.string().trim().min(5).max(600).describe("For the human reviewer: what happened and what matters."),
  reported_facts: z.array(z.string().trim().max(200)).max(12).default([]),
  unknowns: z.array(z.string().trim().max(200)).max(8).default([]),
  findings: z.array(Finding).max(10).default([]),
  next_action: z.enum(["reply", "ask_customer", "human_review"]),
  decision_reason: z.string().trim().min(3).max(500),
  reply: z.string().trim().min(1).max(1200).describe("The text message to send the customer."),
});

export type Decision = z.infer<typeof Decision>;

/** A list the model may send as a real array or as one string (newline/semicolon separated). */
const stringList = (max: number) => z.preprocess(
  (v) => (typeof v === "string" ? v.split(/\n|;\s*/).map((x) => x.replace(/^[-*•\d.)\s]+/, "").trim()).filter(Boolean) : v ?? []),
  z.array(z.string().trim().max(200)).max(max));

/**
 * What the model submits via finish_review. Findings are NOT part of it: they are recorded one at a time
 * with record_finding (flat arguments, validated immediately), because one large nested JSON object was
 * the main source of malformed decisions. A findings array is still accepted if the model sends one.
 */
const boundedExplanation = (max: number) => z.preprocess(
  (v) => typeof v === "string" ? v.trim().slice(0, max) : v, z.string().min(3).max(max));

export const FinishInput = Decision.omit({ findings: true, reported_facts: true, unknowns: true }).extend({
  // Internal explanations can be shortened without changing coverage, danger, routing or reply.
  summary: boundedExplanation(600),
  severity_reason: boundedExplanation(300),
  decision_reason: boundedExplanation(500),
  reported_facts: stringList(12).default([]),
  unknowns: stringList(8).default([]),
  findings: z.array(Finding).max(10).optional(),
});
export type Finding = z.infer<typeof Finding>;

export const Verdict = z.object({
  verdict: z.enum(["approve", "revise"]),
  issues: z.array(z.string().trim().min(3).max(400)).max(6).default([]),
  severity_check: z.enum(["reasonable", "too_high", "too_low"]),
});
export type Verdict = z.infer<typeof Verdict>;
