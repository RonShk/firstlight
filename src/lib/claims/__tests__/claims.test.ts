// Claims queue tests: generation, the quick read, and which policy documents a claim shows.
// Run: npm run test:claims

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Persona, Policy } from "../../../types/sim";
import type { Decision, RunSummary } from "../../../types/agent";
import { getPersonas } from "../../sim/personas";
import { triageAt, type AgentRun } from "../../sim/triage";
import { buildClaims } from "../generate";
import { DOCUMENT_FORMS, coverageLayers, selectDocuments } from "../policy-documents";
import { quickRead } from "../quick-read";
import { reviewClaim } from "../review";

const personas = getPersonas();
const claims = buildClaims(personas);

const policy = (line: Policy["line"], formId: string, extra: Partial<Policy> = {}): Policy => ({ id: `${line}-1`, line, formId, premiumAnnual: 1000, ...extra });
const auto = policy("auto", "SF-AUTO-TX", { auto: { vehicles: [{ year: 2022, make: "Honda", model: "CR-V", value: 30000 }], liability: "250/500/250", collisionDeductible: 500, comprehensiveDeductible: 250 } });
const home = policy("home", "SF-HOME-ME", { home: { dwelling: 300000, personalProperty: 150000, lossOfUse: 60000, deductible: 1000, windHailDeductible: 3000 } });
const umbrella = policy("umbrella", "SF-UMB-WEB", { umbrellaLimit: 1_000_000 });

function person(overrides: Partial<Persona> = {}): Persona {
  return { ...personas[0], selfEmployed: false, occupation: "Teacher", members: [{ name: "Sam Lee", age: 34, relation: "self" }], vulnerabilities: [], policies: [auto, home, umbrella], ...overrides };
}

const MARCUS = "Hi, I was hit at an intersection this morning while driving to work. My car is blocking part of the road and the front wheel looks damaged, so I don't think it can be driven. The police are here now, but I'm not sure what I should do next. Can someone please call me as soon as possible?";
const ANGELA = "I have the hotel receipts you requested for the nights we stayed out of the house. Where should I send them? I have six receipts and photos of the kitchen damage as well.";

describe("claim generation", () => {
  it("gives every policyholder exactly one claim with a unique number", () => {
    assert.equal(claims.length, personas.length);
    assert.equal(new Set(claims.map((c) => c.id)).size, personas.length);
    assert.equal(new Set(claims.map((c) => c.number)).size, personas.length);
  });

  it("includes tornado replies, silent households and everyday claims", () => {
    const tornado = claims.filter((c) => c.peril === "Tornado");
    assert.equal(tornado.length, 66);
    assert.equal(tornado.filter((c) => c.silent).length, 17);
    assert.ok(claims.some((c) => c.peril !== "Tornado"));
  });

  it("is deterministic", () => {
    assert.deepEqual(buildClaims(personas).map((c) => [c.number, c.subject]), claims.map((c) => [c.number, c.subject]));
  });

  it("never gives a person a claim about a policy line they don't hold (everyday claims)", () => {
    for (const c of claims.filter((x) => x.peril !== "Tornado")) {
      const held = c.persona.policies.map((p) => p.line);
      for (const line of c.quick.lines.filter((l) => l !== "umbrella")) assert.ok(held.includes(line), `${c.id} ${c.subject}: ${line} not held`);
    }
  });

  it("detects a policy line for every everyday claim except the no-policy question", () => {
    for (const c of claims.filter((x) => x.peril !== "Tornado" && x.peril !== "General")) assert.ok(c.quick.lines.length, `${c.subject}: no line detected`);
  });
});

