// Offline tests for the agent runtime: scripted model, in-memory databases, fixture policy text.
// No network, no keys. Run: npm test
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeRun, type AgentDeps } from "@/agent/runner";
import { FALLBACK_REPLY, validateDecision } from "@/agent/finalize";
import type { AgentModel, AssistantTurn, Message } from "@/agent/model";
import type { Decision } from "@/agent/schemas";
import { openOps } from "@/cases/db";
import { caseEvents } from "@/cases/events";
import { receive } from "@/cases/intake";
import { appendMessage, messages } from "@/cases/repository";
import { claimRun, completeRun, enqueueRun, getRun, LeaseLostError, owns } from "@/cases/runs";
import type { PolicyholderFile } from "@/customers/directory";
import { deliverPending, queueReply } from "@/delivery/outbox";
import { simulatorDelivery } from "@/delivery/simulator";
import { quoteAppears } from "@/knowledge/citations";
import { ingestDocuments } from "@/knowledge/ingest";
import { hybridSearch } from "@/knowledge/search";
import { executeTool } from "@/tools/executor";
import { toolRegistry } from "@/tools/registry";
import type { TrustedRunContext } from "@/tools/types";
import { processRun } from "@/workers/agent-worker";

const PAGES = [
  `SECTION I – LOSSES INSURED
COVERAGE A – DWELLING
We will pay for accidental direct physical loss to the property described in Coverage A, unless the loss is excluded or limited in SECTION I – LOSSES NOT INSURED or otherwise excluded or limited in this policy.
Windstorm or hail damage to the roof of the dwelling is a direct physical loss for the purposes of this coverage part.`,
  `SECTION I – PROPERTY COVERAGES
COVERAGE C – LOSS OF USE
Additional Living Expense. When a loss insured causes the residence premises to become wholly or partially uninhabitable, we will pay the reasonable and necessary increase in cost incurred by an insured to maintain their normal standard of living.`,
  `SECTION I – LOSSES NOT INSURED
We will not pay for any loss to the property described in Coverage A that consists of wear, tear, marring, scratching, deterioration, inherent vice, latent defect or mechanical breakdown.`,
];

async function knowledgeFixture() {
  return ingestDocuments([{ doc_id: "SF-HOME-OK", line: "home", title: "Homeowners Policy", form_number: "HW-2136", source_type: "Oklahoma Insurance Dept",
    pages: PAGES, defaultSection: "General" }], { file: ":memory:", embedder: null, log: () => {} });
}

const CUSTOMER: PolicyholderFile = {
  policyholder_id: "PH-TEST", name: "Dana Reyes", phone: "4055550100", address: "1 Elm St, Moore, OK 73160", housing: "owns home",
  household: "Couple", members: [{ name: "Dana Reyes", age: 41, relation: "self" }], vulnerability_flags: [], local_agent: null,
  policies: [{ policy_id: "HO-1", line: "home", doc_id: "SF-HOME-OK", form: "Homeowners Policy", form_number: "HW-2136",
    home: { coverage_a_dwelling: 300_000, coverage_b_personal_property: 150_000, coverage_c_loss_of_use: 60_000, deductible_all_other_perils: 1_000, deductible_wind_hail: 3_000 } }],
};

/** A model that plays back turns; each step can inspect the conversation so far. */
function scripted(steps: ((messages: Message[]) => Partial<AssistantTurn>)[]): AgentModel & { calls: number } {
  const model = {
    name: "scripted", calls: 0,
    async turn(messages: Message[]) {
      const step = steps[model.calls++];
      if (!step) throw new Error("script exhausted");
      return { content: null, toolCalls: [], usage: { promptTokens: 10, completionTokens: 5 }, finishReason: "tool_calls", ...step(messages) };
    },
  };
  return model;
}

let callId = 0;
const call = (name: string, args: object) => ({ id: `call_${++callId}`, name, arguments: JSON.stringify(args) });

/** chunk_id of the first search result returned to the model so far. */
function firstHit(messages: Message[]): { chunk_id: string; text: string } {
  for (const m of messages) {
    if (m.role !== "tool") continue;
    const body = JSON.parse(String(m.content));
    if (body.results?.length) return body.results[0];
  }
  throw new Error("no search result in conversation");
}

const decision = (over: Partial<Decision> = {}): Decision => ({
  severity: 60, severity_reason: "Roof damage with water coming in", immediate_danger: false, summary: "Tornado damaged the roof.",
  reported_facts: ["Roof damaged"], unknowns: ["Repair cost"], findings: [], next_action: "reply", decision_reason: "Grounded answer",
  reply: "Hi Dana, your homeowners policy may cover wind damage to your roof once an adjuster confirms it. Can you send photos of the damage?", ...over,
});

