# No One Left Behind — project brief

HackUTD ZeroDay. Target tracks: **State Farm** (main), **NVIDIA Nemotron**, **Photon**, **Capital One Nessie** (last priority).
Deadline: Sun 2026-11-08, noon America/Chicago. Submission is believed to be a **video** (Pablo confirming).

This is the agreed design, not a claim that anything is built. Keep the demo loop working end to end before polishing.

## Pitch

After a disaster, the system reaches **every policyholder in the affected area**. A Nemotron agent reads the replies, checks each person's actual policy, and ranks everyone by urgency. People who **don't reply** move up the list, because silence is the warning sign. Covered, small claims are paid out on the spot; large or unclear ones go to a human agent.

Three things set us apart. Lean on all of them:
1. **Silence escalates.** Text → re-text → automated phone call → escalate to the local agent.
2. **Coverage decisions are grounded in the policy text**, with the clause quoted (for example, the flood exclusion on a homeowners policy after a tsunami).
3. **A real phone on camera** gets the text and the automated call.

## Open questions (check before building on them)

- [ ] The actual State Farm prompt and judging criteria. Shape the product around their wording.
- [ ] The track limit ("Enter up to two"?). If it's two, Nessie is the first thing cut.
- [ ] Photon access: send a real SMS and place a real call in the first 1–2 hours. If the call can't work, rethink the demo.
- [ ] What gets submitted (video length, format, due time).

## Flow

```text
Disaster hits zone ──► affected policyholders (location inside zone)
        │
        ▼
Photon text: "Are you safe? Reply 1 safe, 2 need help, or tell us what happened"
        │
        ├─ reply ───► Nemotron extracts needs + claim details
        │             └─► policy lookup (RAG) ──► covered? amount? clause cited
        │
        └─ silence ─► +10 min re-text ─► +20 min automated call ─► +30 min escalate to agent
        │
        ▼
Triage queue: RED / YELLOW / GREEN / GRAY (silent), sorted by score, filtered by agent location
        │
        ▼
Claim decision: small + clearly covered + high confidence ─► auto-approve ─► Nessie payout
                large / unclear / flagged                 ─► human agent review ─► Nessie payout
```

Escalation timers are demo values, configurable, and can be sped up for the video.

## Data (generated once, committed as files)

Claude generates a believable synthetic dataset. No real personal data.

| Entity | Fields |
|---|---|
| Agent | id, name, office location (lat/lon), coverage area |
| Policyholder | id, name, phone (demo phones for the on-camera people), address + lat/lon, assigned agent, household (elderly, children, medical needs), policies[] |
| Policy | id, type (homeowners, auto, renters, flood), limits, deductible, linked policy document |
| Policy document | Full written text with coverage sections, limits, deductibles and **exclusions**. A few templates, chunked for retrieval |
| Disaster event | id, type, center, radius/polygon, start time |
| Scripted reply | policyholder id, delay, message text (including messy ones), or **no reply** |

Scale: about 200–2,000 policyholders and 5–10 agents. Most replies are scripted; the on-camera ones are live through Photon.

## Triage score (deterministic code, not the LLM)

```text
score = need severity      (medical > no shelter > property only > safe)   ← from Nemotron extraction
      + vulnerability       (elderly, medical needs, children on file)
      + proximity           (distance to disaster center)
      + silence             (grows with minutes since first contact without a reply)
```

The weights live in one config. Every row shows *why* it scored that way. Colors: RED critical, YELLOW needs help, GREEN safe, GRAY not yet reached or silent.

## Nemotron's jobs (beyond a chatbot)

1. **Extraction:** a free-text reply becomes structured JSON, e.g. `{injuries, needs[], damage[], people, location_changed}`.
2. **Coverage check (RAG):** retrieve the relevant clauses from *that person's* policy documents → covered / not covered / unclear, an estimated amount, and **quoted clause references**.
3. **Tool use:** `lookup_policyholder`, `lookup_policy`, `estimate_payout`, `schedule_followup`, `request_payout`. The server validates every argument before running anything.
4. **Case summary** for the human reviewer and short follow-up messages.

