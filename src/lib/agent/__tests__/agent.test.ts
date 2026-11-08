// Claim pipeline tests. The model is scripted; retrieval runs against the real policy index (lexical,
// or a deterministic local embedder for the embedding path). No network, no keys.
// Run: npm run test:agent

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POST } from "@/app/api/agent/analyze/route";
import { assessClaim, grantsCoverage, type AgentDeps } from "../analyze";
import { agentConfig, DEFAULT_NEMOTRON_BASE_URL } from "../config";
import { extractJson, ModelUnavailableError, type ChatOptions, type ModelClient } from "../nemotron";
import { ACK_MESSAGE, EMERGENCY_MESSAGE, NOT_A_CLAIM_MESSAGE, updateMessage, type Notifier } from "../notify";
import { handleIncomingText, type PipelineDeps } from "../pipeline";
import { loadPolicyIndex, POLICY_LINES, type PolicyIndex } from "../policy-docs";
import { DANGER_SYSTEM, EXTRACTION_SYSTEM } from "../prompts";
import { lexicalSearch, retrieve, tokenize } from "../retrieve";
import { ExtractionSchema, type ClaimAnalysis, type ClaimItem, type Extraction } from "../schemas";

const fullIndex = loadPolicyIndex();
const index: PolicyIndex = { ...fullIndex, embed_model: null }; // lexical path, deterministic
const config = agentConfig({ PROVISIONAL_CAP_USD: "2500" });

type Coverage = (user: string) => unknown;

/** The excerpts the coverage model was shown: [chunk_id, text] pairs. */
const excerpts = (user: string) =>
  [...user.matchAll(/\[chunk_id: ([^\]]+)\][^\n]*\n([^\n]+)/g)].map((m) => ({ id: m[1], text: m[2] }));

/** Yes-man: always eligible, quoting (verbatim) the start of the first excerpt it was shown. */
const yesMan: Coverage = (user) => {
  const [first] = excerpts(user);
  if (!first) return { decision: "human_review", reason: "No relevant policy text.", citations: [] };
  return { decision: "eligible", reason: "Covered.", citations: [{ chunk_id: first.id, quote: first.text.slice(0, 90) }] };
};

/** Same, but always deferring to a human. */
const deferring: Coverage = (user) => ({ ...(yesMan(user) as object), decision: "human_review", reason: "Needs review." });

/**
 * Honest: eligible only when an excerpt contains the clause that grants this kind of item, quoting
 * that clause's sentence; everything else goes to human review.
 */
const GRANT_ANCHORS: [RegExp, string][] = [
  [/food|fridge|freezer/i, "Coverage B is extended to cover the contents of deep freeze or refrigerated units"],
  [/hotel|motel|uninhabitable/i, "When a loss insured causes the residence premises to become uninhabitable"],
  [/rental/i, "We will pay the daily transportation charge"],
];
const honest: Coverage = (user) => {
  const item = user.match(/^Item [^:]+: (.*)$/m)?.[1] ?? "";
  const anchor = GRANT_ANCHORS.find(([re]) => re.test(item))?.[1];
  for (const ex of anchor ? excerpts(user) : []) {
    const at = ex.text.indexOf(anchor!);
    if (at >= 0) {
      const quote = ex.text.slice(at, ex.text.indexOf(".", at + anchor!.length) + 1);
      return { decision: "eligible", reason: "The cited clause grants this coverage.", citations: [{ chunk_id: ex.id, quote }] };
    }
  }
  return { decision: "human_review", reason: "Property damage needs an adjuster.", citations: [] };
};

class ScriptedModel implements ModelClient {
  dangerCalls = 0;
  extractionCalls = 0;
  coverageCalls = 0;
  dangerOptions: ChatOptions | undefined;
  extractionOptions: ChatOptions | undefined;
  coverageOptions: ChatOptions | undefined;
  shown: string[] = []; // every coverage prompt
  constructor(
    private script: {
      danger?: unknown; // default: no danger
      extraction?: unknown[]; // replies in order; strings are sent raw, Errors are thrown
      coverage?: Coverage | ((user: string) => Promise<unknown>);
      down?: boolean;
      onChat?: () => void;
      embed?: (texts: string[]) => number[][];
    },
  ) {}
  async chat(system: string, user: string, options?: ChatOptions): Promise<string> {
    this.script.onChat?.();
    if (this.script.down) throw new ModelUnavailableError("HTTP 503: upstream down");
    const raw = (reply: unknown) => {
      if (reply instanceof Error) throw reply;
      return typeof reply === "string" ? reply : JSON.stringify(reply);
    };
    if (system === DANGER_SYSTEM) {
      this.dangerCalls++;
      this.dangerOptions = options;
      return raw(this.script.danger ?? { danger: false, reason: null });
    }
    if (system === EXTRACTION_SYSTEM) {
      this.extractionOptions = options;
      const replies = this.script.extraction ?? [];
      return raw(replies[Math.min(this.extractionCalls++, replies.length - 1)]);
    }
    this.coverageCalls++;
    this.coverageOptions = options;
    this.shown.push(user);
    return raw(await (this.script.coverage ?? deferring)(user));
  }
  async embed(texts: string[]): Promise<number[][]> {
    if (!this.script.embed) throw new ModelUnavailableError("no embeddings in tests");
    return this.script.embed(texts);
  }
}