describe("quick read", () => {
  it("reads the collision mockup as critical", () => {
    const q = quickRead([MARCUS], person(), 8);
    assert.deepEqual([q.severity, q.risk], ["critical", "Safety concern"]);
    assert.deepEqual(q.lines, ["auto", "umbrella"]);
  });

  it("reads the receipts mockup as a routine, home-only document request", () => {
    const q = quickRead([ANGELA], person(), 60);
    assert.deepEqual([q.severity, q.risk, q.summary], ["medium", "No active risk", "A routine document submission with no active risk."]);
    assert.deepEqual(q.lines, ["home"]);
  });

  it("does not take 'no one's hurt' as an injury", () => {
    assert.notEqual(quickRead(["No one's hurt thank god. Lost a bunch of shingles and the fence is down."], person(), 30).severity, "critical");
  });

  it("reads sloppy texts the same way", () => {
    assert.equal(quickRead(["my oxygen machine has no power maybe a few hours of tank left"], person(), 30).severity, "critical");
    assert.equal(quickRead(["we good 👍"], person(), 30).severity, "low");
  });

  it("does not count a car's windows as home damage", () => {
    const q = quickRead(["Every window in the Honda CR-V is blown out."], person(), 30);
    assert.deepEqual(q.lines, ["auto"]);
  });

  it("escalates a vague plea rather than guessing it's minor", () => {
    assert.equal(quickRead(["its bad here. what do i do"], person(), 30, ["home"]).severity, "high");
  });

  it("only involves umbrella when someone else may be harmed", () => {
    assert.ok(!quickRead(["Someone rear-ended me at a light. The bumper is cracked on my car."], person(), 30).lines.includes("umbrella"));
    assert.ok(quickRead(["I backed into a parked car and crushed its door."], person(), 30).lines.includes("umbrella"));
  });
});

describe("policy document selection", () => {
  const ids = (p: Persona, lines: Policy["line"][]) => selectDocuments(p, lines).map((d) => d.form.id);

  it("shows only auto for an auto-only claim", () => {
    assert.deepEqual(selectDocuments(person(), ["auto"]).map((d) => d.line), ["auto"]);
  });

  it("shows auto and umbrella, umbrella last, when both are involved", () => {
    assert.deepEqual(selectDocuments(person(), ["umbrella", "auto"]).map((d) => d.line), ["auto", "umbrella"]);
  });

  it("shows nothing for a line the person doesn't hold", () => {
    assert.deepEqual(selectDocuments(person({ policies: [auto] }), ["home"]), []);
    assert.deepEqual(selectDocuments(person({ policies: [auto] }), ["auto", "umbrella"]).map((d) => d.line), ["auto"]);
  });

  it("never shows more than one document per line, across the whole queue", () => {
    for (const c of claims) {
      const docs = selectDocuments(c.persona, c.quick.lines);
      assert.equal(new Set(docs.map((d) => d.line)).size, docs.length);
      assert.ok(docs.length <= 3);
    }
  });

  it("picks the auto form by age and work", () => {
    assert.deepEqual(ids(person(), ["auto"]), ["SF-AUTO-TX"]);
    assert.deepEqual(ids(person({ members: [{ name: "Ann Fox", age: 70, relation: "self" }] }), ["auto"]), ["SF-AUTO-MT"]);
    assert.deepEqual(ids(person({ selfEmployed: true }), ["auto"]), ["SF-BIZAUTO-OH"]);
  });

  it("says single or married in the auto match reason", () => {
    assert.match(selectDocuments(person(), ["auto"])[0].why, /^Single driver/);
    assert.match(selectDocuments(person({ members: [{ name: "Sam Lee", age: 34, relation: "self" }, { name: "Jo Lee", age: 33, relation: "spouse" }] }), ["auto"])[0].why, /^Married driver/);
  });

  it("picks the umbrella form by household", () => {
    const self = { name: "Sam Lee", age: 50, relation: "self" as const };
    const spouse = { name: "Jo Lee", age: 49, relation: "spouse" as const };
    assert.deepEqual(ids(person({ members: [self] }), ["umbrella"]), ["SF-UMB-WEB"]);
    assert.deepEqual(ids(person({ members: [self, spouse] }), ["umbrella"]), ["SF-UMB-CASE-OH"]);
    assert.deepEqual(ids(person({ members: [self, spouse, { name: "Kit Lee", age: 17, relation: "child" }] }), ["umbrella"]), ["SF-UMB-WEB"]);
    assert.deepEqual(ids(person({ members: [self, spouse, { name: "Kit Lee", age: 20, relation: "child" }] }), ["umbrella"]), ["SF-UMB-CASE-HI"]);
  });

  it("picks the homeowners form for the home's state, not a random on-file form", () => {
    assert.deepEqual(ids(person(), ["home"]), ["SF-HOME-OK"]);
  });

  it("agrees with the auto form the generator assigned, for all 400 people", () => {
    for (const p of personas) {
      const onFile = p.policies.find((x) => x.line === "auto");
      if (onFile) assert.equal(selectDocuments(p, ["auto"])[0].form.id, onFile.formId, p.id);
    }
  });

  it("only ever selects a form that exists", () => {
    for (const c of claims) for (const d of selectDocuments(c.persona, ["auto", "home", "umbrella"])) assert.ok(DOCUMENT_FORMS[d.form.id]);
  });
});

