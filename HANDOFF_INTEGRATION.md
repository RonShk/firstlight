# Handoff: connecting the frontend to the agent backend

For Samer (integration) and Arav (agent / RAG). Describes what's on `main` today, the one contract both sides meet at, and exactly where to plug in Arav's agent.

**Status on `main`:** the frontend and the API endpoint exist and work. The agent behind the endpoint is a placeholder written by Ron. It has **never run on a real Nemotron model**, only against a fake stand-in. Arav's RAG agent should replace it.

---

## 1. How data flows

```text
BROWSER                                          NEXT.JS SERVER                           AGENT
───────                                          ──────────────                           ─────
sim-provider.tsx
  builds 400 households + tornado (simulated)
  → 66 hit, 49 sent messages
  → for each conversation ready for the agent:
       AgentQueue  ── POST /api/agent ──────────►  src/app/api/agent/route.ts
       (4 at a time)   { personaId, conversation }   looks up the policyholder file
                                                     checks disk cache (.cache/agent/)
                                                     calls the agent ─────────────────────►  runAgent(persona, request)
                                                                                              (today: src/lib/agent/nemotron.ts)
                                                                                              (target: Arav's RAG agent)
                    ◄──────────── AgentResult JSON ◄─ caches + returns ◄────────────────────  AgentResult
  message-log.tsx renders the table
```

- The browser **never** talks to the model or holds a key. Everything goes through `/api/agent`.
- The browser sends only `personaId` + the conversation text. The server looks up the policyholder's file itself, so the client can't inject policy data.
- The simulator's hidden truth (`WorldTruth`: real damage, injuries) **stays in the browser** and is only used for the accuracy score. It must never be sent to the agent.

---

## 2. The contract (the only thing both sides must agree on)

Types live in `src/lib/agent/types.ts`. If you change them, change them there and nowhere else.

### Request: `POST /api/agent`

```json
{
  "personaId": "PH-0008",
  "conversation": [
    { "from": "state_farm",   "text": "State Farm: Margaret, a tornado was reported near 1398 Redbud Ave. Are you and your household safe? …" },
    { "from": "policyholder", "text": "dont want to bother anyone but half the roof is gone and my oxygen machine has no power" }
  ],
  "fresh": false
}
```

- `conversation` is the full thread up to the policyholder's latest message, in order.
- `fresh: true` skips the cache (use while tuning prompts).

### Response: `AgentResult`

```json
{
  "personaId": "PH-0008",
  "assessment": {
    "summary": "Roof partly gone; home oxygen has no power.",
    "safety": { "injury_reported": false, "medical_urgent": true, "displaced": true, "trapped_or_missing": false },
    "severity": 93,
    "severity_reason": "Medical emergency: oxygen without power",
    "confidence": 0.85,
    "claims": [
      {
        "line": "home",
        "coverage_part": "dwelling",
        "item": "Roof",
        "extent": "severe",
        "coverage": "covered",
        "citation_doc_id": "SF-HOME-OK",
        "citation_quote": "We will pay for accidental direct physical loss to the property described in Coverage A…",
        "reasoning": "Windstorm is not excluded"
      }
    ],
    "needs": ["power for oxygen", "shelter tonight"],
    "reply_text": "Please call 911 if you need oxygen now…",
    "follow_up_question": null
  },
  "decision": {
    "route": "human_review",
    "routeReason": "Life-safety issue reported. A person takes over immediately.",
    "lines": [{ "item": "Roof", "coverage": "covered", "coveragePart": "dwelling", "extent": "severe", "estimate": 104900, "basis": "45% of Coverage A ($233,000)", "citation": { "docId": "SF-HOME-OK", "quote": "…" } }],
    "total": 112050,
    "payableNow": 1500,
    "deductibleApplied": 2300,
    "claimNumber": "CLM-0008-60"
  },
  "reply": "Please call 911 if you need oxygen now… We're sending $1,500 now for a place to stay. Dana Whitfield, your agent in Moore, will call you shortly.",
  "steps": [
    { "kind": "model", "name": "nemotron", "detail": "requested search_policy", "ms": 812 },
    { "kind": "tool",  "name": "search_policy", "detail": "\"windstorm damage dwelling\" → SF-HOME-OK · COVERAGE A – DWELLING", "ms": 3 }
  ],
  "model": "nvidia/nemotron-nano-9b-v2",
  "ms": 4210,
  "cached": false
}
```

