# No One Left Behind

**Team Members:**
- Ron Shaked
- Arav Sharma
- Samer Megla
- Pablo Nguyen

HackUTD ZeroDay — State Farm track. After a disaster, reach every policyholder in the affected area, triage by urgency (silence escalates), check coverage against their actual policy with Nemotron, and pay approved claims through Nessie. Design brief: [NO_ONE_LEFT_BEHIND.md](NO_ONE_LEFT_BEHIND.md).

One Next.js app: UI and backend (API routes) in one TypeScript codebase.

```text
src/app/              pages (dashboard) + api/ route handlers
src/lib/triage/       scoring + queue
src/lib/outreach/     Photon texts/calls + escalation
src/lib/agent/        Nemotron client, tools, policy RAG
src/lib/claims/       coverage decision, approval rules, payout workflow
src/lib/finance/      Nessie adapter
src/lib/db/           SQLite schema + access
src/types/            shared types
data/                 generated agents, policyholders, policies, scripted replies
```

## Run

```bash
cp .env.example .env.local   # fill in keys
npm install
npm run dev
```

Run as a long-lived local server (not serverless) so escalation timers keep working. Incoming Photon replies need a public URL: tunnel with ngrok or cloudflared and set `PUBLIC_BASE_URL`.
