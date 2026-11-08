// Finds households whose latest agent review is unreliable and writes them to
// src/lib/claims/excluded-households.json; the dashboard and the demo replay hide those households.
// A review is unreliable when the run failed, the verifier did not approve it, reported damage got no
// coverage finding, a finding is a placeholder, or it quotes a dollar figure that is neither in the
// policy declarations nor in the customer's own messages (e.g. "$520" for a $5,200 deductible).
// Usage: npm run audit:households [-- --db local.db]
import { existsSync, writeFileSync } from "node:fs";
import { openOps } from "../src/cases/db";
import { caseRuns } from "../src/cases/runs";
import { messages } from "../src/cases/repository";
import { getPersona } from "../src/lib/sim/personas";
import { KnowledgeStore } from "../src/knowledge/store";
import { policyDocIds, findPolicyholder } from "../src/customers/directory";
import type { StoredDecision } from "../src/workers/agent-worker";

const OUT = "src/lib/claims/excluded-households.json";

function main() {
  const i = process.argv.indexOf("--db");
  const file = i > 0 ? process.argv[i + 1] : "local.db";
  if (!existsSync(file)) throw new Error(`No database at ${file}`);
  const db = openOps(file);
  // Fixed amounts printed in the policy wording itself (e.g. "$1,000 for debris removal") are legitimate.
  const kb = existsSync("data/knowledge.db") ? new KnowledgeStore("data/knowledge.db") : null;
  const formAmounts = new Map<string, Set<number>>();
  const amountsIn = (docId: string) => {
    if (!formAmounts.has(docId)) {
      const set = new Set<number>();
      for (const r of kb?.sql.all<{ text: string }>("SELECT text FROM chunks WHERE doc_id=?", docId) ?? []) {
        for (const m of r.text.matchAll(/\$\s?([\d,]+)/g)) set.add(Number(m[1].replace(/,/g, "")));
      }
      formAmounts.set(docId, set);
    }
    return formAmounts.get(docId)!;
  };
  const excluded: Record<string, { name: string; reasons: string[] }> = {};
  for (const c of db.all<{ id: string; customer_id: string | null }>("SELECT id, customer_id FROM cases WHERE channel='simulation'")) {
    const persona = c.customer_id ? getPersona(c.customer_id) : undefined;
    if (!persona) continue;
    const allowed = new Set<number>();
    for (const pol of persona.policies) {
      if (pol.home) Object.values(pol.home).forEach((v) => allowed.add(v));
      if (pol.auto) { allowed.add(pol.auto.collisionDeductible); allowed.add(pol.auto.comprehensiveDeductible); pol.auto.vehicles.forEach((v) => allowed.add(v.value)); }
      if (pol.umbrellaLimit) allowed.add(pol.umbrellaLimit);
    }
    for (const doc of policyDocIds(findPolicyholder({ personaId: persona.id })?.policies ?? [])) for (const n of amountsIn(doc)) allowed.add(n);
    const said = messages(db, c.id).filter((m) => m.role === "customer").map((m) => m.text).join(" ");
    for (const m of said.matchAll(/\$?([\d,]{3,})/g)) allowed.add(Number(m[1].replace(/,/g, "")));
    const last = caseRuns(db, c.id).at(-1);
    const stored = last?.decision as StoredDecision | null;
    const d = stored?.decision;
    const reasons: string[] = [];
    if (!last || last.status !== "completed" || !d) reasons.push(`run ${last?.status ?? "missing"}`);
    else {
      if (!stored!.verified) reasons.push("not approved by the verifier");
      if (d.severity >= 30 && !d.immediate_danger && !d.findings.length) reasons.push("damage reported but no coverage finding");
      if (/investigation limit|could not verify/i.test(JSON.stringify(d.findings))) reasons.push("placeholder finding");
      const text = `${d.summary} ${d.reply} ${d.findings.map((f) => f.explanation).join(" ")}`;
      const wrong = [...text.matchAll(/\$([\d,]+(?:\.\d+)?)/g)].map((m) => Number(m[1].replace(/,/g, ""))).filter((n) => n >= 100 && !allowed.has(n));
      if (wrong.length) reasons.push(`dollar figures not in the policy: ${[...new Set(wrong)].map((n) => `$${n.toLocaleString("en-US")}`).join(", ")}`);
    }
    if (reasons.length) excluded[persona.id] = { name: persona.name, reasons };
  }
  writeFileSync(OUT, `${JSON.stringify(excluded, null, 2)}\n`);
  console.log(`${Object.keys(excluded).length} households excluded -> ${OUT}`);
}

main();