class RecordingNotifier implements Notifier {
  sent: { to: string; body: string }[] = [];
  async send(to: string, body: string) {
    this.sent.push({ to, body });
  }
}

const deps = (client: ModelClient, overrides: Partial<AgentDeps> = {}): AgentDeps => ({ client, index, config, ...overrides });
const pipelineDeps = (client: ModelClient, notifier: Notifier = new RecordingNotifier()): PipelineDeps =>
  ({ ...deps(client), notifier });

function extraction(overrides: Partial<Extraction> & Pick<Extraction, "items">): Extraction {
  return {
    is_claim: true,
    summary: "The customer reports storm damage.",
    event_cause: "hurricane wind",
    claim_types: ["home"],
    people: [{ who: "customer", relation: "customer", injury: null }],
    ...overrides,
  };
}

const item = (o: Partial<ClaimItem> & Pick<ClaimItem, "id" | "description">): ClaimItem => ({
  type: "home", kind: "damage", category: "other", coverage: "other", owner: "customer", estimated_amount_usd: 1000,
  amount_is_estimate: false, triage: 2, triage_reason: "moderate damage", search_terms: [], ...o,
});

// The Rivera hurricane case (Katy, TX; state does not affect retrieval).
const ROOF = item({ id: "I1", description: "roof shingles torn off by hurricane wind", coverage: "dwelling", estimated_amount_usd: 8000,
                    triage: 3, triage_reason: "roof damage lets weather in",
                    search_terms: ["windstorm", "dwelling", "accidental direct physical loss"] });
const FENCE = item({ id: "I2", description: "back fence broken by a fallen tree", coverage: "other_structures", estimated_amount_usd: 1800,
                     triage: 2, triage_reason: "fence damage, not urgent",
                     search_terms: ["other structures", "falling objects", "trees"] });
const CEILING = item({ id: "I3", description: "water coming in through the ceiling in the kids' room", coverage: "dwelling", estimated_amount_usd: 2000,
                       triage: 3, triage_reason: "water entering the home",
                       search_terms: ["rain", "water damage", "interior of building"] });
const FOOD = item({ id: "I4", description: "spoiled food from fridge and freezer after power outage", kind: "expense",
                    category: "food_spoilage", coverage: "personal_property", estimated_amount_usd: 250, triage: 1, triage_reason: "small covered cost",
                    search_terms: ["refrigerated products", "power failure", "deep freeze"] });
const HOTEL = item({ id: "I5", description: "hotel for a few nights because the home is uninhabitable", kind: "expense",
                     category: "living_expense", coverage: "loss_of_use", estimated_amount_usd: 600, triage: 1, triage_reason: "small covered cost",
                     search_terms: ["additional living expense", "loss of use", "uninhabitable"] });
const RIVERA = extraction({ items: [ROOF, FENCE, CEILING, FOOD, HOTEL],
                            people: [{ who: "Maria Rivera", relation: "customer", injury: null },
                                     { who: "customer's two young children", relation: "family", injury: null }] });

const RENTAL = item({ id: "I1", description: "rental car while my car is repaired after hail", type: "auto", kind: "expense",
                      category: "rental_car", coverage: "vehicle", estimated_amount_usd: 300, triage: 1, triage_reason: "small covered cost",
                      search_terms: ["car rental expense", "daily transportation charge", "not drivable"] });

async function analyze(ex: Extraction, coverage?: Coverage, d: Partial<AgentDeps> = {}) {
  const model = new ScriptedModel({ coverage });
  const result = await assessClaim(ex, deps(model, d));
  return { result, model, byId: Object.fromEntries(result.items.map((i) => [i.id, i])) };
}

