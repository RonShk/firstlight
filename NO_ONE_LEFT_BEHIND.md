# No One Left Behind — project brief

HackUTD ZeroDay. Target tracks: **State Farm** (main), **NVIDIA Nemotron**, **Capital One Nessie** (last priority).
Deadline: Sun 2026-11-08, noon America/Chicago. Submission is believed to be a **video** (Pablo confirming).

This is the agreed design, not a claim that everything is built. Keep the demo loop working end to end before polishing. The claims agent pipeline exists in `src/lib/agent/` (see its README).

## Pitch

State Farm doesn't do emergency response: first responders handle rescue, and State Farm handles financial recovery. Our tool speeds that recovery up after a disaster. **Customers text us first** about what happened to them, their family, their home, or their vehicle. A Nemotron agent reads each text, triages the flood of incoming messages so the most severe cases reach a human adjuster first, and uses RAG over the policy documents to decide whether common, smaller items can get a **provisional advance payment** before the claim settles. Large, unusual, or ambiguous items always go to human review.

Three things set us apart. Lean on all of them:
1. **Severe cases first.** Every text gets a triage level, so adjusters work the worst cases first instead of the oldest.
2. **Coverage decisions are grounded in the policy text**, with the clause quoted (for example, the flood exclusion on a homeowners policy after a tsunami).
3. **Safety override.** If a text suggests someone is in danger right now (trapped, injured, fire, rising water), we skip claim processing, reply "Call 911 now," and flag the case for a human. We never forward customer data to authorities.

## Open questions (check before building on them)

- [ ] The actual State Farm prompt and judging criteria. Shape the product around their wording.
- [ ] The track limit ("Enter up to two"?). If it's two, Nessie is the first thing cut.
- [ ] SMS provider: pick one that can receive a real inbound text and send a reply. Calls are not needed.
- [ ] What gets submitted (video length, format, due time).

## Flow

```text
Customer texts us (SMS inbound) ──► acknowledgment: "Received, we're reviewing your message"
        │
        ▼
Nemotron danger check (short, dedicated call)
        │
        ├─ danger (triage 4) ──► reply "Call 911 now." ──► flagged for a human (no claim processing)
        │
        ▼
Nemotron reads the claim: summary, claim types, people, items, each item triaged 1-3
        │                  (not a claim, e.g. "hello": short help reply, nothing logged)
        │
        └─ per item: policy lookup (RAG) ──► provisional advance approved?
                                                             ├─ yes ─► Nessie payout
                                                             └─ no  ─► human adjuster review
        │
        ▼
Update text to the customer · case lands in the triage queue (4 first, then 3, 2, 1)
```

## Data (generated once, committed as files)

Claude generates a believable synthetic dataset for people. No real personal data.

| Entity | Fields |
|---|---|
| Agent | id, name, office location (lat/lon), coverage area |
| Policyholder | id, name, phone (demo phones for the on-camera people; used to match an incoming text), address + lat/lon, assigned agent, household, policies[] |
| Policy | id, type (home, auto, umbrella), limits, deductible, linked policy document |
| Policy document | Ten real State Farm forms (auto, home incl. CA HW-2105, umbrella), hand-supplied in `data/policies/raw/`, listed in `data/policies/manifest.csv`, chunked and embedded for retrieval. All forms of a line are treated as one generic policy |
| Disaster event | id, type, center, radius/polygon, start time (dashboard context) |
| Scripted inbound text | policyholder id, delay, message text (including messy ones: typos, slang, all caps) |

Scale: about 200–2,000 policyholders and 5–10 agents. Most inbound texts are scripted; the on-camera ones are live texts.

## Triage (Nemotron)

| Level | Meaning |
|---|---|
| 1 Green | Small, common, clearly covered cost (spoiled food, a hotel night, a rental car) |
| 2 Yellow | Moderate damage that needs an adjuster but is not urgent (fence, shed, cracked windshield) |
| 3 Red | Severe or urgent: water getting in, structural or roof damage, uninhabitable home, injuries, liability to others, likely exclusion, high dollar amount |
| 4 Emergency | Someone may be in danger right now: customer told to call 911, flagged for a human, no claim processing |

Levels 1-3 are assigned per item when Nemotron reads the claim; the claim's level is its highest item. Level 4 comes from a separate danger check that runs first, judging meaning rather than keywords (typos, slang, and other languages still count) and answering yes when unsure. The queue sorts by level (4 first), then by time received.

## Nemotron's jobs (beyond a chatbot)

1. **Danger check, then read and triage:** a short call decides whether someone is in danger right now; otherwise the message becomes structured JSON: summary for the adjuster, claim types, people and injuries, items with estimated amounts and triage 1-3 each.
2. **Coverage check (RAG):** retrieve the relevant clauses for each item's claim type → provisional advance approved or human review, with **quoted clause references**.
3. **Tool use (planned):** `lookup_policyholder`, `lookup_policy`, `estimate_payout`, `request_payout`. The server validates every argument before running anything.
4. **Case summary** for the human adjuster and the update text to the customer.

