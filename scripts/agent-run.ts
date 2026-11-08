// Run one message through the full path (intake -> queue -> worker -> Nemotron tool loop -> outbox ->
// simulator delivery) against a scratch database, and print the audit timeline.
// Usage: npm run agent:run -- --persona PH-0008 "half the roof is gone and water is coming in"
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openOps } from "../src/cases/db";
import { caseEvents } from "../src/cases/events";
import { receive } from "../src/cases/intake";
import { claimRun } from "../src/cases/runs";
import { runView } from "../src/cases/views";
import { deliverPending } from "../src/delivery/outbox";
import { getPersonas } from "../src/lib/sim/personas";
import { ADAPTERS, defaultAgentDeps, processRun } from "../src/workers/agent-worker";

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const args = process.argv.slice(2);
  const i = args.indexOf("--persona");
  const personaId = i >= 0 ? args.splice(i, 2)[1] : getPersonas().find((p) => p.policies.some((x) => x.home))!.id;
  const text = args.join(" ") || "The tornado ripped part of our roof off and rain is coming into the kids' bedroom. Is this covered?";
  const db = openOps(path.join(mkdtempSync(path.join(tmpdir(), "nightwatch-")), "ops.db"));
  const { run, case: c } = receive(db, { channel: "simulation", address: `sim:${personaId}`, customerId: personaId,
    turns: [{ role: "company", text: "State Farm: a tornado was reported near your home. Are you and your household safe?" }, { role: "customer", text }] });
  const claimed = claimRun(db, "cli")!;
  const started = Date.now();
  await processRun(claimed, "cli", defaultAgentDeps(db));
  await deliverPending(db, ADAPTERS);
  for (const e of caseEvents(db, c.id)) console.log(`${String(e.seq).padStart(3)} ${e.actor.padEnd(9)} ${e.title}${e.ms != null ? ` (${e.ms} ms)` : ""}`);
  const view = runView(db, run!.id)!;
  console.log(`\nstatus ${view.status} in ${((Date.now() - started) / 1000).toFixed(1)}s · usage ${JSON.stringify(view.usage)}`);
  console.log(`decision ${JSON.stringify(view.decision?.decision, null, 2)}`);
  console.log(`reply [${view.reply?.status}]: ${view.reply?.body}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