describe("acknowledgment -> danger check -> read -> update", () => {
  it("sends the acknowledgment before any model call, then the update", async () => {
    const notifier = new RecordingNotifier();
    let sentBeforeFirstModelCall = -1;
    const model = new ScriptedModel({
      extraction: [extraction({ items: [FOOD] })],
      coverage: honest,
      onChat: () => {
        if (sentBeforeFirstModelCall < 0) sentBeforeFirstModelCall = notifier.sent.length;
      },
    });
    const out = await handleIncomingText({ from: "+1555", text: "fridge food spoiled" }, pipelineDeps(model, notifier));
    assert.equal(sentBeforeFirstModelCall, 1);
    assert.equal(notifier.sent[0].body, ACK_MESSAGE);
    assert.deepEqual(out.messages.map((m) => m.kind), ["ack", "update"]);
    assert.match(notifier.sent[1].body, /standard priority.*Approved for an advance payment/);
  });

  it("the acknowledgment is delivered while the model is still working", async () => {
    const notifier = new RecordingNotifier();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const model = new ScriptedModel({ extraction: [extraction({ items: [FOOD] })], coverage: honest });
    const slow: ModelClient = { embed: model.embed.bind(model), chat: async (...a) => { await gate; return model.chat(...a); } };
    const running = handleIncomingText({ from: "+1555", text: "fridge food spoiled" }, pipelineDeps(slow, notifier));
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(notifier.sent.map((m) => m.body), [ACK_MESSAGE]);
    release();
    await running;
    assert.equal(notifier.sent.length, 2);
  });

  it("model down: acknowledges, updates with the 911 line, and flags the case for a human", async () => {
    const notifier = new RecordingNotifier();
    const out = await handleIncomingText({ from: "+1555", text: "help" }, pipelineDeps(new ScriptedModel({ down: true }), notifier));
    assert.deepEqual(out.result, { status: "agent_unavailable", flagged_for_human: true, error: "HTTP 503: upstream down" });
    assert.deepEqual(out.messages.map((m) => m.kind), ["ack", "update"]);
    assert.match(notifier.sent[1].body, /claims specialist will review.*If anyone is in danger right now, call 911/);
  });

  it("an unexpected error still sends an update and flags the case for human review", async () => {
    const notifier = new RecordingNotifier();
    const model = new ScriptedModel({ extraction: [new TypeError("Cannot read properties of undefined")] });
    const out = await handleIncomingText({ from: "+1555", text: "roof damage" }, pipelineDeps(model, notifier));
    assert.equal(out.result.status, "agent_unavailable");
    assert.equal((out.result as { flagged_for_human: boolean }).flagged_for_human, true);
    assert.deepEqual(out.messages.map((m) => m.kind), ["ack", "update"]);
    assert.match(notifier.sent[1].body, /claims specialist/);
  });

  it("a failed text is recorded as undelivered without stopping the analysis", async () => {
    const failing: Notifier = { send: async () => { throw new Error("sms provider down"); } };
    const model = new ScriptedModel({ extraction: [extraction({ items: [FOOD] })], coverage: honest });
    const out = await handleIncomingText({ from: "+1555", text: "x" }, pipelineDeps(model, failing));
    assert.equal(out.result.status, "complete");
    assert.ok(out.messages.every((m) => !m.delivered && m.error === "sms provider down"));
  });
});

describe("safety override (triage 4, Nemotron's danger check)", () => {
  for (const text of ["trappd cant get out", "ayuda el agua sube"]) {
    it(`"${text}": Call 911 now even though the read would say triage 1`, async () => {
      const notifier = new RecordingNotifier();
      const model = new ScriptedModel({
        danger: { danger: true, reason: "people trapped as water rises" },
        extraction: [extraction({ items: [FOOD] })], // a triage-1 claim, never reached
        coverage: honest,
      });
      const out = await handleIncomingText({ from: "+1555", text }, pipelineDeps(model, notifier));
      assert.deepEqual(notifier.sent.map((m) => m.body), [ACK_MESSAGE, EMERGENCY_MESSAGE]);
      assert.equal(model.extractionCalls, 0); // the 911 reply does not wait for the claim read
      assert.equal(model.coverageCalls, 0);
      assert.deepEqual(out.result, { status: "emergency", triage: 4, flagged_for_human: true,
                                     reason: "people trapped as water rises" });
    });
  }

  it("the danger check is its own short call with reasoning off", async () => {
    const model = new ScriptedModel({ danger: { danger: true, reason: "trapped" } });
    await handleIncomingText({ from: "+1555", text: "trappd" }, pipelineDeps(model));
    assert.equal(model.dangerCalls, 1);
    assert.equal(model.dangerOptions?.reasoning, false);
  });

  it("the claim read and the coverage decisions run with reasoning off", async () => {
    const model = new ScriptedModel({ extraction: [extraction({ items: [FOOD] })], coverage: honest });
    await handleIncomingText({ from: "+1555", text: "food spoiled" }, pipelineDeps(model));
    assert.equal(model.extractionOptions?.reasoning, false);
    assert.equal(model.coverageOptions?.reasoning, false);
  });

  it("an unusable danger check is never treated as safe: update with the 911 line, flagged", async () => {
    const notifier = new RecordingNotifier();
    const model = new ScriptedModel({ danger: "no idea", extraction: [extraction({ items: [FOOD] })] });
    const out = await handleIncomingText({ from: "+1555", text: "water everywhere" }, pipelineDeps(model, notifier));
    assert.equal(out.result.status, "agent_unavailable");
    assert.equal(model.dangerCalls, 2); // one retry
    assert.equal(model.extractionCalls, 0);
    assert.match(notifier.sent[1].body, /If anyone is in danger right now, call 911/);
  });

  it("messages only ever go back to the customer who texted", async () => {
    const notifier = new RecordingNotifier();
    for (const danger of [{ danger: true, reason: "trapped" }, { danger: false, reason: null }]) {
      const model = new ScriptedModel({ danger, extraction: [extraction({ items: [FOOD] })], coverage: honest });
      await handleIncomingText({ from: "+15550100009", text: "x" }, pipelineDeps(model, notifier));
    }
    assert.equal(notifier.sent.length, 4);
    assert.ok(notifier.sent.every((m) => m.to === "+15550100009"));
  });
});

