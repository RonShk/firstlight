// Claim analysis: Nemotron's danger check, then its read (summary, people, items with triage), then a
// policy-grounded decision per item. Code, not the model, has the final say on provisional payment:
// an item is approved only if it is an allowlisted kind of cost (food spoilage, extra living
// expenses, a rental car) within the cap, with a verified quote from the policy clause that grants
// that coverage. Code also approves such an item when the model said review without naming an
// exclusion, and records the model's original answer. Everything else goes to human review.

import type { z } from "zod";
import type { AgentConfig } from "./config";
import { extractJson, ModelUnavailableError, type ModelClient } from "./nemotron";
import type { PolicyIndex, PolicyLine } from "./policy-docs";
import { COVERAGE_SYSTEM, DANGER_SYSTEM, EXTRACTION_SYSTEM, coverageUser, customerText } from "./prompts";
import { retrieve, type RetrievedChunk } from "./retrieve";
import {
  ADVANCE_CATEGORIES,
  CoverageReplySchema,
  DangerCheckSchema,
  ExtractionSchema,
  type AdvanceCategory,
  type Citation,
  type ClaimAnalysis,
  type ClaimItem,
  type ClaimType,
  type CoverageArea,
  type DangerCheck,
  type EmergencyResult,
  type Extraction,
  type ItemResult,
  type ItemTriage,
} from "./schemas";

export interface AgentDeps {
  client: ModelClient;
  index: PolicyIndex;
  config: AgentConfig;
}

export class InvalidModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidModelOutputError";
  }
}

/** Ask for JSON matching schema; one retry with the validation error, then give up. */
export async function askJson<S extends z.ZodType>(
  client: ModelClient,
  system: string,
  user: string,
  schema: S,
  options?: Parameters<ModelClient["chat"]>[2],
): Promise<z.infer<S>> {
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const prompt = attempt
      ? `${user}\n\nYour previous reply was invalid (${problem}). Reply with only the corrected JSON object.`
      : user;
    const reply = await client.chat(system, prompt, options);
    try {
      return schema.parse(extractJson(reply));
    } catch (e) {
      problem = (e as Error).message.slice(0, 300);
    }
  }
  throw new InvalidModelOutputError(`model reply did not match the expected shape: ${problem}`);
}

const normalize = (s: string) =>
  s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

const MIN_QUOTE_CHARS = 15;

function verifyCitations(citations: { chunk_id: string; quote: string }[], retrieved: RetrievedChunk[]): Citation[] {
  const byId = new Map(retrieved.map((r) => [r.chunk.chunk_id, r.chunk]));
  return citations.flatMap(({ chunk_id, quote }) => {
    const chunk = byId.get(chunk_id);
    const q = normalize(quote);
    if (!chunk || q.length < MIN_QUOTE_CHARS || !normalize(chunk.text).includes(q)) return [];
    return [{ doc_id: chunk.doc_id, form_number: chunk.form_number, section: chunk.section,
              page: chunk.page, quote: quote.trim() }];
  });
}

/**
 * The allowlist: each advance category, the policy line it belongs to, and wording that only the
 * clause granting that coverage contains. A verified quote must carry that wording, so a quote from
 * a neighbouring clause in the same excerpt does not count.
 */
export const GRANTING_CLAUSES: Record<AdvanceCategory, { line: PolicyLine; clause: string; wording: RegExp }> = {
  food_spoilage: { line: "home", clause: "Refrigerated Products",
                   wording: /refrigerated (units|products)|deep freeze/ },
  living_expense: { line: "home", clause: "Additional Living Expense",
                    wording: /additional living expense|increase in (the )?cost/ },
  rental_car: { line: "auto", clause: "Car Rental Expense",
                wording: /car rental|daily (rental|transportation) charge|rental expense/ },
};

const EXCLUDING = /\b(we (do|will) not (pay|cover)|not covered|exclud)/;

/** A model reason that names an exclusion or limitation; code never overrides one of those. */
const CITES_EXCLUSION = /\b(exclu\w*|not (covered|insured)|losses not insured|we (do|will) not (pay|cover)|limitation)\b/i;

export function grantsCoverage(category: AdvanceCategory, quote: string): boolean {
  const q = normalize(quote);
  return GRANTING_CLAUSES[category].wording.test(q) && !EXCLUDING.test(q) && !/deductible/.test(q);
}

/**
 * The sentence of the granting clause for this category, taken verbatim from the retrieved chunks,
 * for when the model quoted a neighbouring clause instead. Only a sentence that grants something
 * counts: not the clause title, and not a limit ("The most we will pay").
 */
function findGrantingQuote(category: AdvanceCategory, retrieved: RetrievedChunk[]): Citation | null {
  for (const { chunk } of retrieved) {
    for (const sentence of chunk.text.split(/(?<=\.)\s+/)) {
      if (sentence.length >= MIN_QUOTE_CHARS && grantsCoverage(category, sentence) &&
          /\b(we will pay|we cover|is extended to cover)\b/i.test(sentence) &&
          !/^(\d+\.\s*)?the most we will pay|limit of liability/i.test(sentence)) {
        return { doc_id: chunk.doc_id, form_number: chunk.form_number, section: chunk.section,
                 page: chunk.page, quote: sentence.trim(), found_by_code: true };
      }
    }
  }
  return null;
}

