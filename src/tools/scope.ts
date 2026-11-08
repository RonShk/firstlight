// Which documents a run may read: only the forms behind the verified customer's own policies.
import { policyDocIds, type PolicyOnFile } from "../customers/directory";
import { ToolError, type Evidence, type TrustedRunContext } from "./types";
import type { StoredChunk } from "../knowledge/store";

export interface Scope {
  policies: PolicyOnFile[];
  docIds: string[];
  policyOfDoc: Map<string, PolicyOnFile>;
}

export function policyScope(ctx: TrustedRunContext, policyId?: string | null): Scope {
  if (!ctx.customer) throw new ToolError("forbidden", "No verified policyholder on this case. Ask the customer for their policy details instead of searching.");
  const policies = policyId ? ctx.customer.policies.filter((p) => p.policy_id === policyId) : ctx.customer.policies;
  if (policyId && !policies.length) {
    throw new ToolError("not_found", `Policy ${policyId} is not one of this customer's policies (${ctx.customer.policies.map((p) => p.policy_id).join(", ") || "none"})`);
  }
  const policyOfDoc = new Map<string, PolicyOnFile>();
  for (const p of policies) for (const d of policyDocIds([p])) policyOfDoc.set(d, p);
  return { policies, docIds: [...policyOfDoc.keys()], policyOfDoc };
}

export function requireKnowledge(ctx: TrustedRunContext) {
  if (!ctx.knowledge) throw new ToolError("unavailable", "Policy knowledge base is not available");
  return ctx.knowledge;
}

/** Record a passage as retrieved evidence and return its model-facing form. */
export function remember(ctx: TrustedRunContext, scope: Scope, c: StoredChunk, maxChars = 1400) {
  const policy = scope.policyOfDoc.get(c.doc_id) ?? null;
  const doc = ctx.knowledge!.documents().find((d) => d.doc_id === c.doc_id);
  const evidence: Evidence = { chunk_id: c.chunk_id, doc_id: c.doc_id, policy_id: policy?.policy_id ?? null,
    form_number: doc?.form_number ?? "", source_type: doc?.source_type ?? "unknown", section: c.section, page: c.page, text: c.text };
  ctx.evidence.set(c.chunk_id, evidence);
  return { chunk_id: c.chunk_id, policy_id: evidence.policy_id, form: doc ? `${doc.title} ${doc.form_number}` : c.doc_id,
    source_type: doc?.source_type ?? null, section: c.section, page: c.page,
    text: c.text.length > maxChars ? `${c.text.slice(0, maxChars)} [...truncated; use read_section for the full passage]` : c.text };
}
