# Claims agent (`src/lib/agent`)

Frontend integration guide (API contract, examples, setup, Brev ops): [AGENT_HANDOFF.md](../../../AGENT_HANDOFF.md).

After a disaster, customers text us first. State Farm handles financial recovery, not emergency
response; first responders handle rescue. This agent triages incoming texts so the most severe cases
reach a human adjuster first, and uses RAG over the policy documents to decide whether common,
smaller costs can get a provisional advance payment before the claim settles. Everything else goes to
human review.

## Flow (`pipeline.ts`)

1. **Acknowledgment** to the customer, before any processing. Whitespace-only text gets a short help
   reply instead, with no model call.
2. **Danger check** (`analyze.ts` → `checkDanger`): a short, dedicated Nemotron call that decides
   whether someone may be in danger right now. It judges meaning, not keywords (typos, slang,
   indirect phrasing, Spanish) and answers yes when unsure. **Danger:** reply **"Call 911 now."**,
   triage 4, flag the case for a human, and stop. The 911 reply never waits for the claim read.
3. **Claim read** (`extractClaim`): summary, claim types, people, and items, each with its own
   triage 1-3 and a one-line reason. **Not a claim** (e.g. "hello", "what are your hours"): a short
   help reply, and nothing is logged as a claim.
4. **Claim assessment** (`assessClaim`): per item, retrieve policy text for the item's claim type
   (`retrieve.ts`), then Nemotron decides using only that text. Code has the final say (below).
5. **Update** to the customer with the result.

All three model calls run with reasoning off. Every call has a timeout and one retry. If the model
is unreachable, its output is unusable, or anything unexpected fails, the customer still gets an
update (including "If anyone is in danger right now, call 911"), the case is flagged for a human,
and the error is logged.

Messages only go back to the customer who texted. Nothing forwards customer data to authorities or
anyone else.

## Triage

| Level | Meaning |
| --- | --- |
| 1 Green | Small, common, clearly covered cost (spoiled food, a hotel night, a rental car) |
| 2 Yellow | Moderate damage that needs an adjuster but is not urgent (fence, shed, cracked windshield) |
| 3 Red | Severe or urgent: water getting in, roof or structural damage, uninhabitable home, injuries, liability to others, likely exclusion, high dollar amount |
| 4 Emergency | Someone may be in danger right now (danger check): told to call 911, flagged, no claim processing |

Levels 1-3 are per item; the claim's triage is its highest item (2 if nothing was itemized).

## Response (`POST /api/agent/analyze`, body `{from, text}`)

```text
{ analysis_id, from, text, received_at,
  messages: [ { kind: ack | emergency | update | info, body, sent_at, delivered, error? } ],
  result }
```

`result` is one of:

- **Claim** `{ status: "complete", triage: 1|2|3, summary, claim_types: (home|auto|umbrella)[],
  claim_amount_usd, approved_amount_usd, claim_approved, flagged_for_human, people[], items[] }`.
  Each item: `{ id, description, type, kind, category, coverage, owner, estimated_amount_usd,
  amount_is_estimate, triage, triage_reason, approved, reason,
  citations[{doc_id, form_number, section, page, quote, found_by_code?}], model_decision, code_override }`.
  `claim_approved` is true only when every item is approved. Umbrella appears in `claim_types` only
  when someone outside the household was injured or someone else's property was damaged.
- **Emergency** `{ status: "emergency", triage: 4, flagged_for_human: true, reason }`.
- **Not a claim** `{ status: "not_a_claim" }`.
- **Unavailable** `{ status: "agent_unavailable", flagged_for_human: true, error }`.

## Provisional payment rules (enforced in code, `analyze.ts`)

An item is approved only if all of these hold; otherwise it goes to human review with a one-line reason:

- It is an allowlisted cost: `food_spoilage`, `living_expense` (hotel or other extra living costs),
  or `rental_car`. Fences, roofs, water damage and everything else always go to a person.
- It belongs to the customer (not liability to others) and its claim type matches the coverage
  (home for food and hotel, auto for rental car).
- A citation is verified word for word in the retrieved text **and** carries the wording of the
  clause that grants that coverage (Refrigerated Products, Additional Living Expense, Car Rental
  Expense), so a quote from a neighbouring clause does not count.
- The amount is known and at most `PROVISIONAL_CAP_USD` (default $2,500). A hotel with no price is
  estimated at the nights stated (default 3) at $150 per night and marked `amount_is_estimate`.

If Nemotron quoted a neighbouring clause instead, code takes the granting sentence verbatim from the
same retrieved text and adds it as a citation marked `found_by_code`. When Nemotron says eligible,
code still checks every rule. When Nemotron says human review but the
item passes every rule and the model neither named nor quoted an exclusion, code approves it, sets
`code_override: true`, and keeps the model's original answer in `model_decision`.

## Policy documents and retrieval

Ten hand-supplied State Farm forms in `data/policies/raw/`, listed in `data/policies/manifest.csv`
(auto TX/MT/OH business, homeowners TX HW-2143 / CA HW-2105 / ME / OK, umbrella overview and two
court filings). All forms of a line are treated as one generic policy, whatever their state.

`npm run agent:index` rebuilds `data/policy_index.json`. It embeds each chunk with
`NEMOTRON_EMBED_MODEL` (default `nvidia/nemotron-3.5-embed-1b`, `input_type: passage`) at
`NEMOTRON_EMBED_BASE_URL` with `NEMOTRON_EMBED_API_KEY`; customer queries use the same model with
`input_type: query`. The hosted endpoint takes one chunk per request and rate-limits, so the build
backs off on 429 and reuses vectors from the previous index for unchanged chunks.

Retrieval is filtered by claim type, adds the item's coverage area to the query (e.g. "COVERAGE A –
DWELLING" for a roof, "Other Structures" for a fence), always includes the best clause from that
coverage's section, drops the same clause copied in other forms, and applies a relevance floor
(`RAG_MIN_COSINE`, default 0.2). Without embeddings it falls back to BM25 lexical search.

## Run

```bash
npm run agent:smoke                                # Brev chat + tool calling, the pipeline's prompts return valid JSON, one query embedding
npm run agent:index                                # rebuild the policy index with embeddings
npm run agent:samples -- rivera-hurricane          # one sample through the full pipeline (no ids = all samples)
npm run agent:samples -- --text "your text"        # any text
npm run agent:samples -- --runs 3 --out out.json   # repeat runs, save full JSON
npx tsx scripts/retrieval-check.ts                 # top policy chunks per sample item
npm run test:agent                                 # offline tests, no network or keys
```
