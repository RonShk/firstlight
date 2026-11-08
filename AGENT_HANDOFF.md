# Claims agent handoff (frontend integration)

For a teammate and their AI coding agent. Everything needed to call the agent from the frontend. No secrets here: get `.env.local` values from Arav privately.

## 1. What it does

A State Farm disaster-claims triage agent. A customer text comes in; the agent replies "received", runs a dedicated Nemotron danger check, then extracts people and items, triages each item, retrieves policy clauses for each item, decides **provisional payment vs. human review**, and sends an update text. Triage: **1 green, 2 yellow, 3 red** (per item; the claim takes the highest), **4 emergency** (reply "Call 911 now.", flag for a human, stop processing).

## 2. API contract (frontend)

**`POST /api/agent/analyze`**, file `src/app/api/agent/analyze/route.ts`. Server-side only; call it from the browser with `fetch`.

Request body (zod-validated, strings are trimmed):

| Field | Type | Limits |
|---|---|---|
| `from` | string | 1–64 chars (customer phone or id) |
| `text` | string | 1–4000 chars, not whitespace-only |

```ts
const res = await fetch("/api/agent/analyze", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ from: "+15550100010", text: "The hurricane tore shingles off our roof..." }),
});
if (res.status === 400) { /* invalid body: { error, issues } */ }
const data: PipelineResult = await res.json();
```

Types: `import type { PipelineResult } from "@/lib/agent/pipeline"` and `import type { AnalysisResult, ItemResult } from "@/lib/agent/schemas"`. Use `import type` only, so no server code (node:fs, keys) is bundled.

**HTTP codes:** `200` for every processed text, *including* model failures (see `agent_unavailable`). `400` for an invalid body. `500` only on a bug in the route itself (the pipeline catches its own errors). **Latency:** about 7 s for Rivera (5 items), under 1 s for a 911 text or "hello". There is no streaming: the response arrives once, after processing finishes.

### Response: `PipelineResult`

| Field | Meaning |
|---|---|
| `analysis_id` | UUID for this run |
| `from`, `text` | echo of the request (text trimmed) |
| `received_at` | ISO time the text arrived |
| `messages[]` | texts sent to the customer, in order: `{kind, body, sent_at, delivered, error?}`. `kind`: `ack` (always first, "Received…"), `emergency` ("Call 911 now."), `update` (final status), `info` (help reply for non-claims) |
| `result` | one of four shapes, by `result.status` (below) |

`result.status`:

- **`complete`**: a claim. Fields: `triage` (1–3, highest item), `summary` (problem reworded for the adjuster), `claim_types` (`home` / `auto` / `umbrella`; umbrella only if someone else was harmed), `claim_amount_usd` (sum of known item amounts, or null), `approved_amount_usd` (advance approved now), `claim_approved` (true only if every item is approved), `flagged_for_human` (true if any item needs review), `people[]` `{who, relation: customer|family|third_party|unknown, injury|null}`, `items[]`.
- **`emergency`**: `{triage: 4, flagged_for_human: true, reason}`. Show prominently; no items.
- **`not_a_claim`**: greeting or question; customer got the `info` help text. Do not create a case.
- **`agent_unavailable`**: `{flagged_for_human: true, error}`. Model down, bad output, or unexpected error; the customer still got an update with a 911 line.

`items[]` (`ItemResult`):

| Field | Meaning |
|---|---|
| `id`, `description` | `I1`…, plain description |
| `type` | `home` / `auto` / `umbrella` (policy line searched) |
| `kind` | `damage` or `expense` |
| `category` | `food_spoilage`, `living_expense`, `rental_car` (the only auto-approvable ones), or `other` |
| `coverage` | `dwelling`, `other_structures`, `personal_property`, `loss_of_use`, `vehicle`, `liability`, `other` |
| `owner` | `customer` or `third_party` |
| `estimated_amount_usd`, `amount_is_estimate` | amount (null if unknown); true if not stated by the customer. A hotel with no price is estimated at 3 nights × $150 |
| `triage`, `triage_reason` | 1/2/3 and a one-line reason |
| `approved`, `reason` | true = provisional payment approved; false = human review. One-line reason |
| `citations[]` | `{doc_id, form_number, section, page, quote, found_by_code?}`; quote is verified verbatim. `found_by_code: true` = code took the granting sentence from the retrieved text because the model quoted a different clause |
| `model_decision` | `{decision: eligible|human_review, reason}` from Nemotron, or null if it was not asked (no policy text found / model error) |
| `code_override` | true = code approved although the model said `human_review` (allowlisted item, verified granting quote, under cap, no exclusion named) |