async function setup(models: { model: AgentModel; verifier?: AgentModel | null }) {
  const db = openOps(":memory:");
  const knowledge = await knowledgeFixture();
  const deps: AgentDeps = { db, model: models.model, verifier: models.verifier ?? null, guard: null, knowledge, embedder: null, reranker: null,
    limits: { maxTurns: 8, maxToolCalls: 12, maxRevisions: 2, runTimeoutMs: 60_000, maxTokens: 100_000 }, customerOf: (id) => (id ? CUSTOMER : null) };
  const intake = receive(db, { channel: "simulation", address: "sim:PH-TEST", customerId: "PH-TEST",
    turns: [{ role: "company", text: "Are you safe?" }, { role: "customer", text: "Tornado tore shingles off the roof, rain coming in. Covered?" }] });
  return { db, deps, knowledge, intake };
}

const approve = () => scripted([() => ({ toolCalls: [call("submit_verdict", { verdict: "approve", issues: [], severity_check: "reasonable" })] })]);

describe("knowledge", () => {
  it("BM25 search over FTS5 finds the dwelling clause, scoped to allowed documents", async () => {
    const store = await knowledgeFixture();
    const r = await hybridSearch(store, "Coverage A dwelling windstorm roof", ["SF-HOME-OK"]);
    assert.deepEqual(r.methods, ["bm25"]);
    assert.ok(r.degraded.some((d) => d.includes("no embeddings")));
    assert.match(r.hits[0].chunk.section, /COVERAGE A/);
    assert.equal((await hybridSearch(store, "dwelling", ["OTHER-DOC"])).hits.length, 0);
  });

  it("customer text cannot inject FTS query syntax", async () => {
    const store = await knowledgeFixture();
    await assert.doesNotReject(hybridSearch(store, `roof" OR chunk_id:* NEAR( "dwelling`, ["SF-HOME-OK"]));
  });

  it("quotes must be verbatim, tolerant only of whitespace, quote marks and hyphenation", () => {
    const text = "We will pay for accidental direct physical loss to the prop- erty described in Coverage A";
    assert.ok(quoteAppears(text, "we will pay for  accidental direct physical loss to the property"));
    assert.ok(quoteAppears(text, "We will pay for accidental ... described in Coverage A"));
    assert.ok(!quoteAppears(text, "We will pay for all damage to the property described in Coverage A"));
    assert.ok(!quoteAppears(text, "We will pay"), "too short to count");
  });
});

describe("finalize checks", () => {
  const evidence = new Map([["SF-HOME-OK#0", { chunk_id: "SF-HOME-OK#0", doc_id: "SF-HOME-OK", policy_id: "HO-1", form_number: "HW-2136",
    source_type: "Oklahoma Insurance Dept", section: "COVERAGE A", page: 1, text: PAGES[0] }]]);
  const covered = { item: "Roof", coverage: "Coverage A Dwelling", policy_id: "HO-1", status: "likely_covered" as const, explanation: "Wind is insured." };

  it("rejects uncited and misquoted coverage conclusions", () => {
    assert.match(validateDecision(decision({ findings: [{ ...covered, citations: [] }] }), evidence, CUSTOMER).issues.join(), /without a citation/);
    const fake = [{ chunk_id: "SF-HOME-OK#0", quote: "We will pay for every kind of roof damage no matter what" }];
    assert.match(validateDecision(decision({ findings: [{ ...covered, citations: fake }] }), evidence, CUSTOMER).issues.join(), /exact words are not in/);
    const otherDoc = [{ chunk_id: "SF-AUTO-TX#3", quote: "We will pay for accidental direct physical loss" }];
    assert.match(validateDecision(decision({ findings: [{ ...covered, citations: otherDoc }] }), evidence, CUSTOMER).issues.join(), /not retrieved/);
    // Right words, wrong passage number in the same document: re-pointed to the passage that has them.
    const wrongId = [{ chunk_id: "SF-HOME-OK#9", quote: "We will pay for accidental direct physical loss" }];
    const repointed = validateDecision(decision({ findings: [{ ...covered, citations: wrongId }] }), evidence, CUSTOMER);
    assert.deepEqual(repointed.issues, []);
    assert.equal(repointed.citations[0].chunk_id, "SF-HOME-OK#0");
  });

  it("accepts a verbatim citation and resolves it to a page link", () => {
    const ok = [{ chunk_id: "SF-HOME-OK#0", quote: "We will pay for accidental direct physical loss to the property described in Coverage A" }];
    const v = validateDecision(decision({ findings: [{ ...covered, citations: ok }] }), evidence, CUSTOMER);
    assert.deepEqual(v.issues, []);
    assert.equal(v.citations[0].url, "/api/policies?form=SF-HOME-OK#page=1");
  });

  it("rejects replies that invent actions or skip danger guidance", () => {
    const issues = (reply: string, over: Partial<Decision> = {}) => validateDecision(decision({ reply, ...over }), evidence, CUSTOMER, { completedTools: new Set() }).issues.join(" ");
    assert.match(issues("We have sent $2,000 to your account."), /money was sent/);
    assert.match(issues("Your claim has been approved."), /filed or approved/);
    assert.match(issues("Your policy covers the roof."), /certain/);
    assert.match(issues("A claims specialist will contact you tomorrow."), /nothing in this run queued/);
    assert.match(issues("**Home:** may be covered"), /markdown/);
    assert.match(issues("Stay safe.", { immediate_danger: true, next_action: "human_review" }), /911/);
    assert.equal(issues("A claims specialist will contact you.", { next_action: "human_review" }), "");
  });
});

