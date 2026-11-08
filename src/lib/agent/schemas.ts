// Shapes for the claim pipeline. Model replies are validated with zod before anything uses them.

import { z } from "zod";
import { POLICY_LINES, type PolicyLine } from "./policy-docs";

export type ClaimType = PolicyLine;
export const ClaimTypeSchema = z.enum(POLICY_LINES);

/**
 * 1 green (minor), 2 yellow (moderate), 3 red (severe): assigned by Nemotron per item; a claim's
 * triage is its highest item level.
 * 4: someone is in danger right now (Nemotron's dedicated danger check). The customer is told to
 * call 911, the case is flagged for a human, and claim processing is skipped.
 */
export type ItemTriage = 1 | 2 | 3;
export const ItemTriageSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);

/** What Nemotron returns from the danger check, the first step for every text. */
export const DangerCheckSchema = z.object({
  danger: z.boolean(),
  reason: z.string().nullable(), // who is in danger and why; null when danger is false
});

export const PersonSchema = z.object({
  who: z.string().min(1),
  relation: z.enum(["customer", "family", "third_party", "unknown"]),
  injury: z.string().nullable(),
});

/**
 * Only these categories can get an automatic provisional advance (see analyze.ts). Anything else,
 * including fences, roofs and water damage, always goes to a claims specialist.
 */
export const ADVANCE_CATEGORIES = ["food_spoilage", "living_expense", "rental_car"] as const;
export type AdvanceCategory = (typeof ADVANCE_CATEGORIES)[number];
export const ItemCategorySchema = z.enum([...ADVANCE_CATEGORIES, "other"]);

/** The part of the policy an item falls under; steers retrieval toward that coverage's clauses. */
export const COVERAGE_AREAS = [
  "dwelling", "other_structures", "personal_property", "loss_of_use", "vehicle", "liability", "other",
] as const;
export const CoverageAreaSchema = z.enum(COVERAGE_AREAS);

/** Common words the model uses instead of an allowed category value. */
const CATEGORY_SYNONYMS: Record<string, AdvanceCategory> = {
  "hotel": "living_expense", "lodging": "living_expense", "motel": "living_expense",
  "temporary housing": "living_expense", "additional living expense": "living_expense",
  "food": "food_spoilage", "groceries": "food_spoilage", "spoiled food": "food_spoilage",
  "rental": "rental_car", "rental car": "rental_car", "loaner car": "rental_car",
};

/**
 * Tidies the model's labels before validation. Synonyms map to allowed categories (anything else
 * unrecognised becomes "other" via .catch). Without reasoning the model often writes the coverage
 * area into `category` and leaves `coverage` out, so that is moved back, and an expense under loss
 * of use counts as a living expense. Approval still requires every code check (granting-clause
 * quote, cap), so this never approves anything by itself.
 */
function normalizeItem(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const item = { ...(raw as Record<string, unknown>) };
  if (typeof item.category === "string") {
    const key = item.category.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    item.category = CATEGORY_SYNONYMS[key] ?? item.category;
  }
  const isArea = (v: unknown) => (COVERAGE_AREAS as readonly unknown[]).includes(v);
  if (isArea(item.category) && !isArea(item.coverage)) {
    item.coverage = item.category;
    item.category = "other";
  }
  if (item.coverage === "loss_of_use" && item.kind === "expense" &&
      !(ADVANCE_CATEGORIES as readonly unknown[]).includes(item.category)) {
    item.category = "living_expense";
  }
  return item;
}

export const ClaimItemSchema = z.preprocess(normalizeItem, z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  type: ClaimTypeSchema,
  kind: z.enum(["damage", "expense"]), // damaged property, or a cost such as a hotel night
  // An unrecognised label becomes "other": safe, since "other" is never auto-approved.
  category: ItemCategorySchema.catch("other"),
  coverage: CoverageAreaSchema.catch("other"),
  owner: z.enum(["customer", "third_party"]),
  estimated_amount_usd: z.number().nonnegative().nullable(),
  amount_is_estimate: z.boolean().default(false), // true when the customer did not state the amount
  triage: ItemTriageSchema,
  triage_reason: z.string().min(1),
  search_terms: z.array(z.string()).max(8).default([]), // used for retrieval only
}));

/** What Nemotron returns when reading a text that passed the danger check. */
export const ExtractionSchema = z.object({
  is_claim: z.boolean(), // false for greetings, questions, and anything else that is not a loss report
  summary: z.string(),
  event_cause: z.string(), // used for retrieval only
  claim_types: z.array(ClaimTypeSchema),
  people: z.array(PersonSchema),
  items: z.array(ClaimItemSchema).max(12),
});

/** What Nemotron returns for one item after reading the retrieved policy excerpts. */
export const CoverageReplySchema = z.object({
  decision: z.enum(["eligible", "human_review"]),
  reason: z.string().min(1),
  citations: z.array(z.object({ chunk_id: z.string(), quote: z.string() })).max(4),
});

export type DangerCheck = z.infer<typeof DangerCheckSchema>;
export type Person = z.infer<typeof PersonSchema>;
export type ItemCategory = z.infer<typeof ItemCategorySchema>;
export type CoverageArea = z.infer<typeof CoverageAreaSchema>;
export type ClaimItem = z.infer<typeof ClaimItemSchema>;
export type Extraction = z.infer<typeof ExtractionSchema>;
export type CoverageReply = z.infer<typeof CoverageReplySchema>;

export interface Citation {
  doc_id: string;
  form_number: string;
  section: string;
  page: number | null;
  quote: string; // verified to appear verbatim in the policy text
  found_by_code?: true; // the granting sentence was taken from the retrieved text by code, not cited by the model
}

export interface ItemResult {
  id: string;
  description: string;
  type: ClaimType;
  kind: ClaimItem["kind"];
  category: ItemCategory;
  coverage: CoverageArea;
  owner: ClaimItem["owner"];
  estimated_amount_usd: number | null;
  amount_is_estimate: boolean; // the amount was estimated, not stated by the customer
  triage: ItemTriage;
  triage_reason: string;
  approved: boolean; // true = provisional payment approved now; false = human review
  reason: string; // one line
  citations: Citation[];
  model_decision: { decision: CoverageReply["decision"]; reason: string } | null; // null: the model was not asked
  code_override: boolean; // true = code approved although the model said human_review
}

/** The structured result the backend returns and the frontend displays. */
export interface ClaimAnalysis {
  status: "complete";
  triage: ItemTriage; // highest item triage
  summary: string; // the problem reworded for the claims agent, in plain language and policy terms
  claim_types: ClaimType[]; // main type first
  claim_amount_usd: number | null; // sum of item estimates; null when no item could be estimated
  approved_amount_usd: number; // provisional payment approved now
  claim_approved: boolean; // true only when every item is approved; otherwise a human reviews it
  flagged_for_human: boolean; // true when any item needs a claims specialist
  people: Person[];
  items: ItemResult[];
}

/** Safety override: claim processing skipped, customer told to call 911, case flagged for a human. */
export interface EmergencyResult {
  status: "emergency";
  triage: 4;
  flagged_for_human: true;
  reason: string; // why Nemotron judged someone to be in danger right now
}

/** Not a loss report (a greeting or a question): answered with help text, never logged as a claim. */
export interface NotAClaim {
  status: "not_a_claim";
}

/** The model was unreachable, its output was unusable, or something unexpected failed. */
export interface AgentUnavailable {
  status: "agent_unavailable";
  flagged_for_human: true;
  error: string;
}

export type AnalysisResult = ClaimAnalysis | EmergencyResult | NotAClaim | AgentUnavailable;