### Real examples (trimmed)

Rivera (`npm run agent:samples -- rivera-hurricane`, 7.3 s); 2 of 5 items shown, quotes cut:

```json
{ "messages": [
    { "kind": "ack", "body": "Received. We're reviewing your message and will send you an update shortly.", "delivered": true },
    { "kind": "update", "body": "Update: we've logged your claim as urgent priority. Approved for an advance payment: food spoiled in the fridge during the two-day power outage; hotel stay because the home cannot be lived in. 3 item(s) need review by a claims specialist, who will contact you.", "delivered": true } ],
  "result": { "status": "complete", "triage": 3, "claim_types": ["home"],
    "summary": "Maria Rivera in Katy reports that Hurricane winds tore shingles off the roof and a tree fell through the back fence. Water is now leaking through the ceiling in the kids' room. ...",
    "claim_amount_usd": 700, "approved_amount_usd": 700, "claim_approved": false, "flagged_for_human": true,
    "people": [ { "who": "Maria Rivera", "relation": "customer", "injury": null },
                { "who": "Maria's two little ones", "relation": "family", "injury": null } ],
    "items": [
      { "id": "I3", "description": "water leaking through the ceiling in the kids' room", "type": "home", "kind": "damage",
        "category": "other", "coverage": "dwelling", "owner": "customer", "estimated_amount_usd": null, "amount_is_estimate": true,
        "triage": 3, "triage_reason": "active water intrusion into home interior", "approved": false,
        "reason": "No relevant policy text for ceiling damage under dwelling coverage.",
        "citations": [ { "doc_id": "SF-HOME-TX", "form_number": "HW-2143", "section": "SECTION I – LOSSES INSURED > COVERAGE A – DWELLING", "page": 15,
                         "quote": "We will pay for accidental direct physical loss to the property described in Coverage A, ..." } ],
        "model_decision": { "decision": "human_review", "reason": "No relevant policy text for ceiling damage under dwelling coverage." },
        "code_override": false },
      { "id": "I4", "description": "food spoiled in the fridge during the two-day power outage", "type": "home", "kind": "expense",
        "category": "food_spoilage", "coverage": "personal_property", "owner": "customer", "estimated_amount_usd": 250, "amount_is_estimate": false,
        "triage": 1, "triage_reason": "small, common spoiled food cost clearly covered", "approved": true,
        "reason": "Refrigerated Products clause extends Coverage B to spoiled food from power failure",
        "citations": [ { "doc_id": "SF-HOME-TX", "form_number": "HW-2143", "section": "SECTION I – ADDITIONAL COVERAGES", "page": 11,
                         "quote": "Coverage B is extended to cover the contents of deep freeze or refrigerated units on the residence premises ..." } ],
        "model_decision": { "decision": "eligible", "reason": "Refrigerated Products clause extends Coverage B ..." },
        "code_override": false } ] } }
```

911 (`"trappd cant get out water rising"`, 0.25 s):

```json
{ "messages": [ { "kind": "ack", "body": "Received. ..." }, { "kind": "emergency", "body": "Call 911 now." } ],
  "result": { "status": "emergency", "triage": 4, "flagged_for_human": true, "reason": "Customer trapped in rising water" } }
```

Off-topic (`"hello"`, 0.6 s):

```json
{ "messages": [ { "kind": "ack", "body": "Received. ..." },
                { "kind": "info", "body": "Hi! This number is for State Farm claims after a disaster. Text us what happened to you, your home, or your car and we'll start your claim. For policy or billing questions, contact your agent. If anyone is in danger, call 911." } ],
  "result": { "status": "not_a_claim" } }
```

Unavailable (no chat key; same shape for Brev down or any error):

```json
{ "messages": [ { "kind": "ack", "body": "Received. ..." },
                { "kind": "update", "body": "We received your message. Our automated review is unavailable right now, so a claims specialist will review it and contact you. If anyone is in danger right now, call 911." } ],
  "result": { "status": "agent_unavailable", "flagged_for_human": true, "error": "NEMOTRON_API_KEY is not set" } }
```

