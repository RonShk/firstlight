// Evaluation pipeline: run scenarios through the real runtime (intake -> worker -> Nemotron -> outbox)
// on scratch databases, score them, and write a report. Two suites:
//   core: hand-written scenarios with precise expectations (src/evals/scenarios/core.ts)
//   sim:  tornado-simulator households, scored against the simulator's hidden ground truth
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openOps } from "@/cases/db";
import { receive } from "@/cases/intake";
import { claimRun } from "@/cases/runs";
import { runView, type RunView } from "@/cases/views";
import { findPolicyholder } from "@/customers/directory";
import { deliverPending } from "@/delivery/outbox";
import { simulateCatastrophe } from "@/lib/sim/impact";
import { getPersonas } from "@/lib/sim/personas";
import { TORNADO } from "@/lib/sim/scenarios";
import { ADAPTERS, defaultAgentDeps, processRun } from "@/workers/agent-worker";
import { assess, type Check, type Expectation } from "./assertions";
import { CORE_SCENARIOS } from "./scenarios/core";

export interface EvalCase { id: string; title: string; personaId: string; messages: string[]; expect: Expectation; truth?: { severity: number; danger: boolean; route: string } }
export interface EvalResult { case: EvalCase; checks: Check[]; passed: boolean; seconds: number; view: RunView | null }

export function coreCases(): EvalCase[] {
  const personas = getPersonas();
  return CORE_SCENARIOS.map((s) => {
    const persona = personas.find(s.persona);
    if (!persona) throw new Error(`No persona matches scenario ${s.id}`);
    return { id: s.id, title: s.title, personaId: persona.id, messages: s.messages, expect: s.expect };
  });
}

export function simCases(limit: number): EvalCase[] {
  const personas = new Map(getPersonas().map((p) => [p.id, p]));
  return simulateCatastrophe([...personas.values()], TORNADO).filter((t) => t.messages.length && t.replyTimes.length).slice(0, limit).map((t) => {
    const name = personas.get(t.personaId)!.name.split(" ")[0];
    const danger = t.injured || t.medicalUrgent;
    // The simulator sends some deliberately vague texts ("house is messed up. call me"); the right move is
    // to ask or escalate, so those are scored on the action, not on a severity the text cannot support.
    const vague = t.messages.join(" ").length < 60;
    return {
      id: `sim-${t.personaId}`, title: `Simulated ${t.damage} damage${danger ? ", injury/medical" : ""}`, personaId: t.personaId,
      messages: [`State Farm: ${name}, a tornado was reported near your home. Are you and your household safe? Reply SAFE, or tell us what happened and we'll start your claim.`, ...t.messages],
      // Ground truth is noisy (people downplay), so bands are wide; danger is the hard requirement.
      expect: {
        ...(vague ? { next_action: ["ask_customer", "human_review"] as const } : { severity: [Math.max(0, t.severity - 25), Math.min(100, t.severity + 25)] as [number, number] }),
        ...(danger ? { immediate_danger: true, reply_includes: [/\b911\b/] } : {}),
      },
      truth: { severity: t.severity, danger, route: t.expectedRoute },
    };
  });
}

export async function runCase(c: EvalCase): Promise<EvalResult> {
  const started = Date.now();
  const db = openOps(path.join(mkdtempSync(path.join(tmpdir(), "nightwatch-eval-")), "ops.db"));
  try {
    const { run } = receive(db, { channel: "simulation", address: `sim:${c.personaId}`, customerId: c.personaId,
      turns: c.messages.map((text, i) => ({ role: i === 0 ? "company" as const : "customer" as const, text })) });
    const claimed = claimRun(db, "eval")!;
    await processRun(claimed, "eval", defaultAgentDeps(db));
    await deliverPending(db, ADAPTERS);
    const view = runView(db, run!.id);
    const checks = view ? assess(view, c.expect, findPolicyholder({ personaId: c.personaId })) : [{ name: "run exists", pass: false }];
    return { case: c, checks, passed: checks.every((x) => x.pass), seconds: (Date.now() - started) / 1000, view };
  } finally {
    db.close();
  }
}

export async function runSuite(cases: EvalCase[], concurrency = 4, onResult?: (r: EvalResult) => void): Promise<EvalResult[]> {
  const results: EvalResult[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, async () => {
    while (next < cases.length) {
      const r = await runCase(cases[next++]);
      results.push(r);
      onResult?.(r);
    }
  }));
  return results.sort((a, b) => cases.indexOf(a.case) - cases.indexOf(b.case));
}

export function report(results: EvalResult[], dir = ".cache/evals"): { json: string; markdown: string; summary: Record<string, number> } {
  const checks = results.flatMap((r) => r.checks);
  const sim = results.filter((r) => r.case.truth && r.view?.decision);
  const err = sim.map((r) => Math.abs(r.view!.decision!.decision.severity - r.case.truth!.severity));
  const routed = sim.filter((r) => (r.view!.decision!.decision.next_action === "human_review") === (r.case.truth!.route === "human_review")).length;
  const dangers = sim.filter((r) => r.case.truth!.danger);
  const usage = results.flatMap((r) => (r.view?.usage ? [r.view.usage] : []));
  const summary = {
    scenarios: results.length, scenarios_passed: results.filter((r) => r.passed).length,
    checks: checks.length, checks_passed: checks.filter((c) => c.pass).length,
    ...(sim.length ? { sim_severity_mae: Math.round((err.reduce((a, b) => a + b, 0) / err.length) * 10) / 10,
      sim_routing_agreement: Math.round((routed / sim.length) * 100), sim_danger_cases: dangers.length,
      sim_danger_caught: dangers.filter((r) => r.view!.decision!.decision.immediate_danger).length } : {}),
    avg_seconds: Math.round(results.reduce((a, r) => a + r.seconds, 0) / Math.max(1, results.length) * 10) / 10,
    avg_tool_calls: Math.round(usage.reduce((a, u) => a + u.toolCalls, 0) / Math.max(1, usage.length) * 10) / 10,
    avg_revisions: Math.round(usage.reduce((a, u) => a + u.revisions, 0) / Math.max(1, usage.length) * 100) / 100,
  };
  const lines = [`# Nightwatch agent evaluation (${new Date().toISOString()})`, "", "| Metric | Value |", "|---|---|",
    ...Object.entries(summary).map(([k, v]) => `| ${k} | ${v} |`), "", "| Scenario | Result | Severity | Next action | Failed checks |", "|---|---|---|---|---|",
    ...results.map((r) => { const d = r.view?.decision?.decision; return `| ${r.case.id} | ${r.passed ? "pass" : "FAIL"} | ${d?.severity ?? "-"}${r.case.truth ? ` (truth ${r.case.truth.severity})` : ""} | ${d?.next_action ?? "-"} | ${r.checks.filter((c) => !c.pass).map((c) => `${c.name}${c.detail ? `: ${c.detail}` : ""}`).join("; ").replace(/\|/g, "/").slice(0, 300)} |`; })];
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const json = path.join(dir, `eval-${stamp}.json`);
  const markdown = path.join(dir, `eval-${stamp}.md`);
  writeFileSync(json, JSON.stringify({ summary, results: results.map((r) => ({ ...r, view: r.view && { ...r.view, events: r.view.events.map((e) => ({ seq: e.seq, actor: e.actor, type: e.type, title: e.title, ms: e.ms })) } })) }, null, 2));
  writeFileSync(markdown, lines.join("\n") + "\n");
  return { json, markdown, summary };
}