describe("not a claim", () => {
  it('"hello" gets a short helpful reply and produces no claim', async () => {
    const notifier = new RecordingNotifier();
    const model = new ScriptedModel({
      extraction: [{ is_claim: false, summary: "", event_cause: "", claim_types: [], people: [], items: [] }],
    });
    const out = await handleIncomingText({ from: "+1555", text: "hello" }, pipelineDeps(model, notifier));
    assert.deepEqual(out.result, { status: "not_a_claim" });
    assert.deepEqual(out.messages.map((m) => m.kind), ["ack", "info"]);
    assert.equal(notifier.sent[1].body, NOT_A_CLAIM_MESSAGE);
    assert.ok(!notifier.sent.some((m) => /logged your claim/.test(m.body)));
    assert.equal(model.coverageCalls, 0);
  });

  it("whitespace-only text is rejected safely: no model call, no acknowledgment of a claim", async () => {
    const notifier = new RecordingNotifier();
    const model = new ScriptedModel({});
    const out = await handleIncomingText({ from: "+1555", text: "   \n\t " }, pipelineDeps(model, notifier));
    assert.deepEqual(out.result, { status: "not_a_claim" });
    assert.equal(model.dangerCalls + model.extractionCalls, 0);
    assert.deepEqual(notifier.sent.map((m) => m.body), [NOT_A_CLAIM_MESSAGE]);
  });
});

describe("Rivera hurricane case (Katy, TX)", () => {
  it("honest model: food and hotel approved; roof, fence and ceiling sent to review", async () => {
    const { result, byId } = await analyze(RIVERA, honest);
    assert.equal(byId.I4.approved, true, byId.I4.reason);
    assert.equal(byId.I5.approved, true, byId.I5.reason);
    for (const id of ["I1", "I2", "I3"]) assert.equal(byId[id].approved, false, id);
    assert.equal(result.approved_amount_usd, 850);
    assert.equal(result.claim_amount_usd, 12650);
    assert.equal(result.claim_approved, false);
    assert.equal(result.flagged_for_human, true);
  });

  it("a model that approves everything: roof, fence and ceiling still go to review", async () => {
    const { byId } = await analyze(RIVERA, yesMan);
    for (const id of ["I1", "I2", "I3"]) {
      assert.equal(byId[id].approved, false, id);
      assert.match(byId[id].reason, /Only spoiled food, extra living expenses and rental cars/);
    }
  });

  it("per-item triage: food and hotel green, fence yellow, ceiling red; the claim is red", async () => {
    const { result, byId } = await analyze(RIVERA, honest);
    assert.deepEqual([byId.I4.triage, byId.I5.triage, byId.I2.triage, byId.I3.triage], [1, 1, 2, 3]);
    assert.equal(byId.I2.triage_reason, "fence damage, not urgent");
    assert.equal(result.triage, 3);
  });

  it("the food spoilage approval cites the Refrigerated Products clause of a homeowners form", async () => {
    const { byId } = await analyze(RIVERA, honest);
    const [cite] = byId.I4.citations;
    assert.match(cite.doc_id, /^SF-HOME-(TX|CA|ME|OK)$/); // any homeowners form; state is ignored
    assert.match(cite.quote, /deep freeze or refrigerated units/);
  });

  it("a quote from a neighbouring clause never counts; code attaches the Refrigerated Products sentence itself", async () => {
    const { byId } = await analyze(extraction({ items: [FOOD] }), yesMan);
    const [modelCite, codeCite] = byId.I4.citations;
    assert.equal(grantsCoverage("food_spoilage", modelCite.quote), false); // what the model quoted
    assert.equal(codeCite.found_by_code, true);
    assert.match(codeCite.quote, /deep freeze or refrigerated units/);
    assert.equal(byId.I4.approved, true);
  });

  it("food: the model says review and quotes the wrong clause; code finds the granting sentence and approves", async () => {
    const { byId } = await analyze(extraction({ items: [FOOD] }),
      (user) => ({ ...(yesMan(user) as object), decision: "human_review", reason: "No relevant policy text." }));
    assert.equal(byId.I4.approved, true, byId.I4.reason);
    assert.equal(byId.I4.code_override, true);
    assert.ok(byId.I4.citations.some((c) => c.found_by_code && /refrigerated units/.test(c.quote)));
  });

  it("no granting sentence in the retrieved text: an allowlisted item still goes to review", async () => {
    const odd = { ...FOOD, description: "zqxv", search_terms: [] };
    const sparse = { ...index, chunks: index.chunks.filter((c) => !/refrigerated units|deep freeze/i.test(c.text)) };
    const { byId } = await analyze(extraction({ items: [odd] }), yesMan, { index: sparse });
    assert.equal(byId.I4.approved, false);
  });

  it("comes back home-only even if the model adds umbrella: no one else was harmed", async () => {
    const { result } = await analyze({ ...RIVERA, claim_types: ["home", "umbrella"] }, honest);
    assert.deepEqual(result.claim_types, ["home"]);
  });

  it("hotel: the model says review without naming an exclusion, code approves and records the model's answer", async () => {
    const timid = (reason: string): Coverage => (user) => ({ ...(honest(user) as object), decision: "human_review", reason });
    const { byId } = await analyze(extraction({ items: [HOTEL] }), timid("No relevant policy text."));
    assert.equal(byId.I5.approved, true, byId.I5.reason);
    assert.equal(byId.I5.code_override, true);
    assert.deepEqual(byId.I5.model_decision, { decision: "human_review", reason: "No relevant policy text." });
    assert.match(byId.I5.reason, /Approved by code: verified quote from the Additional Living Expense clause/);
  });

  it("no code override when the model's reason names an exclusion, or for items off the allowlist", async () => {
    const timid = (reason: string): Coverage => (user) => ({ ...(honest(user) as object), decision: "human_review", reason });
    const excluded = await analyze(extraction({ items: [HOTEL] }), timid("Excluded: flood is a loss not insured."));
    assert.equal(excluded.byId.I5.approved, false);
    assert.equal(excluded.byId.I5.code_override, false);
    const { byId } = await analyze(RIVERA, deferring);
    for (const id of ["I1", "I2", "I3"]) assert.equal(byId[id].code_override, false, id);
    for (const id of ["I1", "I2", "I3"]) assert.equal(byId[id].approved, false, id);
  });

  it("damage labelled as an allowlisted cost is refused even with the granting clause quoted", async () => {
    // Same retrieval and quote as the approved hotel; only kind differs.
    const sneaky = { ...HOTEL, id: "I3", kind: "damage" as const };
    const { byId } = await analyze(extraction({ items: [sneaky] }), honest);
    assert.ok(byId.I3.citations.some((c) => grantsCoverage("living_expense", c.quote)));
    assert.equal(byId.I3.approved, false);
  });
});