describe("coverage layers", () => {
  it("shows own-vehicle cover, then auto liability, then umbrella when liability is involved", () => {
    assert.deepEqual(coverageLayers(person(), ["auto", "umbrella"], "Collision"), [
      { name: "Collision", amount: "$500 deductible", note: "Repairs to the policyholder's vehicle" },
      { name: "Auto liability", amount: "$250,000 per person / $500,000 per accident", note: "Other people's injuries and damage" },
      { name: "Umbrella", amount: "$1,000,000", note: "Starts once auto liability limits are used up" },
    ]);
  });

  it("still covers the policyholder's own car when they have no umbrella", () => {
    assert.deepEqual(coverageLayers(person({ policies: [auto] }), ["auto", "umbrella"], "Collision").map((l) => l.name), ["Collision", "Auto liability"]);
  });

  it("uses comprehensive for storm damage and collision for a crash", () => {
    assert.equal(coverageLayers(person(), ["auto"], "Tornado")[0].name, "Comprehensive");
    assert.equal(coverageLayers(person(), ["auto"], "Collision")[0].name, "Collision");
  });

  it("uses the wind/hail deductible for a tornado", () => {
    assert.equal(coverageLayers(person(), ["home"], "Tornado")[0].note, "After $3,000 wind/hail deductible");
    assert.equal(coverageLayers(person(), ["home"], "Water")[0].note, "After $1,000 deductible");
  });

  it("says so when the line isn't held", () => {
    assert.equal(coverageLayers(person({ policies: [auto] }), ["home"], "Tornado")[0].note, "No homeowners policy on file");
  });
});