### What the frontend should show

- **While waiting:** on submit, show the customer's text plus a local "Received, reviewing…" bubble (same text as `ACK_MESSAGE` in `src/lib/agent/notify.ts`) and a spinner. The real `ack` arrives with the response.
- **On response:** render `messages[]` as the SMS thread (style `emergency` in red). Then by `result.status`: `emergency` → red banner with `reason`, top of queue; `complete` → overall triage badge, summary, claim types, amounts, people, item cards (triage color, approved / human review, reason, expandable citations; mark `code_override` and `found_by_code`); `not_a_claim` → note, no case; `agent_unavailable` → "flagged for a specialist" with `error`.
- **Queue order:** 4 first, then 3, 2, 1, then by `received_at`.

## 3. Run locally

```bash
cd nightwatch && npm install
cp .env.example .env.local   # then paste values from Arav
npm run dev                  # http://localhost:3000
```

| Env var | Purpose |
|---|---|
| `NEMOTRON_API_KEY` | vLLM API key for the Brev chat server |
| `NEMOTRON_BASE_URL` | Brev OpenAI-compatible URL ending in `/v1` |
| `NEMOTRON_MODEL` | exact served model id |
| `NEMOTRON_TIMEOUT_MS` | per-call timeout (default 60000; one retry) |
| `NEMOTRON_EMBED_API_KEY` | build.nvidia.com key for embeddings (never the Brev key) |
| `NEMOTRON_EMBED_BASE_URL` | embeddings URL (default NVIDIA hosted) |
| `NEMOTRON_EMBED_MODEL` | `nvidia/nemotron-3.5-embed-1b`; must match the model the index was built with |
| `PROVISIONAL_CAP_USD` | max auto-approved amount per item (default 2500) |
| `RAG_MIN_COSINE`, `RAG_MIN_LEXICAL_SCORE` | optional relevance floors (defaults 0.2 / 7.5) |
| `NESSIE_API_KEY`, `NESSIE_BASE_URL`, `DATABASE_URL` | unused for now; app runs with them empty |

| Script | Does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run agent:smoke` | live check: Brev chat + tool call, prompts return valid JSON, one embedding |
| `npm run agent:index` | rebuild `data/policy_index.json` with embeddings (slow on free tier) |
| `npm run agent:samples -- rivera-hurricane` / `-- --text "..."` | full pipeline against Brev, prints summary + full JSON |
| `npm run test:agent` | 56 offline tests, no network or keys |

```bash
curl -s localhost:3000/api/agent/analyze -H 'Content-Type: application/json' \
  -d '{"from":"+15550100010","text":"Power was out two days and $250 of food spoiled."}' | jq .result
```

## 4. Architecture

Pipeline (`src/lib/agent/pipeline.ts` → `handleIncomingText`):

1. Blank text → help reply, stop (code).
2. Send `ack` (code).
3. Danger check (**Nemotron**, short call). Danger → "Call 911 now.", triage 4, stop.
4. Claim read (**Nemotron**): summary, claim types, people, items with triage 1–3. Not a claim → help reply, stop.
5. Per item, in parallel: retrieve policy chunks (code: embeddings or keyword search) → coverage decision (**Nemotron**) → final approval (code).
6. Send `update`. Any exception → `agent_unavailable` update, flagged.

Code rules (`analyze.ts`, `schemas.ts`), never the model: label normalization (coverage values written into `category` moved back; synonyms like "hotel" → `living_expense`; unknown → `other`); umbrella only when others are harmed; allowlist (`food_spoilage`, `living_expense`, `rental_car`, expense kind, customer-owned, matching line); citation verification (quote verbatim in a retrieved chunk, from the granting clause); `found_by_code` granting sentence; cap; code override.

| File | Role |
|---|---|
| `src/app/api/agent/analyze/route.ts` | the HTTP endpoint |
| `src/lib/agent/pipeline.ts` | orchestration, messages, error safety |
| `src/lib/agent/analyze.ts` | danger check, extraction, per-item decision, allowlist, override |
| `src/lib/agent/prompts.ts` | the three system prompts |
| `src/lib/agent/schemas.ts` | zod schemas + response types |
| `src/lib/agent/retrieve.ts` | line-filtered retrieval, dedupe, section pinning |
| `src/lib/agent/nemotron.ts` | chat + embedding client (timeouts, retry) |
| `src/lib/agent/notify.ts` | customer message texts, console notifier |
| `src/lib/agent/policy-docs.ts` | manifest, chunking, index loading |
| `scripts/` | smoke, index build, samples, retrieval check |

## 5. Models and hosting

- **Chat:** `nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4` on our Brev 1× L40S via vLLM 0.27.1 (OpenAI-compatible). Reasoning is off for all calls (`chat_template_kwargs.enable_thinking: false`); only `message.content` is read.
- **Embeddings:** `nvidia/nemotron-3.5-embed-1b` on NVIDIA's hosted API (`input_type` passage/query). Free tier rate-limits (HTTP 429) and rejects batches over ~2; the index build backs off. At query time a 429 makes retrieval fall back to keyword (BM25) search with a warning; results still work, slightly worse.

## 6. Brev operations

- Live calls need the Brev instance **running**: about **$1.79/hr running, $0.03/hr stopped**. Start/stop from the Brev console (brev.nvidia.com) or `brev start <instance>` / `brev stop <instance>`.
- After a start, vLLM must be restarted. SSH may be blocked on campus Wi-Fi; use the instance's **Jupyter terminal**:

```bash
tmux new -s vllm        # or: tmux attach -t vllm
vllm serve nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4 \
  --host 0.0.0.0 --port 8000 --api-key <VLLM_API_KEY> \
  --max-model-len 32768 --reasoning-parser nemotron_v3 \
  --tool-call-parser qwen3_coder --enable-auto-tool-choice
