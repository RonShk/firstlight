// Run sample texts through the full pipeline against the live model (acknowledgment -> danger check
// -> read -> per-item policy check -> update), and compare with each sample's `expect`.
// Prints a one-line summary per run, then the full PipelineResult JSON.
// Usage:
//   npm run agent:samples -- --text "hello"            any text you type
//   npm run agent:samples -- rivera-hurricane          one or more sample ids (none = all samples)
//   npm run agent:samples -- --runs 3 --out results.json
// Needs .env.local; without a model each run ends agent_unavailable.

import { existsSync, writeFileSync } from "node:fs";
import type { ChatOptions, ModelClient } from "../src/lib/agent/nemotron";
import { DANGER_SYSTEM, EXTRACTION_SYSTEM } from "../src/lib/agent/prompts";
import { SAMPLE_TEXTS } from "./samples";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface CallStat { kind: string; seconds: number; error?: string }

/** Wraps the real client to time each chat call and record failures (never the prompt or keys). */
function instrument(client: ModelClient, stats: CallStat[]): ModelClient {
  return {
    ...client,
    async chat(system: string, user: string, options?: ChatOptions) {
      const kind = system === DANGER_SYSTEM ? "danger" : system === EXTRACTION_SYSTEM ? "extract" : "coverage";
      const t0 = performance.now();
      try {
        const reply = await client.chat(system, user, options);
        stats.push({ kind, seconds: (performance.now() - t0) / 1000 });
        return reply;
      } catch (e) {
        stats.push({ kind, seconds: (performance.now() - t0) / 1000, error: (e as Error).message });
        throw e;
      }
    },
  };
}

async function main() {
  const { defaultDeps, handleIncomingText } = await import("../src/lib/agent/pipeline");
  const runs = Number(arg("--runs") ?? 1);
  const outFile = arg("--out");
  const ids = process.argv.slice(2).filter((a, i, all) => !a.startsWith("--") && !all[i - 1]?.startsWith("--"));
  const text = arg("--text");
  const samples = text
    ? [{ id: "custom", from: "+15550100099", text, expect: { triage: null, claim_types: [], note: "your text" } }]
    : SAMPLE_TEXTS.filter((s) => !ids.length || ids.includes(s.id));
  const all: unknown[] = [];

  for (const sample of samples) {
    console.log(`\n===== ${sample.id}  expected: triage ${sample.expect.triage ?? "none"}, ${sample.expect.claim_types.join("+") || "-"}; ${sample.expect.note}`);
    for (let run = 1; run <= runs; run++) {
      const stats: CallStat[] = [];
      const base = defaultDeps();
      const quiet = { send: async () => {} };
      const t0 = performance.now();
      const out = await handleIncomingText({ from: sample.from, text: sample.text },
                                           { ...base, client: instrument(base.client, stats), notifier: quiet });
      const seconds = (performance.now() - t0) / 1000;
      const r = out.result;
      const triage = r.status === "complete" ? r.triage : r.status === "emergency" ? 4 : null;
      const ok = text ? true : triage === sample.expect.triage;
      const firstReply = out.messages.find((m) => m.kind !== "ack");
      const replyAfter = firstReply ? (Date.parse(firstReply.sent_at) - Date.parse(out.received_at)) / 1000 : null;
      const byKind = (k: string) => stats.filter((s) => s.kind === k);
      const fmt = (k: string) => byKind(k).length ? `${k} ${byKind(k).length}x max ${Math.max(...byKind(k).map((s) => s.seconds)).toFixed(1)}s` : "";
      console.log(`--- run ${run}: ${r.status} triage=${triage ?? "-"} ${text ? "" : ok ? "OK" : "MISMATCH"} | total ${seconds.toFixed(1)}s, first reply after ack ${replyAfter?.toFixed(1)}s | ${["danger", "extract", "coverage"].map(fmt).filter(Boolean).join(", ")}`);
      for (const s of stats.filter((s) => s.error)) console.log(`    model error (${s.kind}): ${s.error}`);
      if (r.status === "emergency") console.log(`    reason: ${r.reason}`);
      if (r.status === "agent_unavailable") console.log(`    error: ${r.error}`);
      if (r.status === "complete") {
        console.log(`    types=${r.claim_types.join("+")} claimed=${r.claim_amount_usd} approved=$${r.approved_amount_usd}`);
        console.log(`    summary: ${r.summary}`);
        for (const i of r.items) {
          console.log(`    [${i.triage}] ${i.approved ? "APPROVED" : "review  "} ${i.category.padEnd(14)} $${i.estimated_amount_usd ?? "?"} ${i.description} :: ${i.reason}`);
          if (i.code_override) console.log(`         code override; model said ${i.model_decision?.decision}: ${i.model_decision?.reason}`);
          for (const c of i.citations) console.log(`         ${c.doc_id} | ${c.section} | "${c.quote.slice(0, 160)}"`);
        }
      }
      for (const m of out.messages) console.log(`    sms(${m.kind}): ${m.body}`);
      console.log(JSON.stringify(out, null, 2));
      all.push({ sample: sample.id, run, seconds, calls: stats, ...out });
    }
  }
  if (outFile) writeFileSync(outFile, JSON.stringify(all, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