describe("Nemotron review", () => {
  const claim = claims.find((c) => !c.silent)!;
  const silent = claims.find((c) => c.silent)!;
  const done = (over: Partial<Decision> = {}, extra: Partial<RunSummary> = {}): AgentRun => ({
    key: "k", conversation: [], status: "done",
    result: {
      id: "r", caseId: "c", status: "completed", trigger: "message", model: "nemotron", promptVersion: "test",
      createdAt: "", startedAt: null, finishedAt: null, usage: null, error: null, activity: null,
      progress: { phase: "done", label: "Done", queuePosition: null, elapsedSeconds: null, etaSeconds: null, step: null },
      failure: null, humanInterventionNeeded: false,
      reply: { id: "m", kind: "reply", status: "sent", body: "Update text", sentAt: "", lastError: null },
      decision: { verified: true, citations: [], decision: {
        severity: 50, severity_reason: "Damage reported", immediate_danger: false, summary: "Fence down.",
        reported_facts: [], unknowns: [], findings: [], next_action: "reply", decision_reason: "Review complete", reply: "Update text", ...over,
      } }, ...extra,
    },
  });

  it("keeps the quick read while offline, loading or running", () => {
    assert.equal(reviewClaim(claim, undefined, false).state, "offline");
    assert.equal(reviewClaim(claim, undefined, null).state, "quick");
    assert.equal(reviewClaim(claim, { key: "k", conversation: [], status: "running" }, true).state, "reviewing");
    assert.equal(reviewClaim(claim, { key: "k", conversation: [], status: "error" }, true).state, "unavailable");
  });
  it("never reviews a household that hasn't said anything", () => {
    assert.equal(reviewClaim(silent, undefined, true).state, "none");
  });
  it("treats an emergency as critical and shows the persisted reply", () => {
    const r = reviewClaim(claim, done({ immediate_danger: true, next_action: "human_review" }), true);
    assert.deepEqual([r.state, r.severity, r.reply], ["human_review", "critical", "Update text"]);
  });
  it("maps the runtime decision and deduplicates resolved citations", () => {
    const run = done();
    const citation = { chunk_id: "SF-HOME-OK#1", doc_id: "SF-HOME-OK", form_number: "HW-2136", section: "X", page: 3, quote: "q", url: "/api/policies?form=SF-HOME-OK#page=3" };
    run.result!.decision!.citations = [citation, citation];
    const r = reviewClaim(claim, run, true);
    assert.deepEqual([r.state, r.severity, r.risk], ["reviewed", "medium", "Moderate damage"]);
    assert.equal(r.summary, "Fence down.");
    assert.equal(r.citations.length, 1);
  });
  it("shows expected limit handoffs as human intervention and preserves technical failures", () => {
    const run = done({}, { status: "failed", decision: null, humanInterventionNeeded: true });
    run.status = "error";
    assert.equal(reviewClaim(claim, run, true).state, "human_review");
    run.result!.humanInterventionNeeded = false;
    assert.equal(reviewClaim(claim, run, true).state, "unavailable");
  });
  it("does not show a future agent reply while replaying the simulation", () => {
    const run = done();
    run.finishedAt = 200;
    const truth = { personaId: claim.id, intensity: 0.5, impactAt: 0, damage: "minor" as const,
      injured: false, medicalUrgent: false, displaced: false, vehicleDamaged: false,
      uninsuredLoss: false, severity: 30, expectedRoute: "human_review" as const,
      replyTimes: [2], messages: ["Window damage"] };
    assert.ok(!triageAt(claim.persona, truth, 100, [], [run], true).thread.some((m) => m.from === "agent"));
    assert.ok(triageAt(claim.persona, truth, 200, [], [run], true).thread.some((m) => m.from === "agent"));
  });

  it("shows a specific reason and safety checks for an urgent handoff", async () => {
    const { reviewHandoff } = await import("../presentation");
    const run = done({ immediate_danger: true, next_action: "human_review",
      severity_reason: "Gloria's oxygen has no power and the tank may last only a few hours.",
      reported_facts: ["Home destroyed", "Gloria needs powered oxygen"],
      unknowns: ["Whether backup power is available", "Where the household can stay tonight", "Repair costs"] });
    const handoff = reviewHandoff(run.result, "Frank Price")!;
    assert.match(handoff.reason, /oxygen has no power/);
    assert.match(handoff.steps[0], /Call Frank now/);
    assert.match(handoff.steps[1], /oxygen equipment has power/);
    assert.match(handoff.steps[2], /stay safely tonight/);
    assert.equal(handoff.steps.length, 3);
  });

  it("keeps the recorded reason for a queued review even when the model chose reply", async () => {
    const { reviewHandoff } = await import("../presentation");
    const run = done({ next_action: "reply", unknowns: ["Repair estimate for the rear bumper"] }, {
      humanReview: { priority: "normal", status: "queued", reason: "Customer needs help getting a repair estimate after being rear-ended." },
    });
    const handoff = reviewHandoff(run.result, "Dana Reyes")!;
    assert.match(handoff.reason, /repair estimate/);
    assert.match(handoff.steps[0], /rear bumper/);
    assert.doesNotMatch(handoff.steps.join(" "), /immediate safety|urgently/);
    assert.equal(reviewHandoff(done().result, "Dana Reyes"), null);
  });

  it("gives a manual review task after an automation failure without inventing loss facts", async () => {
    const { reviewHandoff } = await import("../presentation");
    const run = done({}, { status: "failed", decision: null });
    const handoff = reviewHandoff(run.result, "Dana Reyes")!;
    assert.match(handoff.reason, /could not complete a reliable assessment/);
    assert.ok(handoff.steps.some((s) => /messages and policy/.test(s)));
    assert.doesNotMatch(JSON.stringify(handoff), /oxygen|injury|shelter/);
  });

  it("does not display an undelivered reply", () => {
    const run = done();
    run.result!.reply!.status = "held";
    assert.equal(reviewClaim(claim, run, true).reply, null);
  });
});

describe("inbox run labels", () => {
  it("distinguishes unstarted, queued, running, done, and failed work", async () => {
    const { agentStatus } = await import("../agent-status");
    assert.equal(agentStatus().label, "Not started");
    for (const [status, label] of [["queued", "Queued"], ["running", "Running"], ["done", "Done"], ["error", "Failed"]] as const) {
      assert.equal(agentStatus({ status, key: "k", conversation: [] }).label, label);
    }
  });
});

describe("plain language presentation", () => {
  it("keeps conditions and amounts while replacing policy jargon", async () => {
    const { plainCaseText, findingTitle, activityTitle } = await import("../presentation");
    assert.equal(plainCaseText("Loss of Use may pay up to $2,000 if the residence premises is uninhabitable."), "temporary living expenses may pay up to $2,000 if the home is unsafe to live in.");
    assert.equal(findingTitle("Home destruction (Coverage A Dwelling)"), "Home destruction");
    assert.equal(activityTitle("Reply shown on the simulated phone (demo only; no real SMS sent)"), "Reply added to the conversation");
  });
});