The UI shows tool calls and results, not hidden reasoning. If the model is down, the case shows as pending for a human, and the customer is told a specialist will follow up and to call 911 if anyone is in danger.

## Payout rules

- **Provisional advance approved** only for spoiled food, hotel or other extra living costs, and rental cars, with a quote (verified word for word) from the clause that grants that coverage, and an amount at most the configured cap (e.g. $2,500). A hotel with no price is estimated at the nights stated (default 3) at $150. If Nemotron says review without naming an exclusion, code still approves such an item and records Nemotron's original answer.
- **Human review** for anything over the cap (e.g. an $80k car), unclear coverage, excluded damage, liability to others, or a suspicious pattern (repeat claim, new payout account).
- Every payout gets a unique id, and clicking twice never pays twice.

## Nessie (last)

One company checking account seeded with **$1,000,000**. Each approved payout is a Nessie transfer. If time allows, each policyholder gets their own Nessie account so the money visibly lands. Verify real write and read-back with a key before showing it.

## Dashboard

- **MVP:** the triage queue (triage level, name, summary, claim types, claim amount, approved amount, time received, status) with triage 4 flagged at the top, plus a detail panel (messages, Nemotron tool activity, policy clauses, approve/deny).
- **Then:** a flat 2D map (Leaflet/Mapbox) with the disaster zone and a dot for each customer who texted, colored by triage level. No 3D.
- **Disaster trigger:** a button or scripted trigger fires the event: pop-up "Tsunami warning — Half Moon Bay", the zone pulses, then incoming texts start arriving and dots appear.
- Filter by agent location; an agent sees their own book first.

## Demo script (video)

1. Calm dashboard, empty queue.
2. Trigger: pop-up, the zone pulses, scripted texts start pouring in and the queue sorts itself by severity.
3. **Phone on camera** texts: "roof's gone, we're at a motel tonight". It gets the acknowledgment, the case appears with its triage level, and the agent panel shows the read → policy lookup → hotel advance approved with the clause quoted → Nessie payout → update text on the phone.
4. **Phone on camera** texts: "we're trapped upstairs, water rising". The reply is "Call 911 now." and the case jumps to the top, flagged for a human.
5. A big claim ($80k car) lands in human review; the tsunami → flood exclusion is cited. The adjuster decides.
6. End card: texts handled, advances paid, cases flagged for a human, and total time.

Record the phone scenes early, so a flaky API near the deadline can't sink the video.

## Stack

**One Next.js app** (App Router, TypeScript, Tailwind, shadcn) at the repo root. API route handlers are the backend; no separate Python server. Shared TypeScript types run from database to UI.

- Nemotron: OpenAI-compatible API via the `openai` package with a custom base URL. Route handlers validate inputs and model output (zod).
- Nemotron runs on our Brev vLLM server (`NEMOTRON_BASE_URL`); reasoning is off for all calls, and code makes the final payment decision.
- Policy RAG: NVIDIA hosted embeddings (`nvidia/nemotron-3.5-embed-1b`, separate `NEMOTRON_EMBED_*` key and URL) computed once and stored with the data (`data/policy_index.json`), cosine search in memory, lexical fallback without embeddings. No vector database.
- Database: SQLite (Drizzle or Prisma, to decide).
- SMS provider: to be chosen; check its language and webhook model first.
- Nessie: plain `fetch`.
- Run as a long-lived local server (`next start`), not serverless.
- Incoming texts will need a public URL (ngrok or cloudflared tunnel) once an SMS provider is chosen.
- Secrets server-side only (no `NEXT_PUBLIC_`); commit `.env.example` only.
- Do not build anything that forwards customer data to authorities.

```text
src/app/              pages (dashboard) + api/ route handlers
src/lib/triage/       triage queue
src/lib/outreach/     inbound texts + replies
src/lib/agent/        Nemotron client, read + triage, policy RAG, provisional-payment decision
src/lib/claims/       approval rules, payout workflow
src/lib/finance/      Nessie adapter
src/lib/db/           SQLite schema + access
src/types/            shared types
data/                 agents, policyholders, policies, policy documents, scripted inbound texts
```

## Team (proposed, confirm)

| Person | Owns |
|---|---|
| Ron | API routes, shared types, database, data generation + loading, triage queue, integration |
| Arav | Nemotron client, read + triage (incl. safety override), policy RAG, provisional-payment decision, case summaries |
| Samer | Inbound texts + replies (SMS provider), Nessie payouts, approval/idempotency |
| Pablo | Dashboard: triage queue, detail panel, map, disaster trigger animation, video |

## Build order

1. Confirm the open questions. Prove an inbound SMS + reply and a Nemotron tool call.
2. Generate the dataset; agree on contracts (the agent's response shape is in `src/lib/agent/README.md`).
3. Triage queue end to end with scripted inbound texts.
4. Plug the agent (read, triage, policy RAG) into the queue and claims.
5. Live texts on camera.
6. Approval workflow → Nessie payouts.
7. Map + disaster animation, then record the video.
