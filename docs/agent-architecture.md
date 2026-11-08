# Nightwatch agent architecture

One agent runtime, a registry of tools, and a persistent case history. Nemotron chooses what to do
next. The runtime handles execution, permissions, persistence and observability. A simulated text
and a real SMS enter through the same intake and run the same agent; only the delivery adapter differs.

## NVIDIA stack

| Role | Model | Where |
|---|---|---|
| Planner and tool caller (ReAct loop) | Nemotron 3.5 Lightning 30B-A3B | Brev, vLLM, OpenAI-compatible tool calling |
| Verifier agent (writer then editor) | same Nemotron, separate role and prompt | Brev |
| Dense retrieval | `nvidia/nemotron-3.5-embed-1b` (query and passage encoders) | build.nvidia.com |
| Reranking | `nvidia/llama-nemotron-rerank-vl-1b-v2` cross-encoder | build.nvidia.com |
| Content safety | `nvidia/llama-3.1-nemotron-safety-guard-8b-v3` | build.nvidia.com |

Every hosted service is optional and degrades gracefully. The degradation is recorded on the
timeline, for example "dense retrieval unavailable", rather than failing the run.

## Request path

```text
POST /api/messages ──► cases/intake: store messages, enqueue run (202 + runId)
                                   │
workers/agent-worker  ◄────────────┘  lease one run per case, heartbeat, checkpoint each step
   │
   ├─ guard: screen inbound text (Nemotron Safety Guard)
   ├─ agent/runner: Nemotron ⇄ tools until finish_review
   │     update_plan · get_customer_profile · get_policies
   │     search_policy (BM25 + dense → RRF → rerank) · read_section · get_endorsements
   │     calculate_estimate · prepare_claim (draft) · request_human_review
   ├─ agent/finalize: verbatim-citation and promise checks → issues go back to the model
   ├─ agent/verifier: second Nemotron agent audits decision vs cited passages → may send it back
   ├─ guard: screen outbound reply; unsafe replies are held for a human
   └─ complete run + case update + outbox row, in one transaction
delivery/outbox ──► simulator | SMS (Twilio)   ("generated" and "sent" are separate states)
GET /api/runs/:id/events  (SSE)  ──► UI timeline
```

## Agentic RAG

Retrieval is a tool the model calls when it decides it needs policy text. It can call it again with
better wording, narrow to one policy, and read surrounding sections. A no-loss check-in does no
retrieval at all. Search is always restricted to the documents behind the verified customer's own
policies.

1. **Ingest** (`npm run knowledge:ingest`). PDFs become section-aware chunks with page numbers. They
   are stored in SQLite (`data/knowledge.db`) with an FTS5 index and Nemotron embedding vectors.
   Unchanged passages reuse their vectors.
2. **Search**. BM25 and dense cosine each nominate 40 candidates. Reciprocal-rank fusion merges them,
   and the Nemotron reranker orders the top 20.
3. **Ground**. A coverage conclusion must cite `chunk_id` plus a verbatim quote from a passage
   retrieved in this run. Code verifies every quote. Citations resolve to the policy PDF at the
   cited page.

## What is persisted

| Record | Purpose |
|---|---|
| Case | Conversation, latest severity, summary, findings, unknowns, status |
| Run | One attempt to process new information: model and prompt version, checkpoint, usage, outcome |
| Event | One observable step, with case, run, per-case sequence number, timestamp, tool call id and duration |
| Artifact | Large tool outputs, referenced from events instead of duplicated |
| Outbox | Replies persisted before sending; delivery tracked separately |
| Claim draft / review request | The only write effects. They are idempotent, and nothing pays, files or dispatches |

The UI shows "reasoning" as evidence-backed explanations. Those are each tool call's stated purpose,
the agent's short notes, the retrieved clauses, and the verifier's verdict. Nemotron's private
reasoning tokens are dropped and never presented as a transcript.

## Scaling and safety properties

- HTTP only accepts messages and reads state. Workers run agent loops: in-process by default, or as
  separate processes with `AGENT_WORKERS=external` and `npm run agent:worker`.
- There is one active run per case, while different cases run concurrently. A newer customer message
  supersedes the in-flight run, the worker loses its lease and stops, and an already-prepared reply is
  cancelled rather than sent.
- Leases expire, so a crashed worker's run resumes from its last checkpoint. Write tools are
  idempotent, so a resumed run never duplicates a claim draft or review request.
- Each run is bounded by turns, tool calls, tokens and wall time. At the limit, the model is forced
  to conclude, and unverifiable findings are downgraded to "unclear".
- Identity comes from the case record (`TrustedRunContext`). The model cannot switch customers or
  read another customer's policy.
- If a run fails, the customer still gets a safe reply that includes 911 guidance, and a human review
  is queued.
- Long investigations stay within context. Once the prompt grows large, older tool outputs are
  replaced by a list of the passages they contained. Evidence stays in the run, so citations still
  verify, and the model can re-read any passage.
- Malformed decisions are retried with `finish_review` pinned, so vLLM's guided decoding enforces the
  JSON schema. When the model sends a complete decision and a fragment in one turn, the complete one
  is reviewed.

## Evaluation

```bash
npm test                         # offline: scripted model, in-memory DBs (no keys)
npm run evals                    # live: hand-written scenarios (danger, injection, no-policy, grounding)
npm run evals -- --suite sim --sim 20   # live: tornado households vs the simulator's hidden truth
npm run agent:run -- --persona PH-0002 "roof torn off, is it covered?"   # one case, full timeline
```

Reports are written to `.cache/evals/`. Every run is also checked for invariants: it completed,
every citation was verified, and the reply promises nothing that did not happen.

## Code map

```text
src/agent/       runner (loop), context, instructions, schemas, model adapter, finalize, verifier, guard
src/tools/       registry, executor, customer/, retrieval/, claims/, agent/update-plan
src/knowledge/   documents (chunking), ingest, store (SQLite + FTS5 + vectors), embeddings, rerank, search, citations
src/cases/       db schema, repository (cases/messages), runs (queue/leases), events (audit log), intake, views
src/delivery/    outbox, simulator, sms
src/workers/     agent-worker (leasing, heartbeats, completion, delivery sweep)
src/evals/       scenarios, assertions, runner
src/app/api/     messages, runs, runs/[id], runs/[id]/events (SSE), cases/[id], cases/[id]/review, artifacts/[id], status, policies
```