# detach: Ctrl-b d
```

Instance name and exact launch flags: confirm with Arav. Check it's up with `npm run agent:smoke`.

## 7. Policy documents

10 forms in `data/policies/raw/`, listed in `data/policies/manifest.csv`:
- **auto:** SF-AUTO-TX (9843C), SF-AUTO-MT (9826C), SF-BIZAUTO-OH (9635C)
- **home:** SF-HOME-TX (HW-2143), SF-HOME-CA (HW-2105), SF-HOME-ME (HW-2119), SF-HOME-OK (HW-2136)
- **umbrella:** SF-UMB-WEB (overview), SF-UMB-CASE-HI, SF-UMB-CASE-OH (court filings)

All forms in a line are treated as **one generic policy, regardless of state**; retrieval filters by line only.

## 8. Not done yet / gotchas

- **Nessie** is a stub (`src/lib/finance/nessie.ts` returns `not_configured`); approved advances are not paid.
- **No SMS provider:** customer texts are logged to the console (phone masked). `messages[].delivered` is true for the console.
- **Nothing is persisted:** no DB, no queue, no approve/deny endpoint. `flagged_for_human` exists only in the response; store it yourself.
- **Never** use `NEXT_PUBLIC_` for any key; the API route runs server-side and keys stay there.
- `data/policy_index.json` (17.7 MB) is committed and **required** at runtime; rebuild it with `agent:index` if you change documents or the embedding model.
- The request blocks ~7 s for multi-item claims; set UI timeouts above 60 s (worst case with retries is longer).
- With reasoning off, damage items often have `estimated_amount_usd: null` and triage may be one level low; they go to review regardless.
- `AGENTS.md` is generated by `next dev`; ignore it.

## 9. Integration checklist (for your agent)

1. Get `.env.local` values from Arav privately; put them in `nightwatch/.env.local` (gitignored). Never print or commit them.
2. `npm install && npm run test:agent`: expect 56 passing.
3. Confirm the Brev instance is running, then `npm run agent:smoke`: expect `OK tool calling verified`, `OK pipeline prompts return valid JSON`, `OK query embedding`.
4. `npm run dev` and run the curl in section 3; expect `result.status: "complete"`.
5. In the UI, `fetch` `POST /api/agent/analyze` with `{from, text}`; type the response with `import type { PipelineResult }`.
6. Show the local "Received, reviewing…" state immediately, then render `messages[]` and `result` per section 2.
7. Handle every `result.status` (`complete`, `emergency`, `not_a_claim`, `agent_unavailable`), HTTP 400 (show `issues`), and network/timeout errors (show "try again; if anyone is in danger, call 911").
8. Test with the Rivera text, `"trappd cant get out water rising"`, and `"hello"`, plus once with Brev stopped (expect `agent_unavailable`).
