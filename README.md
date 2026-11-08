# No One Left Behind

**Team Members:**
- Ron Shaked
- Arav Sharma
- Samer Megla
- Pablo Nguyen

HackUTD ZeroDay — State Farm track. After a tornado, State Farm texts every policyholder in its path. A Nemotron agent reads each reply, checks that person's actual policy, scores severity, drafts the claim and decides whether to pay now or hand it to a person. Silence moves people up the list. Design brief: [NO_ONE_LEFT_BEHIND.md](NO_ONE_LEFT_BEHIND.md).

One Next.js app: UI and backend (API routes) in one TypeScript codebase.

```text
src/lib/sim/          simulated world: 400 households, tornado, hidden truth, persona texts, triage
src/lib/agent/        the product: Nemotron tool loop, policy search, money + routing rules
src/app/api/agent/    agent endpoint
src/components/sim/   dashboard
data/                 personas, agents, policy forms (text) for the agent's search
```

## Run

```bash
cp .env.example .env.local   # set NEMOTRON_MODEL + NEMOTRON_API_KEY
npm install
npm run dev
```

Without a Nemotron endpoint the list still loads, and replies show as "Unread by agent".
