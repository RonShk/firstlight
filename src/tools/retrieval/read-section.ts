import { z } from "zod";
import { policyScope, remember, requireKnowledge } from "../scope";
import { defineTool, ToolError } from "../types";
import { Passage } from "./search-policies";

export const readSection = defineTool({
  name: "read_section",
  description: "Read policy text around a passage you already found: the neighbouring passages (mode 'neighbors'), or every passage under the same heading (mode 'section'). " +
    "Use it when a clause continues, refers to an exclusion or definition, or a search result was truncated.",
  effect: "read",
  timeoutMs: 3_000,
  input: {
    chunk_id: z.string().describe("A chunk_id returned by search_policy or read_section."),
    mode: z.enum(["neighbors", "section"]).optional().describe("Default 'neighbors'."),
    window: z.number().int().min(1).max(3).optional().describe("Neighbours on each side (default 1)."),
  },
  outputSchema: z.object({ passages: z.array(Passage), note: z.string().optional() }),
  title: (i) => `Read ${i.mode === "section" ? "full section" : "surrounding text"} of ${i.chunk_id}`,
  async execute(input, ctx) {
    const store = requireKnowledge(ctx);
    const scope = policyScope(ctx);
    const chunk = store.chunk(input.chunk_id);
    if (!chunk) throw new ToolError("not_found", `No passage ${input.chunk_id}`);
    if (!scope.docIds.includes(chunk.doc_id)) throw new ToolError("forbidden", "That passage is not from one of this customer's policies.");
    let chunks = input.mode === "section" ? store.section(chunk.doc_id, chunk.section) : [];
    let note: string | undefined;
    if (chunks.length > 6) {
      const at = chunks.findIndex((c) => c.chunk_id === chunk.chunk_id);
      chunks = chunks.slice(Math.max(0, at - 2), Math.max(0, at - 2) + 6);
      note = "Section is long; showing the 6 passages around the requested one.";
    }
    if (!chunks.length) {
      const w = input.window ?? 1;
      chunks = store.chunksOf(chunk.doc_id, chunk.ord - w, chunk.ord + w);
    }
    return { passages: chunks.map((c) => remember(ctx, scope, c, 2000)), ...(note ? { note } : {}) };
  },
});
