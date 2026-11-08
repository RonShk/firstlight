// Deterministic checks on a finished run. Every run is also checked for invariants that must always
// hold: it completed, every citation was verified, and the reply promises nothing that did not happen.
import type { Decision } from "@/agent/schemas";
import { validateDecision } from "@/agent/finalize";
import type { PolicyholderFile } from "@/customers/directory";
import type { RunView } from "@/cases/views";

export interface Expectation {
  severity?: [number, number];
  immediate_danger?: boolean;
  next_action?: Decision["next_action"][];
  tools_called?: string[];
  tools_not_called?: string[];
  findings?: { item?: RegExp; coverage?: RegExp; status: Decision["findings"][number]["status"][] }[];
  reply_includes?: RegExp[];
  reply_excludes?: RegExp[];
}

export interface Check { name: string; pass: boolean; detail?: string }

export function assess(view: RunView, expect: Expectation, customer: PolicyholderFile | null): Check[] {
  const checks: Check[] = [];
  const check = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, ...(detail && !pass ? { detail } : {}) });
  check("run completed", view.status === "completed", `${view.status}${view.error ? `: ${view.error}` : ""}`);
  const d = view.decision?.decision;
  if (!d) return checks;
  const tools = new Set(view.events.filter((e) => e.type === "tool.completed").map((e) => (e.detail as { tool: string }).tool));
  const cited = d.findings.reduce((n, f) => n + f.citations.length, 0);
  check("all citations verified", view.decision!.citations.length === cited, `${view.decision!.citations.length}/${cited} verified`);
  const replyIssues = validateDecision({ ...d, findings: [] }, new Map(), customer).issues;
  check("reply passes promise/format checks", replyIssues.length === 0, replyIssues.join(" | "));
  check("reply delivered or held", ["sent", "held"].includes(view.reply?.status ?? ""), view.reply?.status ?? "no reply");

  if (expect.severity) check(`severity in [${expect.severity}]`, d.severity >= expect.severity[0] && d.severity <= expect.severity[1], `got ${d.severity}`);
  if (expect.immediate_danger !== undefined) check(`immediate_danger = ${expect.immediate_danger}`, d.immediate_danger === expect.immediate_danger, `got ${d.immediate_danger}`);
  if (expect.next_action) check(`next_action in ${expect.next_action.join("|")}`, expect.next_action.includes(d.next_action), `got ${d.next_action}`);
  for (const t of expect.tools_called ?? []) check(`called ${t}`, tools.has(t), `tools: ${[...tools].join(", ")}`);
  for (const t of expect.tools_not_called ?? []) check(`did not call ${t}`, !tools.has(t));
  for (const f of expect.findings ?? []) {
    const match = d.findings.find((x) => (!f.item || f.item.test(x.item)) && (!f.coverage || f.coverage.test(x.coverage)));
    check(`finding ${f.item ?? f.coverage} is ${f.status.join("|")}`, !!match && f.status.includes(match.status),
      match ? `got ${match.status}` : `no matching finding among: ${d.findings.map((x) => `${x.item} / ${x.coverage}`).join("; ")}`);
  }
  for (const r of expect.reply_includes ?? []) check(`reply matches ${r}`, r.test(d.reply));
  for (const r of expect.reply_excludes ?? []) check(`reply avoids ${r}`, !r.test(d.reply), d.reply.slice(0, 160));
  return checks;
}