**What the frontend uses:**

| Field | Shown as |
|---|---|
| `assessment.severity` | Severity badge (red ≥ 70, amber 30–69, green < 30) |
| `decision.route` | Auto-approved / Agent review / No claim |
| `assessment.summary` | One-line summary under the badge |
| `decision.total` | Estimated $ |
| `reply` | "Reply sent" column. **This exact text is what the policyholder receives.** |
| `steps` | Agent trace (case view, planned) |
| `assessment.claims[].citation_*`, `decision.lines` | Claim draft with policy quotes (case view, planned) |

### Errors

| Status | Meaning | Frontend shows |
|---|---|---|
| `503` | Agent not configured (no model/key in env) | "Agent offline" |
| `400` / `404` | Bad request / unknown policyholder | "Agent error" |
| `502` | Agent threw (model down, bad output) | "Agent error" + message in tooltip |

### Status: `GET /api/agent`

```json
{ "configured": true, "model": "nvidia/nemotron-nano-9b-v2", "baseUrl": "https://…", "policiesLoaded": ["SF-HOME-OK", "…"] }
```

The top bar reads this to show `Nemotron · <model>` or `Agent offline`.

---

## 3. Where to plug in Arav's agent

There's exactly **one swap point**: the `runAgent(persona, req)` call in `src/app/api/agent/route.ts`. Everything above it (queue, cache, UI) stays the same.

### Option A: Arav's agent is Python (LangGraph etc.) → run it as a service and forward

1. Arav exposes one endpoint, e.g. `POST http://localhost:8000/assess`, that takes:
   ```json
   { "policyholder": { …file from policyholderRecord(persona)… }, "conversation": [ … ] }
   ```
   and returns an `AgentResult`-shaped JSON (at minimum `assessment`, `reply`, `steps`).
2. In `route.ts`, replace `runAgent(persona, req)` with a `fetch` to that URL (add `AGENT_SERVICE_URL` to `.env.local`). Send `policyholderRecord(persona)` from `src/lib/agent/record.ts` as the file. **It already excludes simulator-only fields.**
3. **Keep the money and routing in code:** if Arav returns only `assessment`, call `decide(persona, assessment)` and `composeReply(…)` from `src/lib/agent/decide.ts` on the Next side to fill `decision` and `reply`. The model never sets dollar amounts.

### Option B: Arav's agent is TypeScript → replace `src/lib/agent/nemotron.ts`

Export `runAgent(persona, req): Promise<AgentResult>` with the same signature. Nothing else changes.

### Either way, the agent receives

- **The conversation:** state_farm and policyholder turns.
- **The policyholder file** (`policyholderRecord`):
  - name, address, household members and ages, medical needs, vulnerability flags, local agent
  - policies: `doc_id` (e.g. `SF-HOME-OK`), form, coverage limits, deductibles, vehicles
- **The policy text:** `data/policies/<doc_id>.txt` (all 7 forms). Search must stay restricted to the person's own `doc_id`s.

It must **not** receive anything from `WorldTruth`.

---

## 4. Pointing at Nemotron (hosted or Brev)

`.env.local` (never commit it; template in `.env.example`):