const isAdvanceCategory = (c: string): c is AdvanceCategory => (ADVANCE_CATEGORIES as readonly string[]).includes(c);

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, 200);

/**
 * Retrieval hints per coverage area (or allowlisted category): policy wording added to the query, and
 * sections whose best clause is always shown, so a roof finds Coverage A and the windstorm peril and a
 * fence finds Other Structures however the customer described it.
 */
const COVERAGE_HINTS: Record<CoverageArea | AdvanceCategory, { terms: string; pin: RegExp[] }> = {
  dwelling: { terms: "COVERAGE A – DWELLING; accidental direct physical loss to the property described in Coverage A; " +
                     "windstorm or hail damages the structure causing an opening in a roof or wall",
              pin: [/LOSSES INSURED > COVERAGE A/] },
  other_structures: { terms: "COVERAGE A – DWELLING; Other Structures on the residence premises separated from the " +
                             "dwelling by clear space; accidental direct physical loss",
                      pin: [/PROPERTY COVERAGES > COVERAGE A/, /LOSSES INSURED > COVERAGE A/] },
  personal_property: { terms: "COVERAGE B – PERSONAL PROPERTY; windstorm or hail", pin: [/LOSSES INSURED > COVERAGE B/] },
  loss_of_use: { terms: "COVERAGE C – LOSS OF USE; Additional Living Expense; uninhabitable", pin: [/LOSS OF USE/] },
  vehicle: { terms: "PHYSICAL DAMAGE COVERAGES; Comprehensive Coverage; Collision Coverage", pin: [] },
  liability: { terms: "personal liability; bodily injury; property damage to others", pin: [] },
  other: { terms: "", pin: [] },
  food_spoilage: { terms: "Refrigerated Products; contents of deep freeze or refrigerated units; power failure",
                   pin: [/ADDITIONAL COVERAGES/] },
  living_expense: { terms: "COVERAGE C – LOSS OF USE; Additional Living Expense; residence premises uninhabitable",
                    pin: [/LOSS OF USE/] },
  rental_car: { terms: "Car Rental and Travel Expenses Coverage; daily transportation charge; car rental expense",
                pin: [/PHYSICAL DAMAGE/] },
};

/** A hotel stay without a price: the nights stated (default 3) at a typical nightly rate. */
export const DEFAULT_HOTEL_NIGHTS = 3;
export const HOTEL_NIGHTLY_USD = 150;

/** The retrieval query and pinned sections for one item. */
export function itemRetrieval(item: ClaimItem, extraction: Extraction): { query: string; pin: RegExp[] } {
  const hint = COVERAGE_HINTS[isAdvanceCategory(item.category) ? item.category : item.coverage];
  const query = [item.description, extraction.event_cause, hint.terms, ...item.search_terms].filter(Boolean).join("; ");
  return { query, pin: hint.pin };
}

export async function decideItem(item: ClaimItem, extraction: Extraction, deps: AgentDeps): Promise<ItemResult> {
  if (item.category === "living_expense" && item.estimated_amount_usd == null) {
    item = { ...item, estimated_amount_usd: DEFAULT_HOTEL_NIGHTS * HOTEL_NIGHTLY_USD, amount_is_estimate: true };
  }
  const base = { id: item.id, description: item.description, type: item.type, kind: item.kind,
                 category: item.category, coverage: item.coverage, owner: item.owner,
                 estimated_amount_usd: item.estimated_amount_usd, amount_is_estimate: item.amount_is_estimate,
                 triage: item.triage, triage_reason: item.triage_reason };
  let model_decision: ItemResult["model_decision"] = null;
  const review = (reason: string, citations: Citation[] = []): ItemResult =>
    ({ ...base, approved: false, reason, citations, model_decision, code_override: false });

  try {
    const { query, pin } = itemRetrieval(item, extraction);
    const { chunks } = await retrieve(deps.index, item.type, query, deps.client, deps.config, { pin });
    if (!chunks.length) return review("No relevant policy text was found for this item.");

    let reply;
    try {
      // Reasoning off: code makes the final approval call, so the model only reads and quotes.
      reply = await askJson(deps.client, COVERAGE_SYSTEM, coverageUser(item, extraction, chunks), CoverageReplySchema,
                            { reasoning: false });
    } catch (e) {
      if (e instanceof ModelUnavailableError || e instanceof InvalidModelOutputError) {
        console.error(`[agent] coverage check failed for ${item.id}: ${e.message}`);
        return review("Automated policy check unavailable; needs a claims specialist.");
      }
      throw e;
    }

    model_decision = { decision: reply.decision, reason: oneLine(reply.reason) };
    const citations = verifyCitations(reply.citations, chunks);
    if (isAdvanceCategory(item.category) && !citations.some((c) => grantsCoverage(item.category as AdvanceCategory, c.quote))) {
      const found = findGrantingQuote(item.category, chunks);
      if (found) citations.push(found);
    }
    const blocker = advanceBlocker(item, citations, deps.config.provisionalCapUsd);
    const estimate = item.amount_is_estimate ? ` (amount is an estimate: $${item.estimated_amount_usd})` : "";

    if (reply.decision === "eligible") {
      if (blocker) return review(blocker, citations);
      return { ...base, approved: true, reason: model_decision.reason + estimate, citations, model_decision, code_override: false };
    }
    // The model said review. For an allowlisted cost that passes every code check, code approves anyway,
    // unless the model named an exclusion or quoted one.
    const exclusion = CITES_EXCLUSION.test(reply.reason) || citations.some((c) => EXCLUDING.test(normalize(c.quote)));
    if (blocker || exclusion || !isAdvanceCategory(item.category)) return review(model_decision.reason, citations);
    const clause = GRANTING_CLAUSES[item.category].clause;
    return { ...base, approved: true, citations, model_decision, code_override: true,
             reason: `Approved by code: verified quote from the ${clause} clause, within the $${deps.config.provisionalCapUsd} limit${estimate}.` };
  } catch (e) {
    // Anything unexpected sends just this item to a person; the rest of the claim still goes through.
    console.error(`[agent] item ${item.id} failed unexpectedly: ${(e as Error).message}`);
    return review("Automated policy check failed; needs a claims specialist.");
  }
}