describe("triage and the customer update", () => {
  it("the claim's triage is its highest item level; nothing itemized is never green", async () => {
    assert.equal((await analyze(extraction({ items: [FOOD, FENCE] }), honest)).result.triage, 2);
    assert.equal((await analyze(extraction({ items: [] }), honest)).result.triage, 2);
  });

  it("triage 1, 2 and 3 read as standard, elevated and urgent priority", async () => {
    for (const [items, word] of [[[FOOD], "standard"], [[FOOD, FENCE], "elevated"], [[FOOD, CEILING], "urgent"]] as const) {
      const { result } = await analyze(extraction({ items: [...items] }), honest);
      assert.match(updateMessage(result), new RegExp(`as ${word} priority`));
    }
  });
});

describe("provisional payment rules", () => {
  it("rental car: auto policy, Car Rental clause, approved", async () => {
    const { byId } = await analyze(extraction({ items: [RENTAL], claim_types: ["auto"] }), honest);
    assert.equal(byId.I1.approved, true, byId.I1.reason);
    assert.match(byId.I1.citations[0].doc_id, /^SF-(BIZ)?AUTO-/);
    assert.ok(grantsCoverage("rental_car", byId.I1.citations[0].quote));
  });

  it("a hotel stay with no price is estimated at 3 nights x $150, labelled, and approved under the cap", async () => {
    const { byId } = await analyze(extraction({ items: [{ ...HOTEL, estimated_amount_usd: null }] }), honest);
    assert.equal(byId.I5.estimated_amount_usd, 450);
    assert.equal(byId.I5.amount_is_estimate, true);
    assert.equal(byId.I5.approved, true, byId.I5.reason);
    assert.match(byId.I5.reason, /amount is an estimate: \$450/);
    assert.ok(byId.I5.citations.some((c) => grantsCoverage("living_expense", c.quote)));
  });

  it("the cap: exactly $2,500 is approved, $2,500.01 and an $80k car are not", async () => {
    const at = (amount: number, id: string) => ({ ...HOTEL, id, estimated_amount_usd: amount });
    const car = item({ id: "C", description: "car totaled by flood water", type: "auto", coverage: "vehicle", estimated_amount_usd: 80000,
                       search_terms: ["comprehensive coverage", "flood"] });
    const { byId } = await analyze(extraction({ items: [at(2500, "A"), at(2500.01, "B"), car] }), honest);
    assert.equal(byId.A.approved, true, byId.A.reason);
    assert.equal(byId.B.approved, false);
    assert.match(byId.B.reason, /exceeds the \$2500 provisional limit/);
    assert.equal(byId.C.approved, false);
  });

  it("umbrella: liability to others is never auto-approved", async () => {
    const wall = item({ id: "I1", description: "neighbor's house front wall destroyed by my car; neighbor's daughter injured",
                        owner: "third_party", type: "umbrella", coverage: "liability", estimated_amount_usd: 1500,
                        search_terms: ["personal liability", "bodily injury", "property damage"] });
    const { result } = await analyze(extraction({ items: [wall], claim_types: ["umbrella"] }), yesMan);
    assert.deepEqual(result.claim_types, ["umbrella"]); // someone else's property: umbrella stays
    assert.equal(result.items[0].approved, false);
    assert.equal(result.approved_amount_usd, 0);
  });

  it("an item whose amount is unknown goes to human review", async () => {
    const { result } = await analyze(extraction({ items: [{ ...FOOD, estimated_amount_usd: null }] }), honest);
    assert.match(result.items[0].reason, /Amount unknown/);
    assert.equal(result.claim_amount_usd, null);
  });

  it("the model's own human_review keeps its verified exclusion citation", async () => {
    const flood = item({ id: "I1", description: "ground floor furniture ruined by tsunami flood water", coverage: "personal_property", estimated_amount_usd: 6000,
                         search_terms: ["flood", "surface water", "tidal water", "losses not insured"] });
    const { result } = await analyze(extraction({ items: [flood], event_cause: "tsunami flood" }), deferring);
    assert.equal(result.items[0].approved, false);
    assert.match(result.items[0].citations[0].section, /LOSSES NOT INSURED/);
  });
});

