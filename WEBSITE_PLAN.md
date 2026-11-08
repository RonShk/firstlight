# Website plan — No One Left Behind

For Samer (design) and anyone wiring data in. This describes **what goes on the website and why**, not how to style it.

## The story the site has to tell

A tornado already hit Moore, OK. State Farm texted every policyholder in its path. The site shows what happened next: **a team of Nemotron agents read every reply, checked each person's actual policy, decided who needs help first, and texted them back**, with a person stepping in for anything serious.

Everything on screen should support one of three points:
1. **Nobody gets missed.** Every household is accounted for, including people who never replied.
2. **The agents do real work.** You can see each step: what they read, what they looked up in the policy, what they decided.
3. **It's measurably right.** We score the agents against the simulator's hidden truth.

The data is a **fixed snapshot**: no clock, no animation of time passing. The only thing that changes on screen is agent results filling in when they load.

## Tracks and what they're judging

| Track | What they want to see | Where it shows on the site |
|---|---|---|
| **State Farm** | Real-world catastrophe response, nobody left behind | The households table, silent-household escalations, human review queue |
| **NVIDIA Nemotron** | Beyond a chatbot: multi-step workflows, tool calling, agentic RAG, simulation and eval | Agent trace view, policy citations, scorecard page |
| **Capital One Nessie** (if allowed) | Real payments | "Approve payout" → Nessie transfer, shown on the case page |

---

## Pages

Three pages plus one detail view. Simple top nav.

```text
[ Households ]  [ Review queue ]  [ Agent scorecard ]
```

### 1. Households (home page)

**Purpose:** the full picture in one table. This is what's on the site now; keep it and polish it.

**Header:** incident name (EF4 Tornado — Moore, OK, touched down 7:42 PM), plus one summary line:
> 66 households in the path · 49 replied · 17 silent · 24 critical · 31 replies answered automatically · 18 sent to a person

**Table, one row per household, sorted by urgency (most urgent first):**

| Column | Content |
|---|---|
| Time | When their last message arrived (or when silence was escalated) |
| Policyholder | Name, household type, number of people, city. Vulnerability flags in amber (age 80+, home oxygen, newborn…) |
| Message | Exactly what they texted, in quotes. Silent people: "No reply to 2 check-ins" |
| Assessment | Severity 0–100 (colored), decision badge (Auto-approved / Agent review / No claim), one-line summary, estimated $ |
| Reply sent | The text the agent sent back |

**Row states the design needs to cover:**
- **Assessed:** severity, decision, reply all present
- **Agent working:** the agent hasn't finished yet ("Reading…")
- **Silent:** no message, escalated to the local agent for a welfare call
- **Agent offline / error:** message is there, no assessment

**Severity colors:** red 70+ (critical), amber 30–69 (needs help), green below 30 (safe), purple (silent).

**Click any row → Case view.**

Nice to have: filter chips (Critical / Silent / Needs help / Safe) and a search box.

### 2. Case view (detail for one household)

**Purpose:** show the agents' work for one person. This is the NVIDIA money shot. Can be a full page or a large side panel.

**Sections, top to bottom:**

1. **Who they are:** name, address, phone, household members with ages, vulnerabilities, their State Farm agent, policies (form numbers, coverage limits, deductibles, vehicles).

2. **Conversation:** the text thread as chat bubbles: State Farm check-in → their message(s) → the reply. A phone-style frame is optional.

3. **Agent trace:** the step-by-step timeline. **This is the most important design piece on the site.** Each step is one row:

   ```text
   🧭 Intake agent        Read 2 messages → injury reported (Walter, possible broken leg), roof damage, family of 4 displaced
   🔎 Coverage agent      search_policy("windstorm damage dwelling")  → HW-2136 · Section I – Losses Insured
   🔎 Coverage agent      check_exclusions("water damage after roof loss") → no exclusion applies
   📊 Coverage agent      get_coverage_limits(home) → Dwelling $312,000 · Loss of use $62,000 · Wind/hail deductible $3,120
   🛰 Triage agent        verify_storm_report(address) → inside the damage core
   ⚖️ Triage agent        Severity 93 · confidence 0.85 · life-safety → human required
   ✉️ Communicator       Drafted reply (tells them to call 911, hotel advance on the way)
   🧮 Guardrails (code)   Estimate $148,050 · deductible applied · citation verified · routed to agent review
   ```

   Show for each step: which agent, which tool, a short "what it saw" result, and timing. Steps should be expandable to show the raw policy text the agent retrieved.