describe("tools", () => {
  it("validates input, scopes documents to the customer, and makes writes idempotent", async () => {
    const { db, knowledge, intake } = await setup({ model: scripted([]) });
    const run = intake.run!;
    const ctx: TrustedRunContext = { caseId: run.caseId, runId: run.id, db, customer: CUSTOMER, knowledge, embedder: null, reranker: null,
      evidence: new Map(), findings: new Map(), signal: new AbortController().signal };
    const registry = toolRegistry();

    const bad = await executeTool(registry, call("search_policy", { query: "roof" }), ctx, { allowWrites: true });
    assert.equal(bad.ok, false);
    assert.match(bad.content, /purpose/);

    const foreign = await executeTool(registry, call("search_policy", { purpose: "Check roof", query: "roof", policy_id: "HO-999" }), ctx, { allowWrites: true });
    assert.match(foreign.content, /not one of this customer's policies/);

    const hit = await executeTool(registry, call("search_policy", { purpose: "Find dwelling coverage", query: "dwelling windstorm roof" }), ctx, { allowWrites: true });
    assert.ok(hit.ok);
    assert.ok(ctx.evidence.size > 0, "search results are recorded as evidence");

    const review = { purpose: "Roof is open to rain", priority: "high", reason: "Water entering the home" };
    const first = await executeTool(registry, call("request_human_review", review), ctx, { allowWrites: true });
    const again = await executeTool(registry, call("request_human_review", review), ctx, { allowWrites: true });
    assert.equal(JSON.parse(first.content).review_request_id, JSON.parse(again.content).review_request_id);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_requests")!.n, 1);

    const blocked = await executeTool(registry, call("request_human_review", review), ctx, { allowWrites: false });
    assert.match(blocked.content, /forbidden/);

    const types = caseEvents(db, run.caseId).map((e) => e.type);
    assert.ok(types.includes("tool.rejected") && types.includes("tool.requested") && types.includes("tool.completed"));
  });

  it("does the money arithmetic in code, with the wind/hail deductible for tornado damage", async () => {
    const { db, knowledge, intake } = await setup({ model: scripted([]) });
    const ctx: TrustedRunContext = { caseId: intake.case.id, runId: intake.run!.id, db, customer: CUSTOMER, knowledge, embedder: null, reranker: null,
      evidence: new Map(), findings: new Map(), signal: new AbortController().signal };
    const out = await executeTool(toolRegistry(), call("calculate_estimate", { purpose: "Illustrate", policy_id: "HO-1", coverage: "dwelling", peril: "tornado wind", estimated_loss_usd: 12_000 }), ctx, { allowWrites: true });
    const r = JSON.parse(out.content);
    assert.equal(r.deductible_usd, 3_000);
    assert.equal(r.illustrative_payable_usd, 9_000);
  });
});

describe("runner", () => {
  it("runs the tool loop to a grounded, verified decision and delivers the reply", async () => {
    const model = scripted([
      () => ({ content: "Checking roof coverage.", toolCalls: [call("update_plan", { purpose: "Plan", steps: ["Read policies", "Search dwelling wind coverage", "Reply"] })] }),
      () => ({ toolCalls: [call("get_policies", { purpose: "Find the home policy" })] }),
      () => ({ toolCalls: [call("search_policy", { purpose: "Dwelling wind coverage", query: "Coverage A dwelling windstorm roof", policy_id: "HO-1" })] }),
      (m) => {
        const hit = firstHit(m);
        return { toolCalls: [call("finish_review", decision({ findings: [{ item: "Roof", coverage: "Coverage A Dwelling", policy_id: "HO-1", status: "likely_covered",
          explanation: "Wind damage to the dwelling is an insured loss unless excluded.", citations: [{ chunk_id: hit.chunk_id, quote: "We will pay for accidental direct physical loss to the property described in Coverage A" }] }] }))] };
      },
    ]);
    const { db, deps, intake } = await setup({ model, verifier: approve() });
    const run = claimRun(db, "w1")!;
    assert.equal(await processRun(run, "w1", deps), true);
    await deliverPending(db, { simulation: simulatorDelivery });

    const done = getRun(db, run.id)!;
    assert.equal(done.status, "completed");
    const stored = done.decision as { verified: boolean; citations: { page: number }[] };
    assert.equal(stored.verified, true);
    assert.equal(stored.citations[0].page, 1);
    assert.equal(messages(db, intake.case.id).at(-1)!.role, "agent");
    const types = caseEvents(db, intake.case.id).map((e) => e.type);
    for (const t of ["run.started", "context.built", "agent.note", "tool.requested", "decision.proposed", "verifier.reviewed", "decision.accepted", "reply.prepared", "delivery.sent"]) {
      assert.ok(types.includes(t), `missing ${t}`);
    }
    assert.ok(types.indexOf("reply.prepared") < types.indexOf("delivery.sent"), "persisted before sent");
  });

  it("returns grounding issues to the model and accepts the corrected decision", async () => {
    const model = scripted([
      () => ({ toolCalls: [call("search_policy", { purpose: "Dwelling coverage", query: "dwelling windstorm roof" })] }),
      (m) => ({ toolCalls: [call("finish_review", decision({ findings: [{ item: "Roof", coverage: "Coverage A Dwelling", policy_id: "HO-1", status: "likely_covered",
        explanation: "Covered.", citations: [{ chunk_id: firstHit(m).chunk_id, quote: "We will pay for any roof damage of any kind whatsoever" }] }] }))] }),
      (m) => {
        const feedback = JSON.parse(String(m.at(-1)!.content));
        assert.equal(feedback.accepted, false);
        assert.match(feedback.issues.join(), /exact words are not in/);
        return { toolCalls: [call("finish_review", decision({ findings: [{ item: "Roof", coverage: "Coverage A Dwelling", policy_id: "HO-1", status: "likely_covered",
          explanation: "Covered unless excluded.", citations: [{ chunk_id: firstHit(m).chunk_id, quote: "We will pay for accidental direct physical loss to the property described in Coverage A" }] }] }))] };
      },
    ]);
    const { db, deps } = await setup({ model });
    const run = claimRun(db, "w1")!;
    const result = await executeRun(run, "w1", deps, new AbortController().signal);
    assert.equal(result.usage.revisions, 1);
    assert.equal(result.decision.findings[0].status, "likely_covered");
  });

  it("routes to a human with a safe reply when the model cannot ground its findings", async () => {
    const bad = (m: Message[]) => ({ toolCalls: [call("finish_review", decision({ reply: "We have sent you $5,000.",
      findings: [{ item: "Roof", coverage: "Coverage A Dwelling", policy_id: "HO-1", status: "likely_covered", explanation: "Covered.", citations: [] }] }))], _m: m });
    const model = scripted([() => ({ toolCalls: [call("search_policy", { purpose: "Look", query: "dwelling" })] }), bad, bad, bad]);
    const { db, deps } = await setup({ model });
    const run = claimRun(db, "w1")!;
    const result = await executeRun(run, "w1", deps, new AbortController().signal);
    assert.equal(result.decision.next_action, "human_review");
    assert.equal(result.decision.findings[0].status, "unclear");
    assert.doesNotMatch(result.decision.reply, /\$5,000/);
  });

  it("delivers only the safe acknowledgement after citation failures exhaust revisions", async () => {
    // This wording escapes the promise patterns. Citation validation must still prevent delivery.
    const proposed = decision({
      immediate_danger: true, next_action: "human_review",
      reply: "Your home policy does cover windstorm damage. Call 911 if you are in danger.",
      findings: [{ item: "Roof", coverage: "Coverage A Dwelling", policy_id: "HO-1",
        status: "likely_covered", explanation: "Wind damage.",
        citations: [{ chunk_id: "SF-HOME-OK#999", quote: "Invented coverage wording" }] }],
    });
    assert.deepEqual(validateDecision({ ...proposed, findings: [] }, new Map(), CUSTOMER).issues, []);
    const reject = () => ({ toolCalls: [call("finish_review", proposed)] });
    const { db, deps, intake } = await setup({ model: scripted([reject, reject, reject]) });
    await processRun(claimRun(db, "w1")!, "w1", deps);
    await deliverPending(db, { simulation: simulatorDelivery });
    const stored = getRun(db, intake.run!.id)!.decision as { decision: Decision };
    assert.equal(stored.decision.reply, FALLBACK_REPLY);
    assert.equal(stored.decision.findings[0].status, "unclear");
    assert.equal(stored.decision.next_action, "human_review");
    assert.equal(messages(db, intake.case.id).at(-1)!.text, FALLBACK_REPLY);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_requests WHERE case_id=?", intake.case.id)!.n, 1);
    assert.match(FALLBACK_REPLY, /911/);
    assert.ok(caseEvents(db, intake.case.id).some((e) => e.type === "decision.sanitized"));
  });

  it("replaces the proposed reply when verifier concerns remain after revisions", async () => {
    const model = scripted([() => ({ toolCalls: [call("finish_review", decision())] })]);
    const verifier = scripted([() => ({ toolCalls: [call("submit_verdict", {
      verdict: "revise", issues: ["The reply overstates the available coverage evidence"], severity_check: "reasonable",
    })] })]);
    const { db, deps, intake } = await setup({ model, verifier });
    deps.limits.maxRevisions = 0;
    await processRun(claimRun(db, "w1")!, "w1", deps);
    await deliverPending(db, { simulation: simulatorDelivery });
    const stored = getRun(db, intake.run!.id)!.decision as { decision: Decision; verified: boolean };
    assert.equal(stored.verified, false);
    assert.equal(stored.decision.next_action, "human_review");
    assert.equal(stored.decision.reply, FALLBACK_REPLY);
    assert.equal(messages(db, intake.case.id).at(-1)!.text, FALLBACK_REPLY);
    assert.ok(caseEvents(db, intake.case.id).some((e) => e.type === "decision.sanitized"));
  });

  it("a failed run still sends a fallback reply and queues a human review", async () => {
    const model: AgentModel = { name: "down", async turn() { throw new Error("connection refused"); } };
    const { db, deps, intake } = await setup({ model });
    const run = claimRun(db, "w1")!;
    await processRun(run, "w1", deps);
    assert.equal(getRun(db, run.id)!.status, "failed");
    await deliverPending(db, { simulation: simulatorDelivery });
    assert.match(messages(db, intake.case.id).at(-1)!.text, /911/);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_requests")!.n, 1);
  });
});

describe("runs and delivery", () => {
  it("deduplicates a resent conversation and supersedes runs when new information arrives", async () => {
    const { db, intake } = await setup({ model: scripted([]) });
    const again = receive(db, { channel: "simulation", address: "sim:PH-TEST", customerId: "PH-TEST",
      turns: [{ role: "company", text: "Are you safe?" }, { role: "customer", text: "Tornado tore shingles off the roof, rain coming in. Covered?" }] });
    assert.equal(again.deduplicated, true);
    assert.equal(again.run!.id, intake.run!.id);

    const running = claimRun(db, "w1")!;
    assert.ok(owns(db, running.id, "w1"));
    appendMessage(db, intake.case.id, "customer", "Also the fence is down.");
    const newer = enqueueRun(db, { caseId: intake.case.id, trigger: "message", model: "m", promptVersion: "v" });
    assert.equal(getRun(db, running.id)!.status, "superseded");
    assert.equal(owns(db, running.id, "w1"), false);
    assert.throws(() => completeRun(db, running.id, "w1", {}, { turns: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0, revisions: 0 }, () => {}), LeaseLostError);
    assert.equal(claimRun(db, "w2")!.id, newer.run.id);
  });

  it("allows one active run per case while different cases run concurrently", async () => {
    const { db } = await setup({ model: scripted([]) });
    receive(db, { channel: "simulation", address: "sim:OTHER", customerId: null, turns: [{ role: "customer", text: "hello" }] });
    const a = claimRun(db, "w1")!;
    const b = claimRun(db, "w2")!;
    assert.notEqual(a.caseId, b.caseId);
    assert.equal(claimRun(db, "w3"), null);
  });

  it("cancels a prepared reply when the customer wrote again before it was sent", async () => {
    const { db, intake } = await setup({ model: scripted([]) });
    const run = claimRun(db, "w1")!;
    completeRun(db, run.id, "w1", {}, { turns: 1, toolCalls: 0, promptTokens: 0, completionTokens: 0, revisions: 0 },
      (r) => queueReply(db, { caseId: r.caseId, runId: r.id, body: "Hi Dana, thanks." }));
    appendMessage(db, intake.case.id, "customer", "Actually my neighbor is hurt");
    assert.equal(await deliverPending(db, { simulation: simulatorDelivery }), 0);
    assert.ok(caseEvents(db, intake.case.id).some((e) => e.type === "delivery.cancelled"));
  });
});

describe("argument coercion", () => {
  it("decodes nested arrays the model sent as JSON strings", async () => {
    const { parseArguments } = await import("@/tools/coerce");
    const parsed = parseArguments(JSON.stringify({ severity: 30, findings: JSON.stringify([{ item: "Fence", citations: "[]" }]), reply: "[not json" })) as Record<string, unknown>;
    assert.deepEqual(parsed.findings, [{ item: "Fence", citations: [] }]);
    assert.equal(parsed.reply, "[not json");
  });
});

describe("duplicate finish calls", () => {
  it("reviews the complete finish_review when a fragment arrives in the same turn", async () => {
    const model = scripted([
      () => ({ toolCalls: [call("finish_review", decision()), { id: "frag", name: "finish_review", arguments: '{"findings": []}' }] }),
    ]);
    const { db, deps } = await setup({ model });
    const run = claimRun(db, "w1")!;
    const result = await executeRun(run, "w1", deps, new AbortController().signal);
    assert.equal(result.usage.revisions, 0);
    assert.equal(result.decision.severity, 60);
  });
});

describe("context compaction", () => {
  it("elides older tool outputs on long runs but keeps citations verifiable", async () => {
    const big = "x".repeat(30_000);
    const steps = Array.from({ length: 5 }, () => () => ({ toolCalls: [call("get_customer_profile", { purpose: "Re-read profile (padding)" })] }));
    const model = scripted([
      () => ({ toolCalls: [call("search_policy", { purpose: "Dwelling", query: "dwelling windstorm roof" })] }),
      ...steps,
      (m) => {
        assert.ok(m.some((x) => x.role === "tool" && String(x.content).startsWith('{"elided"')), "older outputs elided");
        return { toolCalls: [call("finish_review", decision({ findings: [{ item: "Roof", coverage: "Coverage A Dwelling", policy_id: "HO-1", status: "likely_covered",
          explanation: "Insured unless excluded.", citations: [{ chunk_id: "SF-HOME-OK#0", quote: "We will pay for accidental direct physical loss to the property described in Coverage A" }] }] }))] };
      },
    ]);
    const { db, deps } = await setup({ model });
    const padded = { ...deps, customerOf: () => ({ ...CUSTOMER, household: big }) };
    const run = claimRun(db, "w1")!;
    const result = await executeRun(run, "w1", padded, new AbortController().signal);
    assert.equal(result.decision.findings[0].status, "likely_covered");
  });
});

describe("retry after a malformed decision", () => {
  it("offers only finish_review (unpinned) on the next turn after a shape error", async () => {
    const choices: unknown[] = [];
    const offered: string[][] = [];
    const inner = scripted([
      () => ({ toolCalls: [call("finish_review", { ...decision(), findings: "[{broken" })] }),
      () => ({ toolCalls: [call("finish_review", decision())] }),
    ]);
    const model: AgentModel = { name: "spy", turn: (m, tools, choice, signal) => {
      choices.push(choice); offered.push(tools.map((t) => (t as { function: { name: string } }).function.name));
      return inner.turn(m, tools, choice, signal);
    } };
    const { db, deps } = await setup({ model });
    const result = await executeRun(claimRun(db, "w1")!, "w1", deps, new AbortController().signal);
    assert.equal(result.decision.severity, 60);
    assert.deepEqual(choices, ["auto", "auto"]);
    assert.deepEqual(offered[1], ["finish_review"]);
  });
});

describe("adaptive concurrency", () => {
  const opts = { min: 2, max: 40, initial: 4, minStreamTps: 30, maxKvUsage: 0.85, intervalMs: 5_000 };
  const metrics = (over: object = {}) => ({ running: 4, waiting: 0, kvUsage: 0.1, preemptions: 0, tpotSum: 0, tpotCount: 0, ...over });

  it("adds capacity while the GPU is fast and the allowance is in use, and backs off when generation slows", async () => {
    const { CapacityController } = await import("@/workers/capacity");
    let m = metrics();
    const c = new CapacityController(opts, async () => m);
    await c.sample();
    while (c.tryAcquire()) { /* fill the allowance */ }
    // 1000 tokens in 10 s of inter-token time = 100 tok/s per stream: healthy.
    m = metrics({ tpotSum: 10, tpotCount: 1_000 });
    await c.sample();
    assert.equal(c.state().target, 6);
    assert.match(c.state().reason, /adding capacity/);
    // Next 1000 tokens took 50 s: 20 tok/s per stream, below the 30 tok/s floor.
    m = metrics({ tpotSum: 60, tpotCount: 2_000, running: 6 });
    await c.sample();
    assert.ok(c.state().target < 6);
    assert.match(c.state().reason, /generation slowed/);
  });

  it("backs off on KV pressure and falls back to the configured value without metrics", async () => {
    const { CapacityController } = await import("@/workers/capacity");
    let m: ReturnType<typeof metrics> | null = metrics({ kvUsage: 0.95 });
    const c = new CapacityController({ ...opts, initial: 20 }, async () => m);
    for (let i = 0; i < 20; i++) c.tryAcquire();
    await c.sample();
    assert.equal(c.state().target, 15);
    m = null;
    await c.sample();
    assert.equal(c.state().target, 20);
  });
});

describe("transient model failures", () => {
  it("re-queues the run to resume from its checkpoint instead of failing it", async () => {
    const { TransientModelError } = await import("@/agent/model");
    const model: AgentModel = { name: "flaky", async turn() { throw new TransientModelError("Connection error."); } };
    const { db, deps, intake } = await setup({ model });
    const run = claimRun(db, "w1")!;
    await processRun(run, "w1", deps);
    const after = getRun(db, run.id)!;
    assert.equal(after.status, "queued");
    assert.ok(caseEvents(db, intake.case.id).some((e) => e.type === "run.deferred"));
    assert.equal(claimRun(db, "w2"), null, "not claimable until its backoff passes");
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")!.n, 0, "no fallback reply for a retryable failure");
  });
});

describe("failure reasons and re-runs", () => {
  it("records a plain-language reason when a run fails", async () => {
    const model: AgentModel = { name: "down", async turn() { throw new Error("NEMOTRON_API_KEY or NEMOTRON_MODEL is not set"); } };
    const { db, deps, intake } = await setup({ model });
    const run = claimRun(db, "w1")!;
    await processRun(run, "w1", deps);
    const { runSummary } = await import("@/cases/views");
    const summary = runSummary(db, getRun(db, run.id)!);
    assert.equal(summary.failure?.summary, "Nemotron is not configured");
    assert.match(summary.progress.label, /Failed: Nemotron is not configured/);
    const failed = caseEvents(db, intake.case.id).find((e) => e.type === "run.failed")!;
    assert.match(failed.title, /Agent run failed: Nemotron is not configured/);
  });

  it("a forced re-run creates a new run even when an identical one exists", async () => {
    const { db, intake } = await setup({ model: scripted([]) });
    const again = enqueueRun(db, { caseId: intake.case.id, trigger: "message", model: "m", promptVersion: "v", force: true });
    assert.equal(again.deduplicated, false);
    assert.notEqual(again.run.id, intake.run!.id);
    assert.equal(getRun(db, intake.run!.id)!.status, "superseded");
  });
});

describe("findings recorded one at a time", () => {
  it("validates each finding on record and builds the decision from recorded findings", async () => {
    const model = scripted([
      () => ({ toolCalls: [call("search_policy", { purpose: "Dwelling", query: "dwelling windstorm roof" })] }),
      (m) => ({ toolCalls: [call("record_finding", { purpose: "Roof", item: "Roof", coverage: "Coverage A Dwelling", policy_id: "HO-1", status: "likely_covered",
        explanation: "Insured.", chunk_id: firstHit(m).chunk_id, quote: "We will pay for any roof damage whatsoever, always" })] }),
      (m) => {
        assert.match(String(m.at(-1)!.content), /Not recorded/);
        // Single quotes where the PDF has none, and a quote that starts in the cited passage's text.
        return { toolCalls: [call("record_finding", { purpose: "Roof", item: "Roof", coverage: "Coverage A Dwelling", policy_id: "HO-1", status: "likely_covered",
          explanation: "Insured unless excluded.", chunk_id: firstHit(m).chunk_id, quote: "We will pay for 'accidental direct physical loss' to the property described in Coverage A" })] };
      },
      () => ({ toolCalls: [call("finish_review", { ...decision(), findings: undefined, unknowns: "Repair cost\nPhotos" })] }),
    ]);
    const { db, deps } = await setup({ model });
    const result = await executeRun(claimRun(db, "w1")!, "w1", deps, new AbortController().signal);
    assert.equal(result.decision.findings.length, 1);
    assert.equal(result.decision.findings[0].status, "likely_covered");
    assert.deepEqual(result.decision.unknowns, ["Repair cost", "Photos"]);
    assert.equal(result.usage.revisions, 0);
  });

  it("queues a human review when the reply promises a follow-up", async () => {
    const model = scripted([() => ({ toolCalls: [call("finish_review", decision({ reply: "Hi Dana, a claims specialist will contact you about the roof. Can you send photos?" }))] })]);
    const { db, deps } = await setup({ model });
    const run = claimRun(db, "w1")!;
    const result = await executeRun(run, "w1", deps, new AbortController().signal);
    assert.equal(result.decision.next_action, "reply");
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_requests WHERE run_id=?", run.id)!.n, 1);
  });

  it("recovers arguments with trailing junk or a cut-off end", async () => {
    const { parseArguments } = await import("@/tools/coerce");
    assert.deepEqual(parseArguments('{"a":1}{}{}{"b":2}'), { a: 1 });
    assert.deepEqual(parseArguments('{"a":"x","list":["p","q"'), { a: "x", list: ["p", "q"] });
  });
});

describe("model output recovery", () => {
  it("offers only finish_review after a cutoff and stops after a second cutoff", async () => {
    const offered: string[][] = [];
    const model: AgentModel & { calls: number } = {
      name: "cutoff", calls: 0,
      async turn(_messages, tools) {
        this.calls++;
        offered.push(tools.map((t) => t.type === "function" ? t.function.name : "custom"));
        return { content: null, toolCalls: [], finishReason: "length", usage: { promptTokens: 10, completionTokens: 8192 } };
      },
    };
    const { db, deps, intake } = await setup({ model });
    await processRun(claimRun(db, "w1")!, "w1", deps);
    assert.equal(model.calls, 2);
    const { runSummary } = await import("@/cases/views");
    const failed = getRun(db, intake.run!.id)!;
    assert.equal(runSummary(db, failed).humanInterventionNeeded, true);
    assert.equal(runSummary(db, { ...failed, error: "Connection error" }).humanInterventionNeeded, false);
    assert.deepEqual(offered[1], ["finish_review"]);
    assert.equal(getRun(db, intake.run!.id)!.status, "failed");
    await deliverPending(db, { simulation: simulatorDelivery });
    assert.equal(messages(db, intake.case.id).at(-1)!.text, FALLBACK_REPLY);
    assert.equal(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM review_requests")!.n, 1);
    db.run("DELETE FROM review_requests WHERE run_id=?", failed.id);
    assert.equal(runSummary(db, failed).humanInterventionNeeded, false, "requires a persisted handoff");
  });

  it("keeps malformed historical calls paired with feedback without poisoning vLLM requests", async () => {
    const { validToolHistory } = await import("@/agent/model");
    const history: Message[] = [
      { role: "assistant", content: "", tool_calls: [{ id: "bad", type: "function", function: { name: "finish_review", arguments: '{"reply":"cut off' } }] },
      { role: "tool", tool_call_id: "bad", content: '{"accepted":false}' },
      { role: "assistant", content: "", tool_calls: [{ id: "good", type: "function", function: { name: "finish_review", arguments: JSON.stringify(decision()) } }] },
    ];
    const safe = validToolHistory(history);
    const args = (m: Message) => m.role === "assistant" && m.tool_calls?.[0]?.type === "function" ? m.tool_calls[0].function.arguments : "";
    assert.equal(args(safe[0]), "{}");
    assert.equal(safe[1], history[1]);
    assert.equal(args(safe[2]), args(history[2]));
    assert.equal(args(history[0]), '{"reply":"cut off', "audit history is unchanged");
  });

  it("discards truncated calls before execution and recovers on the next turn", async () => {
    const model = scripted([
      () => ({ finishReason: "length", toolCalls: [call("request_human_review", { purpose: "partial" })] }),
      (history) => {
        assert.ok(!history.some((m) => m.role === "assistant" && m.tool_calls?.length));
        return { toolCalls: [call("finish_review", decision())] };
      },
    ]);
    const { db, deps, intake } = await setup({ model });
    const result = await executeRun(claimRun(db, "w1")!, "w1", deps, new AbortController().signal);
    assert.equal(result.decision.severity, 60);
    const events = caseEvents(db, intake.case.id);
    assert.ok(events.some((e) => e.type === "model.truncated"));
    assert.ok(!events.some((e) => e.type === "tool.completed"));
  });
});

describe("workspace restoration", () => {
  it("restores completed work without submitting the conversation again", async () => {
    const { AgentQueue } = await import("@/lib/sim/agent-queue");
    const { runSummary } = await import("@/cases/views");
    const { db, intake } = await setup({ model: scripted([]) });
    db.run("UPDATE runs SET status='completed' WHERE id=?", intake.run!.id);
    const summary = runSummary(db, getRun(db, intake.run!.id)!);
    const queue = new AgentQueue();
    const turns = [{ from: "policyholder" as const, text: "Roof damaged" }];
    queue.restore("PH-TEST", turns, summary);
    const restored = queue.runsFor("PH-TEST")[0];
    assert.equal(restored.status, "done");
    assert.equal(restored.caseId, intake.case.id);
    queue.ensure("PH-TEST", restored.key, turns);
    assert.equal(queue.runsFor("PH-TEST").length, 1);
    queue.restore("PH-TEST", [], { ...summary, id: "other" });
    assert.equal(queue.runsFor("PH-TEST")[0].runId, summary.id);
    queue.reset();
  });
  it("tracks a new run after a simulated customer message and clears its poll timer on reset", async () => {
    const { AgentQueue } = await import("@/lib/sim/agent-queue");
    const { runSummary } = await import("@/cases/views");
    const { db, intake } = await setup({ model: scripted([]) });
    const queue = new AgentQueue();
    const summary = runSummary(db, intake.run!);
    queue.restore("PH-TEST", [], summary);
    assert.equal(queue.runsFor("PH-TEST")[0].status, "running");
    queue.restore("PH-TEST", [{ from: "policyholder", text: "New information" }], { ...summary, id: "new-run" }, true);
    assert.equal(queue.runsFor("PH-TEST")[0].runId, "new-run");
    queue.reset();
    assert.deepEqual(queue.runsFor("PH-TEST"), []);
  });
});