describe("grounding guardrails", () => {
  it("an invented quote is rejected; an approval rests only on real policy text", async () => {
    const invented = "We will pay for anything in refrigerated units, always.";
    const { result } = await analyze(extraction({ items: [FOOD] }), (user) => ({
      decision: "eligible",
      reason: "Covered.",
      citations: [{ chunk_id: excerpts(user)[0].id, quote: invented }],
    }));
    const cites = result.items[0].citations;
    assert.ok(!cites.some((c) => c.quote === invented));
    assert.ok(cites.every((c) => c.found_by_code)); // only the sentence code found in the policy
    const { result: other } = await analyze(extraction({ items: [FENCE] }), (user) => ({
      decision: "eligible", reason: "Covered.", citations: [{ chunk_id: excerpts(user)[0].id, quote: invented }],
    }));
    assert.equal(other.items[0].approved, false);
    assert.equal(other.items[0].citations.length, 0);
  });

  it("a citation to a chunk that was not retrieved for this item is rejected", async () => {
    const autoChunk = index.chunks.find((c) => c.line === "auto")!;
    const { result } = await analyze(extraction({ items: [FOOD] }), () => ({
      decision: "eligible",
      reason: "Covered.",
      citations: [{ chunk_id: autoChunk.chunk_id, quote: autoChunk.text.slice(0, 60) }],
    }));
    assert.ok(!result.items[0].citations.some((c) => c.doc_id === autoChunk.doc_id));
  });

  it("no relevant policy text: human review without asking the model to decide", async () => {
    const odd = { ...FENCE, description: "zqxv blorf", coverage: "other" as const, search_terms: [] };
    const { result, model } = await analyze(extraction({ items: [odd], event_cause: "" }), honest);
    assert.equal(model.coverageCalls, 0);
    assert.match(result.items[0].reason, /No relevant policy text/);
  });

  it("a fence is shown the Other Structures clause, and a roof the Coverage A losses-insured clause", async () => {
    const { model } = await analyze(extraction({ items: [FENCE, ROOF] }), deferring);
    const fence = model.shown.find((u) => u.includes("back fence"))!;
    const roof = model.shown.find((u) => u.includes("roof shingles"))!;
    assert.match(fence, /2\. Other Structures\. We cover other structures/);
    assert.match(roof, /section "SECTION I – LOSSES INSURED > COVERAGE A – DWELLING"/);
  });

  it("near-identical clauses from different homeowners forms are shown only once", async () => {
    const { model } = await analyze(extraction({ items: [FOOD] }), deferring);
    const texts = excerpts(model.shown[0]).map((e) => e.text.slice(0, 120));
    assert.equal(new Set(texts).size, texts.length, texts.join("\n"));
  });

  it("a failed or malformed coverage reply sends only that item to human review", async () => {
    let n = 0;
    const { byId } = await analyze(extraction({ items: [FOOD, HOTEL] }), (user) => {
      if (/refrigerat|spoil/i.test(user)) return n++ === 0 ? "not json" : "still not json";
      return honest(user);
    });
    assert.equal(byId.I4.approved, false);
    assert.match(byId.I4.reason, /Automated policy check unavailable/);
    assert.equal(byId.I5.approved, true);
  });

  it("an unexpected error in one item's check sends only that item to human review", async () => {
    const { byId } = await analyze(extraction({ items: [FOOD, HOTEL] }), (user) => {
      if (/refrigerat|spoil/i.test(user)) throw new RangeError("bug");
      return honest(user);
    });
    assert.match(byId.I4.reason, /Automated policy check failed/);
    assert.equal(byId.I5.approved, true);
  });
});

