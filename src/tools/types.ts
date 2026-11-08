// The contract every tool implements. Tools perform one operation and return structured results;
// they never write prompts or call each other. Identity comes from TrustedRunContext, which the
// runtime builds from the case record: the model cannot switch customers by passing an id.
import { z } from "zod";
import type { Sqlite } from "../db/sqlite";
import type { PolicyholderFile } from "../customers/directory";
import type { Embedder } from "../knowledge/embeddings";
import type { Reranker } from "../knowledge/rerank";
import type { KnowledgeStore } from "../knowledge/store";
import type { Finding } from "../agent/schemas";

/** A policy passage the agent actually retrieved during this run; the only thing it may cite. */
export interface Evidence {
  chunk_id: string;
  doc_id: string;
  policy_id: string | null;
  form_number: string;
  /** Provenance of the document, e.g. an official form vs. a web overview or court opinion. */
  source_type: string;
  section: string;
  page: number | null;
  text: string;
}

export interface TrustedRunContext {
  caseId: string;
  runId: string;
  db: Sqlite;
  customer: PolicyholderFile | null;
  knowledge: KnowledgeStore | null;
  embedder: Embedder | null;
  reranker: Reranker | null;
  evidence: Map<string, Evidence>;
  /** Coverage findings recorded so far in this run, keyed by normalized item. */
  findings: Map<string, Finding>;
  signal: AbortSignal;
}

export type ToolErrorCode = "invalid_input" | "forbidden" | "not_found" | "unavailable" | "timeout" | "failed";

export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ToolDefinition<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  inputSchema: I;
  outputSchema: O;
  effect: "read" | "write";
  timeoutMs: number;
  /** Retries for transient failures (read tools only). */
  retries?: number;
  /** Required for write tools: the same key means the same effect, so a retried run never duplicates it. */
  idempotencyKey?(input: z.infer<I>, context: TrustedRunContext): string;
  /** One line for the audit timeline. */
  title(input: z.infer<I>): string;
  execute(input: z.infer<I>, context: TrustedRunContext): Promise<z.infer<O>>;
}

export const purpose = z.string().trim().min(3).max(300)
  .describe("One sentence, for the human reviewer, explaining why this action is useful right now.");

/** Every tool's input starts with `purpose`. */
export function defineTool<S extends z.ZodRawShape, O extends z.ZodType>(
  tool: Omit<ToolDefinition<z.ZodObject<S & { purpose: typeof purpose }>, O>, "inputSchema"> & { input: S },
): ToolDefinition {
  const { input, ...rest } = tool;
  return { ...rest, inputSchema: z.object({ purpose, ...input }) } as unknown as ToolDefinition;
}
