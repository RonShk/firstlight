// Records one coverage finding. Flat arguments (no nested objects) because the model formats those
// reliably; the citation is checked immediately against what was retrieved in this run, so a bad quote
// is fixed right away instead of failing the final decision. Recording the same item again replaces it.
import { z } from "zod";
import { checkFinding } from "../../agent/finalize";
import type { Finding } from "../../agent/schemas";
import { defineTool, ToolError } from "../types";

const nullish = (v: unknown) => (v === undefined || v === "" || (typeof v === "string" && /^(null|none|n\/a)$/i.test(v.trim())) ? null : v);

export const recordFinding = defineTool({
  name: "record_finding",
  description: "Record one coverage finding for a reported loss or need, with up to two verbatim quotes from passages you retrieved. " +
    "likely_covered and likely_excluded need a quote. Call once per item; calling again with the same item replaces it. Returns issues to fix, if any.",
  effect: "read",
  timeoutMs: 2_000,
  input: {
    item: z.string().trim().min(2).max(200).describe("The reported loss or need, e.g. 'Roof partly torn off'."),
    coverage: z.preprocess((v) => nullish(v) ?? "Not determined", z.string().trim().min(2).max(80)).describe("e.g. 'Coverage A Dwelling', 'Coverage C Loss of Use', 'Comprehensive'."),
    policy_id: z.preprocess(nullish, z.string().nullable()).optional().describe("The customer's policy id, or null when they have no policy for this."),
    status: z.enum(["likely_covered", "likely_excluded", "unclear", "no_policy"]),
    explanation: z.string().trim().min(5).max(700).describe("One to three sentences: why, conditions, what is still unknown."),
    chunk_id: z.preprocess(nullish, z.string().nullable()).optional().describe("chunk_id of the passage you quote."),
    quote: z.preprocess(nullish, z.string().trim().min(20).max(600).nullable()).optional().describe("Exact words from that passage (use ... to skip words)."),
    chunk_id_2: z.preprocess(nullish, z.string().nullable()).optional(),
    quote_2: z.preprocess(nullish, z.string().trim().min(20).max(600).nullable()).optional(),
  },
  outputSchema: z.object({ recorded: z.literal(true), finding_number: z.number(), findings_recorded: z.array(z.string()) }),
  title: (i) => `Finding: ${i.item} → ${i.status.replace("_", " ")}`.slice(0, 160),
  async execute(input, ctx) {
    const citations = [[input.chunk_id, input.quote], [input.chunk_id_2, input.quote_2]]
      .filter(([c, q]) => c && q).map(([chunk_id, quote]) => ({ chunk_id: chunk_id!, quote: quote! }));
    if ((input.chunk_id && !input.quote) || (!input.chunk_id && input.quote)) throw new ToolError("invalid_input", "Give chunk_id and quote together.");
    const finding: Finding = { item: input.item, coverage: input.coverage, policy_id: input.policy_id ?? null, status: input.status,
      explanation: input.explanation, citations };
    const { issues, finding: checked } = checkFinding(finding, `This finding ("${input.item}")`, ctx.evidence, ctx.customer);
    if (issues.length) throw new ToolError("invalid_input", `Not recorded. Fix and call record_finding again: ${issues.join(" ")}`);
    const key = input.item.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    ctx.findings.set(key, checked);
    return { recorded: true as const, finding_number: [...ctx.findings.keys()].indexOf(key) + 1, findings_recorded: [...ctx.findings.values()].map((f) => f.item) };
  },
});
