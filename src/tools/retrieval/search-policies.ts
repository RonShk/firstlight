import { z } from "zod";
import { hybridSearch } from "../../knowledge/search";
import { policyScope, remember, requireKnowledge } from "../scope";
import { defineTool, ToolError } from "../types";

const Passage = z.object({
  chunk_id: z.string(), policy_id: z.string().nullable(), form: z.string(), source_type: z.string().nullable(),
  section: z.string(), page: z.number().nullable(), text: z.string(),
});

export const searchPolicies = defineTool({
  name: "search_policy",
  description: "Hybrid search (BM25 + Nemotron embeddings, fused, then Nemotron reranker) over the wording of THIS customer's own policy forms. " +
    "Phrase queries in policy language (e.g. 'Coverage A dwelling windstorm hail losses insured', 'Additional Living Expense uninhabitable'). " +
    "Search again with different wording when results do not answer the question; use read_section to read around a result.",
  effect: "read",
  timeoutMs: 20_000,
  retries: 1,
  input: {
    query: z.string().trim().min(3).max(400).describe("What to find, in policy terminology."),
    policy_id: z.string().optional().describe("Restrict to one of the customer's policies (from get_policies). Omit to search all of them."),
    top_k: z.number().int().min(1).max(8).optional().describe("Passages to return (default 5)."),
  },
  outputSchema: z.object({
    results: z.array(Passage.extend({ score: z.number(), signals: z.record(z.string(), z.number().nullable()) })),
    retrieval: z.object({ methods: z.array(z.string()), degraded: z.array(z.string()), searched_policies: z.array(z.string()) }),
  }),
  title: (i) => `Search policy text: "${i.query}"${i.policy_id ? ` in ${i.policy_id}` : ""}`,
  async execute(input, ctx) {
    const store = requireKnowledge(ctx);
    const scope = policyScope(ctx, input.policy_id);
    if (!scope.docIds.length) throw new ToolError("not_found", "The customer has no policies to search.");
    const result = await hybridSearch(store, input.query, scope.docIds, {
      limit: input.top_k ?? 5, embedder: ctx.embedder, reranker: ctx.reranker, signal: ctx.signal,
    });
    return {
      results: result.hits.map((h) => ({ ...remember(ctx, scope, h.chunk, 1100), score: h.score, signals: h.signals })),
      retrieval: { methods: result.methods, degraded: result.degraded, searched_policies: scope.policies.map((p) => p.policy_id) },
    };
  },
});

export { Passage };