4. **Claim draft:** each loss as a line item:
   - item (e.g. "Roof and bedrooms"), extent (minor → total)
   - coverage call: Covered / Excluded / Unclear / No policy
   - **quoted policy clause** with form number (e.g. *HW-2136: "We will pay for accidental direct physical loss…"*)
   - estimated amount and how it was computed ("45% of Coverage A")

   Then: deductibles, estimated total, payable now (e.g. $1,500 hotel advance), and the routing reason in plain English.

5. **Actions (human-in-the-loop):** **Approve payout**, **Assign to adjuster**, **Edit reply**. Approve calls Nessie if we get that track. Show the payment record (amount, transaction ID, status) after it goes through.

6. **"Compare with simulator truth"** (collapsed by default): a small table of what really happened vs. what the agent concluded (severity, injury, medical emergency, displaced, route), with ✓/✗. Explain in one line that the agent never sees this.

### 3. Review queue

**Purpose:** the human side. Everything the agents decided a person must handle, sorted by urgency.

- Same rows as the households table, filtered to **Agent review** + **Silent**
- Each card shows *why* it's here: "Life-safety issue reported", "Above the $5,000 auto-approve cap", "Coverage unclear", "Low confidence (40%)", "No reply in an hour"
- Quick actions inline: Approve / Assign / Call
- Counter in the nav badge, e.g. **Review queue (18)**

This makes the State Farm story concrete: AI handles the easy cases instantly, people focus on the dangerous ones.

### 4. Agent scorecard

**Purpose:** prove the agents work. This hits NVIDIA's "Agent Simulation & Eval" category directly.

**Top numbers (big):**
- Emergencies missed: **0 / 9** (the one that matters most)
- Routing accuracy: **88%**
- Severity within ±10 of truth: **76%**
- Citations verified: **94%**

**Below:**
- A confusion grid: true route (auto-approve / agent review / no claim) vs. what the agent chose
- A scatter or bar chart: true severity vs. agent severity
- **"Hardest cases"**: a list of the biggest misses, each linking to its case view. Show the message and what went wrong ("missed buried oxygen emergency", "called a renter covered")
- **Test set breakdown:** generated scenarios (49) + hand-written hard cases (~15: buried emergencies, renters with no policy, flood vs. wind, vague messages, inflated claims)
- Model and setup used: `Nemotron Nano 9B v2 on Brev`, number of runs, average time per case

The numbers above are placeholders until real runs exist.

---

## Global elements

- **Top bar:** logo + "No One Left Behind", incident pill (EF4 Tornado — Moore, OK), agent status pill (`Nemotron · <model> on Brev` / offline).
- **Theme:** dark, calm, serious. It's an emergency tool, not a game. Red is reserved for critical, never decoration.
- **Copy rules:** plain words. "Agent review", not "HITL escalation". Severity always shows /100. Money always has a "how we got this number" line.

## What not to put on the site

- No map, no tornado animation, no clock. (Removed on purpose.)
- No chatbot box. Judges must not read this as "a chatbot". If we show live input at all, it's "send a message as this policyholder" inside the case view.
- No fake numbers. If the agent hasn't run, show the empty or offline state, not sample data. Sample data is fine in Figma, never in the demo build.

## Data the pages read

Already in the code (`src/lib/sim/triage.ts`, `src/lib/agent/types.ts`):
- **Household:** `persona` (name, members, address, policies, vulnerabilities, agent)
- **Messages:** `thread` (from: system / persona / agent, text, time)
- **Assessment:** `result.assessment`: severity, confidence, summary, safety flags, needs, claims with coverage + citation
- **Decision:** `result.decision`: route, routeReason, line items with estimates, deductibles, total, payableNow, claimNumber
- **Trace:** `result.steps`: kind (model/tool), name, detail, ms. *Will gain an `agent` field (intake / coverage / triage / communicator / guardrails) when we split into specialist agents.*
- **Truth (scorecard and compare only):** `truth`: damage, injured, medicalUrgent, displaced, severity, expectedRoute

## Demo flow (video, about 2 minutes)

1. **Households page.** "A tornado just hit Moore. 66 households were in the path. Here's every one of them."
2. **Point at a silent senior** at the top: "Silence moves people up. She never replied, so her agent is already calling."
3. **Open a critical case.** Read the message (buried emergency). **Walk the agent trace**: intake → policy search → exclusion check → storm verification → severity → reply. Show the quoted clause.
4. **Approve the hotel advance**, and the Nessie payment appears (if in scope).
5. **Review queue:** "The agents handled 31 replies instantly. People only see these 18."
6. **Scorecard:** "We simulate the disaster with a hidden answer key and grade the agents. Zero emergencies missed." End.

## Build order

1. Households table polish + case view (conversation, claim draft, trace)
2. Review queue
3. Scorecard page (after the eval script exists)
4. Approve → Nessie
