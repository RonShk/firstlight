// Records one coverage finding. Flat arguments (no nested objects) because the model formats those
// reliably; the citation is checked immediately against what was retrieved in this run, so a bad quote
// is fixed right away instead of failing the final decision. Recording the same item again replaces it.
import { z } from "zod";
import { checkFinding, locateQuote } from "../../agent/finalize";
import { CoverageStatus, type Finding } from "../../agent/schemas";
import { messages } from "../../cases/repository";
import { getRun } from "../../cases/runs";
import { defineTool, ToolError } from "../types";

const nullish = (v: unknown) => (v === undefined || v === "" || (typeof v === "string" && /^(null|none|n\/a)$/i.test(v.trim())) ? null : v);

export const recordFinding = defineTool({
  name: "record_finding",
  description: "Record one coverage finding for a reported loss or need, using references to passages you retrieved. " +
    "Use covered or not_covered when proven: supply chunk_id for the coverage grant and chunk_id_2 for exclusions/conditions (the server copies the actual text; quotes are optional); include reported_fact and conditions_explanation. Otherwise use unclear. Legacy likely statuses need a quote. Call once per item; calling again with the same item replaces it. Returns issues to fix, if any.",
  effect: "read",
  timeoutMs: 2_000,
  input: {
    item: z.string().trim().min(2).max(200).describe("The reported loss or need, e.g. 'Roof partly torn off'."),
    coverage: z.preprocess((v) => nullish(v) ?? "Not determined", z.string().trim().min(2).max(80)).describe("e.g. 'Coverage A Dwelling', 'Coverage C Loss of Use', 'Comprehensive'."),
    policy_id: z.preprocess(nullish, z.string().nullable()).optional().describe("The customer's policy id, or null when they have no policy for this."),
    status: CoverageStatus,
    reported_fact: z.string().trim().min(8).max(300).optional().describe("For covered/not_covered: exact excerpt from a customer message supporting this loss, not outreach or profile data."),
    conditions_explanation: z.string().trim().min(10).max(1000).optional().describe("For covered/not_covered: explain why the second quoted exclusion/condition applies or does not apply to the reported facts. Mention material unknowns; if any affect coverage use unclear."),
    explanation: z.string().trim().min(5).max(700).describe("One to three sentences: why, conditions, what is still unknown."),
    chunk_id: z.preprocess(nullish, z.string().nullable()).optional().describe("chunk_id of the passage you quote."),
    quote: z.preprocess(nullish, z.string().trim().min(20).max(12000).nullable()).optional().describe("Exact words from that passage. For covered/not_covered, quote complete sentences or clauses with their conditions; no ellipses."),
    chunk_id_2: z.preprocess(nullish, z.string().nullable()).optional().describe("Required for covered/not_covered: chunk id of the exclusion or condition checked."),
    quote_2: z.preprocess(nullish, z.string().trim().min(20).max(12000).nullable()).optional().describe("Required for covered/not_covered: exact complete exclusion or condition text from chunk_id_2. No ellipses."),
  },
  outputSchema: z.object({ recorded: z.literal(true), finding_number: z.number(), findings_recorded: z.array(z.string()) }),
  title: (i) => `Finding: ${i.item} → ${i.status.replace("_", " ")}`.slice(0, 160),
  async execute(input, ctx) {
    const definitive = input.status === "covered" || input.status === "not_covered";
    // The server copies proof from retrieved passages. The model selects references and
    // explains the conclusion; it need not transcribe long legal clauses accurately.
    const citations = [[input.chunk_id, input.quote], [input.chunk_id_2, input.quote_2]]
      .map(([chunk_id, quote]) => ({ chunk_id, quote: definitive && chunk_id ? ctx.evidence.get(chunk_id)?.text ?? quote : quote }))
      .filter((c): c is { chunk_id: string; quote: string } => !!c.chunk_id && !!c.quote);
    if (!definitive && ((input.chunk_id && !input.quote) || (!input.chunk_id && input.quote))) throw new ToolError("invalid_input", "Give chunk_id and quote together.");
    const finding: Finding = { item: input.item, coverage: input.coverage, policy_id: input.policy_id ?? null, status: input.status,
      explanation: input.explanation, citations, reported_fact: input.reported_fact, conditions_explanation: input.conditions_explanation };
    const throughSeq = getRun(ctx.db, ctx.runId)?.throughSeq ?? 0;
    const reportedText = messages(ctx.db, ctx.caseId).filter((m) => m.role === "customer" && m.seq <= throughSeq).map((m) => m.text).join("\n");
    const { issues, finding: checked } = checkFinding(finding, `This finding ("${input.item}")`, ctx.evidence, ctx.customer, reportedText);
    const key = input.item.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (issues.length) {
      // Preserve the assessed item when proof needs repair. Otherwise the model can finish
      // with an empty findings array after rejected attempts, silently losing the assessment.
      if (!ctx.findings.has(key)) ctx.findings.set(key, {
        ...finding, status: "unclear",
        explanation: "The agent could not verify a coverage decision for this reported loss. Review the policy clauses and exclusions before confirming coverage.",
        conditions_explanation: undefined,
        citations: finding.citations.filter((c) => locateQuote(ctx.evidence, c.chunk_id, c.quote)),
      });
      throw new ToolError("invalid_input", `Saved this item as unclear until proof is corrected. Fix and call record_finding again with the same item: ${issues.join(" ")}`);
    }
    ctx.findings.set(key, checked);
    return { recorded: true as const, finding_number: [...ctx.findings.keys()].indexOf(key) + 1, findings_recorded: [...ctx.findings.values()].map((f) => f.item) };
  },
});