```bash
# Brev (vLLM / NIM server Arav runs): his instance's HTTP port URL
NEMOTRON_BASE_URL=https://<brev-endpoint>/v1
NEMOTRON_API_KEY=            # optional for self-hosted
NEMOTRON_MODEL=nvidia/nemotron-nano-9b-v2   # whatever name the server reports

# or the hosted API while Brev isn't up
# NEMOTRON_BASE_URL=https://integrate.api.nvidia.com/v1
# NEMOTRON_API_KEY=nvapi-…
```

- Any OpenAI-compatible `/chat/completions` endpoint **with tool calling** works.
- Restart `npm run dev` after editing `.env.local`.
- Check with `curl localhost:3000/api/agent`: `configured` should be `true`.

---

## 5. Files you'll touch

| File | What it is | Touch it? |
|---|---|---|
| `src/app/api/agent/route.ts` | The endpoint: validation, cache, calls the agent | **Yes.** Swap point for Arav's agent |
| `src/lib/agent/types.ts` | The contract | Only if both sides agree |
| `src/lib/agent/record.ts` | Policyholder file the agent sees | If the agent needs more fields |
| `src/lib/agent/decide.ts` | Money, deductibles, routing rules, final reply text | Tune rules here, not in prompts |
| `src/lib/agent/nemotron.ts` | Placeholder agent (tool loop) | Replace with Arav's |
| `src/lib/agent/policy-search.ts` | Placeholder keyword search | Replace with Arav's RAG |
| `src/lib/sim/agent-queue.ts` | Browser queue → `/api/agent`, 4 at a time | Rarely (concurrency) |
| `src/lib/sim/triage.ts` | Builds each conversation, statuses, accuracy score | Rarely |
| `src/components/sim/message-log.tsx` | The table | UI work |
| `src/components/sim/sim-provider.tsx` | Builds the snapshot, feeds the queue | Rarely |
| `data/personas.json`, `data/agents.json`, `data/policy_forms.json` | Simulated data, exported for non-TS code | Regenerate with `npm run personas` |
| `data/policies/*.txt` | Policy text for RAG | Regenerate with `npm run policies` |

---

## 6. Testing the connection

1. **Endpoint alone,** with no UI:
   ```bash
   curl -s localhost:3000/api/agent -H 'content-type: application/json' -d '{
     "personaId":"PH-0008",
     "conversation":[{"from":"policyholder","text":"half the roof is gone and my oxygen machine has no power"}],
     "fresh":true }' | jq '.assessment.severity, .decision.route, .reply'
   ```
2. **Full page:** open `localhost:3000`. Rows fill in as results arrive. The header shows `N answered by Nemotron` and the accuracy vs. truth.
3. **Cache:** results are saved in `.cache/agent/` keyed by model + conversation. Delete that folder (or send `fresh: true`) after changing prompts, otherwise you'll see old answers.

---

## 7. Gotchas

- **Next 16 with `cacheComponents`:** `export const runtime = …` is not allowed in route files. A `GET` handler that reads env must `await connection()` first, or it gets frozen at build time.
- **No `Date.now()` or `Math.random()` during render** in client components (Next flags it). Do it in effects or event handlers.
- **`server-only`:** files in `src/lib/agent/` that read the disk or env import `server-only`. Don't import them from client components.
- **Concurrency:** the queue sends 4 requests at a time. A single Brev GPU may be slower; lower `CONCURRENCY` in `agent-queue.ts` if requests time out.
- **The reply is customer-facing:** the agent must never promise dollar amounts in `reply_text`. Amounts are appended by `composeReply` from the computed decision.

---

## 8. Checklist to call it connected

- [ ] Arav's agent reachable (Python service URL or TS module)
- [ ] `route.ts` calls it; `GET /api/agent` shows `configured: true` with the real model name
- [ ] The curl in §6 returns a sane severity, route and reply for PH-0008
- [ ] Full page: all 49 messages get a result, no "Agent error" rows
- [ ] Citations in results are real quotes from `data/policies/*.txt`
- [ ] Running on Brev (for the NVIDIA track), not only the hosted API