describe("model output validation", () => {
  const claim = (model: ScriptedModel) => handleIncomingText({ from: "+1555", text: "x" }, pipelineDeps(model));

  it("category synonyms map to allowed values; unknown words become other", async () => {
    const { ClaimItemSchema } = await import("../schemas");
    const cat = (category: string) => ClaimItemSchema.parse({ ...FOOD, category }).category;
    for (const w of ["hotel", "Lodging", "motel", "temporary housing", "additional_living_expense"]) assert.equal(cat(w), "living_expense", w);
    for (const w of ["food", "groceries", "spoiled food"]) assert.equal(cat(w), "food_spoilage", w);
    for (const w of ["rental", "rental car", "loaner-car"]) assert.equal(cat(w), "rental_car", w);
    assert.equal(cat("roofing"), "other");
  });

  it("a coverage area written into category is moved back; a loss-of-use expense counts as a hotel", async () => {
    const { coverage: _c, ...hotelNoCoverage } = HOTEL;
    const { coverage: _f, ...fenceNoCoverage } = FENCE;
    void _c; void _f;
    const reply = extraction({ items: [] }) as Record<string, unknown>;
    reply.items = [{ ...hotelNoCoverage, category: "loss_of_use" }, { ...fenceNoCoverage, category: "other_structures" }];
    const out = await claim(new ScriptedModel({ extraction: [reply], coverage: honest }));
    const items = (out.result as ClaimAnalysis).items;
    assert.deepEqual(items.map((i) => [i.category, i.coverage]), [["living_expense", "loss_of_use"], ["other", "other_structures"]]);
    assert.equal(items[0].approved, true, items[0].reason);
  });

  it("retries once after invalid JSON", async () => {
    const model = new ScriptedModel({ extraction: ["not json at all", extraction({ items: [FOOD] })], coverage: honest });
    assert.equal((await claim(model)).result.status, "complete");
    assert.equal(model.extractionCalls, 2);
  });

  it("strips <think> blocks (closed or not) and code fences around the JSON", async () => {
    const reply = `<think>scratch</think>\n\`\`\`json\n${JSON.stringify(extraction({ items: [FOOD] }))}\n\`\`\``;
    assert.equal((await claim(new ScriptedModel({ extraction: [reply], coverage: honest }))).result.status, "complete");
    assert.throws(() => extractJson('<think>still thinking {"a": 1'), SyntaxError);
  });

  it("missing fields, truncated JSON, or an item triage outside 1-3 end in agent_unavailable", async () => {
    const bad = [
      { is_claim: true, summary: "x" },
      JSON.stringify(extraction({ items: [FOOD] })).slice(0, 80),
      extraction({ items: [{ ...FOOD, triage: 4 as 1 }] }),
    ];
    for (const reply of bad) {
      const out = await claim(new ScriptedModel({ extraction: [reply, reply] }));
      assert.equal(out.result.status, "agent_unavailable");
      assert.match((out.result as { error: string }).error, /expected shape/);
    }
  });
});

describe("policy index and retrieval", () => {
  it("indexes all 10 manifest documents, including the California homeowners form", () => {
    assert.equal(fullIndex.documents.length, 10);
    assert.deepEqual(fullIndex.documents.filter((d) => d.status === "missing").map((d) => d.doc_id), []);
    assert.deepEqual(
      fullIndex.documents.filter((d) => d.doc_id.startsWith("SF-HOME-")).map((d) => d.doc_id).sort(),
      ["SF-HOME-CA", "SF-HOME-ME", "SF-HOME-OK", "SF-HOME-TX"],
    );
    assert.ok(fullIndex.chunks.some((c) => c.doc_id === "SF-HOME-CA" && c.form_number === "HW-2105" && c.state === "CA"));
    for (const c of fullIndex.chunks) {
      assert.ok(c.doc_id && c.form_number && c.state && POLICY_LINES.includes(c.line), c.chunk_id);
    }
  });

  it("when the index has embeddings, every chunk has one of the same size", () => {
    if (!fullIndex.embed_model) return;
    const dim = fullIndex.chunks[0].embedding?.length;
    assert.ok(dim);
    assert.ok(fullIndex.chunks.every((c) => c.embedding?.length === dim));
  });

  it("retrieval never crosses policy lines", () => {
    const queries = ["roof torn off by tornado windstorm dwelling", "rental car while repaired",
                     "neighbor injured liability lawsuit", "spoiled food refrigerated products"];
    for (const line of POLICY_LINES) {
      for (const q of queries) {
        for (const hit of lexicalSearch(index, line, q, 10, 0)) assert.equal(hit.chunk.line, line, `${line}: ${q}`);
      }
    }
  });

  it("treats every form of a line as one policy, regardless of state", () => {
    const docs = new Set(lexicalSearch(index, "home", "windstorm hail damage loss", 200, 0).map((h) => h.chunk.doc_id));
    assert.ok(docs.has("SF-HOME-TX") && docs.has("SF-HOME-CA"), [...docs].join(" "));
  });
});

