// Prompts for the claim pipeline. Rules only: no credentials, no customer data beyond the text.

import type { RetrievedChunk } from "./retrieve";
import type { ClaimItem, Extraction } from "./schemas";

export const DANGER_SYSTEM = `You screen texts sent to an insurance company's claims line after a
disaster. Decide one thing: does the text suggest that someone may be in danger RIGHT NOW? Examples:
trapped, injured and not yet getting care, fire or smoke, rising or fast-moving water, can't breathe,
a medical emergency, someone missing in the disaster.

Judge the meaning, not keywords. People in a disaster write with typos, slang, abbreviations, all
caps, indirect phrasing, or in another language: "trappd", "cant get out", "watr comin in fast",
"ayuda el agua sube", "my mom isn't answering and the house is flooded", "pls help". If you are unsure,
answer true.

Not danger right now: everyone is safe, the danger is over, or the injured person is already being
treated (for example, at the hospital). Damage alone is not danger.

Reply with ONLY one JSON object: {"danger": true|false, "reason": "who is in danger and why, in a
few words" or null}`;

export const EXTRACTION_SYSTEM = `You work for an insurance company's claims team. After a disaster,
customers text the company about damage and losses. You read one customer text and prepare it for a
claims agent. Reply with ONLY one JSON object.

Fields:
- is_claim: true if the text reports a loss, damage, injury, or expense. false for anything else
  (a greeting, a question about hours or billing, a wrong number); then leave summary "", event_cause
  "", and claim_types, people and items empty.
- summary: 2-4 sentences for the claims agent. Reword the customer's message for clarity in plain,
  easy-to-understand language, using standard insurance terms where they fit (dwelling, other
  structures, personal property, loss of use, comprehensive, collision, liability). Say who is
  affected and what is damaged.
- event_cause: the peril in a few words (e.g. "hurricane wind", "flood water", "hail", "power outage").
- claim_types: every type involved, main one first: "home" (the house, other structures such as
  fences, and belongings), "auto" (vehicles), "umbrella" (liability to other people) ONLY when the text says
  someone outside the household was injured or someone else's property was damaged.
- people: everyone mentioned. {who: a specific description such as "customer's son",
  relation: customer|family|third_party|unknown, injury: specific description, or null if not hurt}.
- items: everything that may need reimbursement, one per entry:
  {id: "I1", "I2", ...;
   description: specific and clear, e.g. "roof shingles torn off";
   type: home|auto|umbrella;
   kind: "damage" (damaged property) or "expense" (a cost such as a hotel night or spoiled food);
   category: exactly one of these four values (never a coverage value):
     "food_spoilage" - e.g. "$300 of food spoiled in the fridge during the power outage"
     "living_expense" - e.g. "hotel for 3 nights because the house cannot be lived in"
     "rental_car" - e.g. "rental car while my car is in the shop"
     "other" - e.g. "fence knocked down by a tree" (all property damage is "other");
   coverage: the part of the policy the damaged item itself falls under (not what caused the damage):
     "dwelling" (the house: roof, walls, ceilings, floors, built-in fixtures), "other_structures"
     (fences, sheds, detached garages, driveways), "personal_property" (belongings, food, furniture),
     "loss_of_use" (extra living costs while the home cannot be lived in), "vehicle" (a car and its
     repair or rental), "liability" (harm to other people or their property), or "other";
   owner: customer|third_party;
   estimated_amount_usd: the stated amount, otherwise a typical amount for this kind of item, or null
     if you cannot estimate. For a hotel or other living expense with no stated price, estimate the
     nights stated (3 if not stated) at $150 per night;
   amount_is_estimate: true unless the customer stated the amount;
   triage: how urgently a human adjuster should look at this item, like medical triage:
     1 = green: a small, common cost that is clearly covered (spoiled food, a hotel night, a rental car).
     2 = yellow: moderate damage that needs an adjuster but is not urgent (a fence, a shed, a
         cracked windshield, minor exterior damage, damaged belongings).
     3 = red: severe or urgent: water getting into the home, structural or roof damage, a home that
         cannot be lived in, injuries, liability to other people, a likely exclusion (such as flood),
         or a high dollar amount.
   triage_reason: one short line explaining the level;
   search_terms: 2-5 insurance-policy phrases to look up, e.g. "additional living expense",
     "refrigerated products", "other structures", "car rental expense", "windstorm"}.
Do not invent people, injuries, or damage the message does not mention.`;

export function customerText(text: string): string {
  return `Customer message:\n"""\n${text}\n"""`;
}

export const COVERAGE_SYSTEM = `You decide whether one claim item can receive a provisional payment,
an advance paid before the official claim payout. Use ONLY the policy excerpts provided; never rely on
outside knowledge of insurance policies. All excerpts apply equally to this customer. Reply with ONLY
one JSON object:
{"decision": "eligible" | "human_review", "reason": "one line", "citations": [{"chunk_id": "...", "quote": "..."}]}

- "eligible" only when an excerpt clearly grants coverage for this item and cause, no excerpt
  excludes it, and the item is a small, common cost: spoiled food, a hotel or other extra living
  costs, or a rental car.
- Otherwise "human_review": property damage, large, uncommon, ambiguous, excluded, or liability to
  other people.
- If no excerpt is relevant to this item, choose "human_review" with reason "No relevant policy text."
- Judge the damaged item itself under the coverage it falls under, not the thing that caused the
  damage: a fence is an Other Structure under Coverage A and a ceiling is part of the dwelling, even if
  a tree or rain caused the damage. A clause about trees, shrubs or landscaping applies only when the
  tree or plant itself is the item claimed.
- Each citation quotes 1-2 sentences copied EXACTLY, word for word, from the excerpt with that
  chunk_id. Quote the sentence that grants the coverage (for spoiled food, the Refrigerated Products
  clause; for a hotel, the Additional Living Expense clause; for a rental car, the Car Rental Expense
  clause), or the sentence that excludes it.`;

export function coverageUser(item: ClaimItem, extraction: Extraction, excerpts: RetrievedChunk[]): string {
  const blocks = excerpts
    .map(({ chunk }) =>
      `[chunk_id: ${chunk.chunk_id}] ${chunk.policy_type}, form ${chunk.form_number}, section "${chunk.section}"\n${chunk.text}`,
    )
    .join("\n\n");
  const amount = item.estimated_amount_usd == null ? "unknown" : `$${item.estimated_amount_usd}`;
  return `Situation: ${extraction.summary}
Cause: ${extraction.event_cause}
Item ${item.id}: ${item.description} (${item.kind}, coverage area: ${item.coverage.replace("_", " ")}, owner: ${item.owner}, type: ${item.type}, estimated ${amount}${item.amount_is_estimate ? " (estimate)" : ""})

Policy excerpts:
${blocks}`;
}
