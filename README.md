# No One Left Behind

**Team Members:**
- Ron Shaked
- Arav Sharma
- Samer Megla
- Pablo Nguyen

HackUTD ZeroDay — State Farm track and NVIDIA Nemotron track. After a disaster, customers text us first. A Nemotron agent investigates each case with tools: it reads the customer's household and policies, searches their own policy forms with agentic RAG (hybrid BM25 + Nemotron embeddings, Nemotron reranker), checks exclusions, cites verbatim clauses, and has a second Nemotron agent verify the decision before a reply is sent. Present danger gets 911 guidance and urgent human review. Every step is persisted and shown on an audit timeline. Nothing pays, files or dispatches automatically. Design brief: [NO_ONE_LEFT_BEHIND.md](NO_ONE_LEFT_BEHIND.md). Architecture: [docs/agent-architecture.md](docs/agent-architecture.md).

One Next.js app: UI and backend (API routes) in one TypeScript codebase.

```text
src/app/              dashboard page + api/ route handlers (messages, runs, SSE events, cases, review)
src/agent/            agent runtime: tool loop, context, instructions, finalize checks, verifier, guard
src/tools/            tool registry + executor; customer, retrieval and claims tools
src/knowledge/        policy ingest, SQLite FTS5 + vectors, hybrid search, rerank, citations
src/cases/            cases, runs (queue + leases), append-only events, intake, read models
src/delivery/         outbox, simulator and SMS delivery
src/workers/          agent workers
src/evals/            evaluation scenarios, assertions and runner
src/lib/sim/          tornado simulator (personas, impact, triage view)
data/                 personas, agents, policy forms (raw PDFs in data/policies/raw)
```

## Run

```bash
cp .env.example .env.local   # NEMOTRON_* for Brev, NEMOTRON_EMBED_API_KEY for build.nvidia.com
npm install
npm run knowledge:ingest     # builds data/knowledge.db from data/policies/raw (reuses existing vectors)
npm run dev                  # starts the web app and in-process agent workers
npm test                     # offline tests; `npm run evals` runs live scenarios against Nemotron
npm run demo                 # demo mode: separate database, "Start the tornado" replays it live
```

Run as a long-lived server (not serverless). Workers run inside the web server by default; set `AGENT_WORKERS=external` and run `npm run agent:worker` (as many as you like) to scale them separately. Simulated replies are delivered to the simulated phone; SMS delivery needs Twilio settings.

The case workspace has separate Overview, Situation, Messages, Agent timeline, and Policies views. It restores
saved simulation cases after refresh, streams persisted agent events, and opens exact citation pages
in the PDF.js reader. Customer messages entered in the simulator use the normal message intake;
reviewer notes and corrections are saved to the case audit history.

The inbox includes households that never replied; their card is marked NO RESPONSE and their urgency is estimated from distance to the tornado path. Prominent pagination keeps all generated cases
accessible across urgency levels. Each card shows the agent run status. Household composition and
support needs live in Situation; customer messages and replies live only in Messages.

Incoming cases are queued together after saved history loads; opening a card only changes the view.
Batch intake persists work before workers start, and run polling is split into requests so large queues
remain observable. Overview leads with the next action and a short factual summary. Message history
scrolls independently of the pinned composer. Pagination stays at the bottom of the inbox.