describe("retrieval on the embedding path (deterministic local embedder)", () => {
  // Hashed bag of words: stands in for the NVIDIA model so the deployed code path runs offline.
  const hashEmbed = (text: string) => {
    const v = new Array<number>(512).fill(0);
    for (const t of tokenize(text)) {
      let h = 0;
      for (const ch of t) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      v[h % 512] += 1;
    }
    return v;
  };
  const embIndex: PolicyIndex = {
    ...fullIndex,
    embed_model: config.embedModel,
    chunks: fullIndex.chunks.map((c) => ({ ...c, embedding: hashEmbed(`${c.section}. ${c.text}`) })),
  };
  const embedder = { embed: (texts: string[]) => texts.map(hashEmbed) };

  it("an auto item with home-flavoured words is shown only auto policy text", async () => {
    const odd = item({ id: "I1", description: "roof torn off windstorm dwelling", type: "auto", search_terms: ["dwelling"] });
    const model = new ScriptedModel({ ...embedder, coverage: deferring });
    await assessClaim(extraction({ items: [odd], claim_types: ["auto"] }), deps(model, { index: embIndex }));
    const shown = model.shown.flatMap((u) => excerpts(u).map((e) => e.id));
    assert.ok(shown.length > 0);
    assert.ok(shown.every((id) => /^SF-(BIZ)?AUTO-/.test(id)), shown.join(" "));
  });

  it("home items see only homeowners text", async () => {
    const r = await retrieve(embIndex, "home", "spoiled food refrigerated products", new ScriptedModel(embedder), config);
    assert.equal(r.method, "embedding");
    assert.ok(r.chunks.length && r.chunks.every((h) => h.chunk.line === "home"));
  });

  it("nothing above the similarity floor: human review with no coverage call", async () => {
    const strict = agentConfig({ RAG_MIN_COSINE: "0.99" });
    const model = new ScriptedModel({ ...embedder, coverage: yesMan });
    const result = await assessClaim(extraction({ items: [FOOD] }), deps(model, { index: embIndex, config: strict }));
    assert.equal(model.coverageCalls, 0);
    assert.match(result.items[0].reason, /No relevant policy text/);
  });

  it("an index embedded with a different model falls back to lexical search", async () => {
    const other = agentConfig({ NEMOTRON_EMBED_MODEL: "some/other-embedder" });
    const warn = console.warn;
    console.warn = () => {};
    try {
      const r = await retrieve(embIndex, "home", "spoiled food refrigerated products power failure", new ScriptedModel(embedder), other);
      assert.equal(r.method, "lexical");
    } finally {
      console.warn = warn;
    }
  });
});

describe("configuration", () => {
  it("chat and embeddings use separate hosts and keys; the Brev key never goes to NVIDIA", () => {
    const c = agentConfig({ NEMOTRON_API_KEY: "brev-key", NEMOTRON_BASE_URL: "https://8000-x.gobrev.dev/v1" });
    assert.equal(c.embedApiKey, "");
    assert.equal(c.embedBaseUrl, DEFAULT_NEMOTRON_BASE_URL);
    const hosted = agentConfig({ NEMOTRON_API_KEY: "nvapi-x" });
    assert.equal(hosted.embedApiKey, "nvapi-x");
    const split = agentConfig({ NEMOTRON_API_KEY: "brev", NEMOTRON_BASE_URL: "https://b/v1",
                                NEMOTRON_EMBED_API_KEY: "nvapi-y", NEMOTRON_EMBED_BASE_URL: "https://e/v1" });
    assert.deepEqual([split.embedApiKey, split.embedBaseUrl], ["nvapi-y", "https://e/v1"]);
  });

  it("runs with no Photon, PUBLIC_BASE_URL or Nessie settings", async () => {
    const { nessieConfigured, requestPayout } = await import("@/lib/finance/nessie");
    assert.equal(nessieConfigured({}), false);
    assert.deepEqual(await requestPayout({ payout_id: "p1", amount_usd: 1, description: "x" }), { status: "not_configured" });
  });
});

describe("POST /api/agent/analyze", () => {
  const call = (body: unknown) =>
    POST(new Request("http://test/api/agent/analyze", { method: "POST", body: JSON.stringify(body) }));
  const withoutKey = async (fn: () => Promise<void>) => {
    const saved = process.env.NEMOTRON_API_KEY;
    delete process.env.NEMOTRON_API_KEY;
    const error = console.error;
    console.error = () => {};
    try {
      await fn();
    } finally {
      console.error = error;
      if (saved !== undefined) process.env.NEMOTRON_API_KEY = saved;
    }
  };

  it("rejects a body without text or with whitespace-only text", async () => {
    assert.equal((await call({ from: "+1555" })).status, 400);
    assert.equal((await call({ from: "+1555", text: "   " })).status, 400);
  });

  it("without a key: acknowledges, reports agent_unavailable flagged for a human, and updates", async () => {
    await withoutKey(async () => {
      const res = await call({ from: "+15550100001", text: "The storm spoiled about $300 of food in our fridge." });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.result.status, "agent_unavailable");
      assert.equal(body.result.flagged_for_human, true);
      assert.match(body.result.error, /NEMOTRON_API_KEY is not set/);
      assert.deepEqual(body.messages.map((m: { kind: string }) => m.kind), ["ack", "update"]);
    });
  });
});

describe("extraction shape", () => {
  const reply = (claim_types: unknown) => ({ is_claim: true, summary: "s", event_cause: "c", claim_types, people: [], items: [] });

  it("accepts claim_types written as a bare string", () => {
    assert.deepEqual(ExtractionSchema.parse(reply("auto")).claim_types, ["auto"]);
    assert.deepEqual(ExtractionSchema.parse(reply("auto, umbrella")).claim_types, ["auto", "umbrella"]);
  });

  it("still rejects an unknown claim type", () => {
    assert.throws(() => ExtractionSchema.parse(reply("boat")));
  });
});
