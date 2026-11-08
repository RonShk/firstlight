# No One Left Behind — project brief

HackUTD ZeroDay. Target tracks: **State Farm** (main), **NVIDIA Nemotron**, **Capital One Nessie** (last priority).
Deadline: Sun 2026-11-08, noon America/Chicago. Submission is believed to be a **video** (Pablo confirming).

## Pitch

After a tornado, State Farm texts **every policyholder in its path**. A Nemotron agent reads each reply, checks that person's actual policy, scores severity, drafts the claim, and decides whether it can be paid on the spot or needs a person. People who **don't reply** climb the list, because silence is the warning sign.

What sets us apart:
1. **The agent does the real work.** Severity, coverage and routing come from Nemotron reading the message and the policy, never from the simulator.
2. **Coverage is grounded in the policy text**, with the clause quoted, and fake citations are rejected.
3. **The model decides meaning, code decides money.** Dollar amounts come from the policy limits and deductibles, computed by code.
4. **We can prove it works.** The simulator knows the hidden truth for every household, so the dashboard scores the agent live.
5. **Silence escalates**: follow-up text at 30 min, welfare call by the local agent at 60 min.

## The wall: simulated world vs. the product

```text
 SIMULATED WORLD (knows the truth)              │  THE PRODUCT (sees only what State Farm would)
                                                │
 400 households, policies, agents               │  policyholder file + policy forms (data/policies)
 tornado path → each home's true damage,        │
 injuries, medical needs, who never replies     │
        │                                       │
 persona writes texts (messy on purpose) ───────┼─► fake phone ─► /api/agent ─► Nemotron tool loop
                                                │                  1. search_policy (their forms only)
                                                │                  2. submit_assessment (severity, safety,
                                                │                     claim items, coverage + citation, reply)
                                                │                  3. code: money, deductibles, routing
                                                │                         │
                                                │                         ▼
                                                │                 triage queue, claim draft, reply on phone
 truth, never sent to the agent ────────────────┼─► "Agent vs simulator truth" score
```

- Simulated (free, no AI, precomputed): people, tornado impact, damage truth, persona texts, who stays silent. The app opens about 3 hours after touchdown, with every reply already in.
- Real (the product): reading messages, policy search, severity, coverage, claim draft, routing, the reply.
- **Live demo:** open anyone's phone and type a message as them (or let a judge). Nemotron assesses it live. Live conversations aren't scored.

## Open questions

- [ ] The actual State Farm prompt and judging criteria. Shape the product around their wording.
- [ ] The track limit ("Enter up to two"?). If it's two, Nessie is the first thing cut.
- [ ] Nemotron access: hosted API at build.nvidia.com, or self-host on Brev (about $60 of credit). Pick a model that supports tool calling.
- [ ] What gets submitted (video length, format, due time).

## Agent contract

`POST /api/agent` with `{ personaId, conversation: [{ from: "policyholder" | "state_farm", text }] }`. The server looks up the policyholder file itself; the client can't inject anything else. Results are cached on disk in `.cache/agent/`, keyed by model + conversation, so re-running the demo is free.

The model must call `submit_assessment` with:

| Field | Meaning |
|---|---|
| `safety` | injury, medical emergency, displaced, trapped or missing |
| `severity` 0–100 | 90+ life safety · 70–89 displaced / vulnerable at risk · 40–69 major damage · 15–39 minor · 0–14 safe |
| `confidence` 0–1 | below 0.6 always goes to a person |
| `claims[]` | line, coverage part, item, extent (minor → total), coverage (covered / excluded / unclear / no_policy), citation |
| `reply_text`, `follow_up_question` | words to the policyholder; never dollar amounts |

Code then (`src/lib/agent/decide.ts`):
- verifies every citation quote actually came from a `search_policy` result, else drops it
- estimates each covered item from the real limit × extent, applies the wind/hail and comprehensive deductibles
- routes: life safety, severity ≥ 70, contested coverage, low confidence or over $5,000 → **human review**; otherwise **auto-approve**
- sends displaced households a $1,500 hotel advance while a person reviews the rest
- appends the claim number, approved amount or agent callback to the reply

## Run

```bash
cp .env.example .env.local     # set NEMOTRON_MODEL and NEMOTRON_API_KEY
npm install
npm run policies               # download policy forms → data/policies/*.txt (already committed)
npm run personas               # export the simulated population → data/personas.json
npm run dev
```

## Layout

```text
src/lib/sim/        simulated data: personas, tornado impact, hidden truth + texts, triage, agent queue
src/lib/agent/      the product: Nemotron tool loop, policy search, policyholder record, money + routing
src/app/api/agent/  agent endpoint (GET status, POST assess)
src/components/sim/ policyholder list, phone, assessment panel
data/               personas.json, agents.json, policy_forms.json, policies/*.txt
```

## Team (proposed, confirm)

| Person | Owns |
|---|---|
| Ron | Simulator, hidden truth + persona texts, triage, scoring, integration |
| Arav | Nemotron prompts and tools, better policy retrieval (embeddings), agent quality vs the truth score |
| Samer | Nessie payouts behind the Approve button, idempotency |
| Pablo | Dashboard polish, demo script, video |

## Next

1. Get a Nemotron endpoint working; run a full tornado and read the accuracy score.
2. Tune prompts until critical misses are 0 and routing accuracy is high.
3. Better retrieval (NVIDIA embeddings) if keyword search misses clauses.
4. Nessie payouts on Approve.
5. Record the video: tornado → replies → agent reads → live-typed message → payout.
