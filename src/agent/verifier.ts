// A second Nemotron agent with a different role: it audits the proposed decision against the cited
// passages before anything reaches the customer (writer -> editor). It has no tools except its verdict.
import { z } from "zod";
import type { PolicyholderFile } from "../customers/directory";
import type { CaseMessage } from "../cases/repository";
import { functionSpec } from "../tools/registry";
import type { Evidence } from "../tools/types";
import { VERIFIER_INSTRUCTIONS } from "./instructions";
import type { AgentModel } from "./model";
import { Verdict, type Decision } from "./schemas";

export async function verifyDecision(model: AgentModel, input: {
  decision: Decision; transcript: CaseMessage[]; customer: PolicyholderFile | null; evidence: Map<string, Evidence>; signal: AbortSignal;
}): Promise<{ verdict: Verdict; usage: { promptTokens: number; completionTokens: number } }> {
  const cited = [...new Set(input.decision.findings.flatMap((f) => f.citations.map((c) => c.chunk_id)))]
    .map((id) => input.evidence.get(id)).filter(Boolean) as Evidence[];
  const citedDocs = new Set(cited.map((e) => e.doc_id));
  const surrounding = [...input.evidence.values()].filter((e) => citedDocs.has(e.doc_id) && !cited.some((c) => c.chunk_id === e.chunk_id));
  const payload = {
    customer_messages: input.transcript.filter((m) => m.role === "customer").map((m) => m.text),
    declarations: input.customer?.policies.map((p) => ({ policy_id: p.policy_id, line: p.line, form: p.form, ...(p.home ?? p.auto ?? { umbrella_limit: p.umbrella_limit }) })) ?? "no verified policyholder",
    household: input.customer?.members.map((m) => ({ age: m.age, relation: m.relation, medical_needs: m.medical_needs, limited_mobility: m.limited_mobility })) ?? null,
    proposed_decision: input.decision,
    cited_passages: cited.map((e) => ({ chunk_id: e.chunk_id, section: e.section, source_type: e.source_type, text: e.text })),
    surrounding_retrieved_passages: surrounding.slice(0, 12).map((e) => ({ chunk_id: e.chunk_id, section: e.section, text: e.text })),
  };
  const spec = functionSpec("submit_verdict", "Submit your review verdict.", Verdict);
  const turn = await model.turn(
    [{ role: "system", content: VERIFIER_INSTRUCTIONS }, { role: "user", content: JSON.stringify(payload) }],
    // Unpinned on purpose: a named tool_choice triggers slow schema-guided decoding on vLLM.
    [spec], "auto", input.signal);
  const call = turn.toolCalls.find((t) => t.name === "submit_verdict");
  const raw = call ? safeJson(call.arguments) : null;
  // Long reviewer explanations are still actionable objections, not verifier outages.
  // Keep the strict model-facing schema; bound prose before validating the returned verdict.
  const normalized = raw && typeof raw === "object" && "issues" in raw && Array.isArray(raw.issues)
    ? { ...raw, issues: raw.issues.map((issue: unknown) => typeof issue === "string" ? issue.trim().slice(0, 400) : issue) } : raw;
  const parsed = call ? Verdict.safeParse(normalized) : null;
  if (!parsed?.success) throw new Error(`Verifier returned no valid verdict${parsed ? `: ${z.prettifyError(parsed.error).slice(0, 200)}` : ""}`);
  return { verdict: parsed.data, usage: turn.usage };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}