/** Why code will not approve this item for an advance, or null when every check passes. */
function advanceBlocker(item: ClaimItem, citations: Citation[], cap: number): string | null {
  if (item.owner === "third_party" || item.type === "umbrella") {
    return "Liability to other people always goes to a claims specialist.";
  }
  // Every allowlisted category is a cost, so damage labelled as one (e.g. a ceiling as a hotel) is refused.
  if (!isAdvanceCategory(item.category) || item.kind !== "expense") {
    return "Only spoiled food, extra living expenses and rental cars qualify for an automatic advance.";
  }
  const rule = GRANTING_CLAUSES[item.category];
  if (item.type !== rule.line) return `A ${item.type} policy does not cover this kind of cost.`;
  if (!citations.some((c) => grantsCoverage(item.category as AdvanceCategory, c.quote))) {
    return `Coverage could not be tied to a quote from the ${rule.clause} clause.`;
  }
  if (item.estimated_amount_usd == null) return "Amount unknown; needs a claims specialist.";
  if (item.estimated_amount_usd > cap) return `Estimated $${item.estimated_amount_usd} exceeds the $${cap} provisional limit.`;
  return null;
}

/** Step 1 for every text: a short dedicated call, reasoning off so the 911 reply is not delayed. */
export async function checkDanger(text: string, deps: AgentDeps): Promise<DangerCheck> {
  return askJson(deps.client, DANGER_SYSTEM, customerText(text), DangerCheckSchema,
                 { reasoning: false, timeoutMs: 20_000 });
}

/** Step 2: the claim read, reasoning off for speed. */
export async function extractClaim(text: string, deps: AgentDeps): Promise<Extraction> {
  return askJson(deps.client, EXTRACTION_SYSTEM, customerText(text), ExtractionSchema, { reasoning: false });
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** Claim processing for a text with no immediate danger: a policy-grounded decision per item. */
export async function assessClaim(extraction: Extraction, deps: AgentDeps): Promise<ClaimAnalysis> {
  const items = await Promise.all(extraction.items.map((item) => decideItem(item, extraction, deps)));
  const amounts = items.flatMap((i) => (i.estimated_amount_usd == null ? [] : [i.estimated_amount_usd]));
  // Main type first, plus any type an item has that the model left out. Umbrella (liability) only
  // when the text describes harm to someone else: another person injured or their property damaged.
  const harmsOthers = extraction.people.some((p) => p.relation === "third_party" && p.injury) ||
    extraction.items.some((i) => i.owner === "third_party");
  const claim_types = [...new Set<ClaimType>([...extraction.claim_types, ...items.map((i) => i.type)])]
    .filter((t) => t !== "umbrella" || harmsOthers);
  const claim_approved = items.length > 0 && items.every((i) => i.approved);
  return {
    status: "complete",
    // A claim with nothing itemized still needs a person to look, so it is never green.
    triage: items.length ? (Math.max(...items.map((i) => i.triage)) as ItemTriage) : 2,
    summary: extraction.summary,
    claim_types,
    claim_amount_usd: amounts.length ? sum(amounts) : null,
    approved_amount_usd: sum(items.filter((i) => i.approved).map((i) => i.estimated_amount_usd ?? 0)),
    claim_approved,
    flagged_for_human: !claim_approved,
    people: extraction.people,
    items,
  };
}

/** Triage 4: no claim processing; the case is flagged for a human. */
export function emergencyResult(check: DangerCheck): EmergencyResult {
  return { status: "emergency", triage: 4, flagged_for_human: true,
           reason: check.reason ?? "someone may be in danger right now" };
}
