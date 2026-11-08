// Usage: npm run evals [-- --suite core|sim|all] [--sim 12] [--only id1,id2] [--concurrency 4]
import { existsSync } from "node:fs";
import { coreCases, report, runSuite, simCases } from "../src/evals/runner";

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const suite = arg("suite") ?? "core";
  let cases = [...(suite !== "sim" ? coreCases() : []), ...(suite !== "core" ? simCases(Number(arg("sim") ?? 12)) : [])];
  const only = arg("only")?.split(",");
  if (only) cases = cases.filter((c) => only.includes(c.id));
  console.log(`running ${cases.length} scenario(s)`);
  const results = await runSuite(cases, Number(arg("concurrency") ?? 4), (r) =>
    console.log(`${r.passed ? "PASS" : "FAIL"} ${r.case.id} (${r.seconds.toFixed(0)}s)${r.passed ? "" : ` · ${r.checks.filter((c) => !c.pass).map((c) => `${c.name}${c.detail ? ` [${c.detail}]` : ""}`).join("; ")}`}`));
  const { json, markdown, summary } = report(results);
  console.log(summary);
  console.log(`report: ${markdown}\n        ${json}`);
  process.exitCode = results.every((r) => r.passed) ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(1); });