The UI shows tool calls and results, not hidden reasoning. The triage list still works if the model is down; extraction just shows as pending.

## Payout rules

- **Auto-approve** when covered, amount ≤ a configured cap (e.g. $2,500 emergency advance), and confidence is high.
- **Human review** for anything over the cap (e.g. an $80k car), unclear coverage, excluded damage, or a suspicious pattern (repeat claim, new payout account).
- Every payout gets a unique id, and clicking twice never pays twice.

## Nessie (last)

One company checking account seeded with **$1,000,000**. Each approved payout is a Nessie transfer. If time allows, each policyholder gets their own Nessie account so the money visibly lands. Verify real write and read-back with a key before showing it.

## Dashboard

- **MVP:** the triage list (color, score, name, need, agent, time silent, claim status) plus a detail panel (messages, Nemotron tool activity, policy clauses, approve/deny).
- **Then:** a flat 2D map (Leaflet/Mapbox) with colored dots and the disaster zone. No 3D.
- **Disaster trigger:** a button or scripted trigger fires the event: pop-up "Tsunami warning — Half Moon Bay", the zone pulses, dots go gray, then update as replies arrive.
- Filter by agent location; an agent sees their own book first.

## Demo script (video)

1. Calm dashboard, everything green.
2. Trigger: pop-up, the zone pulses, affected dots go gray as texts go out.
3. **Phone on camera** receives the text; reply: "roof's gone, my mom needs insulin". The dot turns red and jumps to the top. The agent panel shows extraction → policy lookup → emergency advance approved → Nessie payout.
4. A silent person stays gray, the timer escalates, and **a real phone rings** with the Photon call.
5. A big claim ($80k car) lands in human review; the tsunami → flood exclusion is cited. The agent decides.
6. End card: people reached, escalated, paid, and total time.

Record the phone scenes early, so a flaky API near the deadline can't sink the video.

## Stack

**One Next.js app** (App Router, TypeScript, Tailwind, shadcn) at the repo root. API route handlers are the backend; no separate Python server. Shared TypeScript types run from database to UI.

- Nemotron: OpenAI-compatible API via the `openai` package with a custom base URL. Route handlers validate tool arguments (e.g. with zod).
- Policy RAG: embed the policy chunks once, store them with the data, cosine search in memory. No vector database.
- Database: SQLite (Drizzle or Prisma, to decide).
- Photon: check the SDK's language and webhook model first.
- Nessie: plain `fetch`.
- Run as a long-lived local server (`next start`), not serverless, so escalation timers survive. Compute silence from timestamps (`now - sent_at`) on a short interval so restarts don't lose state.
- Incoming replies need a public URL: ngrok or cloudflared tunnel, set as `PUBLIC_BASE_URL`.
- Secrets server-side only (no `NEXT_PUBLIC_`); commit `.env.example` only.

```text
src/app/              pages (dashboard) + api/ route handlers
src/lib/triage/       scoring + queue
src/lib/outreach/     Photon texts/calls + escalation timers
src/lib/agent/        Nemotron client, tools, RAG over policy docs
src/lib/claims/       coverage decision, approval rules, payout workflow
src/lib/finance/      Nessie adapter
src/lib/db/           SQLite schema + access
src/types/            shared types
data/                 generated agents, policyholders, policies, scripted replies
```

## Team (proposed, confirm)

| Person | Owns |
|---|---|
| Ron | API routes, shared types, database, data generation + loading, triage scoring, escalation engine, integration |
| Arav | Nemotron client, extraction, policy RAG, tool loop, case summaries |
| Samer | Photon (texts + calls), Nessie payouts, approval/idempotency |
| Pablo | Dashboard: triage list, detail panel, map, disaster trigger animation, video |

## Build order

1. Confirm the open questions. Prove a Photon SMS + call and a Nemotron tool call.
2. Generate the dataset and policy documents; agree on contracts.
3. Triage list end to end with scripted replies (no AI yet).
4. Nemotron extraction + policy RAG plugged into triage and claims.
5. Live Photon replies and the escalation call.
6. Approval workflow → Nessie payouts.
7. Map + disaster animation, then record the video.
