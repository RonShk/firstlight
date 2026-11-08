# No One Left Behind

**Team Members:**
- Ron Shaked
- Arav Sharma
- Samer Megla
- Pablo Nguyen

HackUTD ZeroDay — State Farm track. After a disaster, customers text us first. Nemotron first checks each text for danger (someone in danger right now: told to call 911, triage 4, flagged for a human), then triages each item 1-3 by severity, checks coverage against the policy documents, and approves provisional advance payments for spoiled food, hotel stays and rental cars under a cap, to be paid through Nessie. Large or unclear items go to a human adjuster. Design brief: [NO_ONE_LEFT_BEHIND.md](NO_ONE_LEFT_BEHIND.md).

One Next.js app: UI and backend (API routes) in one TypeScript codebase.

```text
src/app/              pages (dashboard) + api/ route handlers
src/lib/triage/       scoring + queue
src/lib/outreach/     inbound texts + replies (SMS provider to be chosen)
src/lib/agent/        Nemotron client, danger check, triage, policy RAG (see its README)
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

Run as a long-lived local server (not serverless). The app runs without SMS or Nessie settings; replies are logged to the console until an SMS provider is wired in.
