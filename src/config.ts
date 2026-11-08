// Server-side configuration. Secrets never use NEXT_PUBLIC_. Every NVIDIA service is optional except
// the Nemotron chat model: without embeddings retrieval is lexical, without the reranker results keep
// their fused order, and without the guard model safety screening is skipped (and recorded as such).

export const NVIDIA_API = "https://integrate.api.nvidia.com/v1";
const NVIDIA_RETRIEVAL = "https://ai.api.nvidia.com/v1/retrieval";

export interface Config {
  chat: { apiKey: string; baseUrl: string; model: string; timeoutMs: number };
  /** Hosted NVIDIA API key for embeddings, reranking and the safety guard. */
  nvidiaKey: string;
  embed: { baseUrl: string; model: string };
  rerank: { url: string; model: string } | null;
  guard: { baseUrl: string; model: string } | null;
  limits: { maxTurns: number; maxToolCalls: number; maxRevisions: number; runTimeoutMs: number; maxTokens: number };
  workers: { concurrency: number; mode: "inline" | "external" };
  opsDbPath: string;
  knowledgeDbPath: string;
}

const num = (v: string | undefined, fallback: number) => (v && Number.isFinite(Number(v)) ? Number(v) : fallback);

/** DATABASE_URL accepts "file:./local.db" or a plain path. */
function sqlitePath(url: string | undefined, fallback: string): string {
  if (!url) return fallback;
  return url.startsWith("file:") ? url.slice(5) : url;
}

export function config(env: Record<string, string | undefined> = process.env): Config {
  const baseUrl = env.NEMOTRON_BASE_URL || NVIDIA_API;
  // The chat key is reused for hosted services only when chat itself runs on NVIDIA's hosted API:
  // a Brev vLLM key is never sent to another host.
  const nvidiaKey = env.NEMOTRON_EMBED_API_KEY || (baseUrl === NVIDIA_API ? env.NEMOTRON_API_KEY ?? "" : "");
  const rerankModel = env.NEMOTRON_RERANK_MODEL || "nvidia/llama-nemotron-rerank-vl-1b-v2";
  const guardModel = env.NEMOTRON_GUARD_MODEL ?? "nvidia/llama-3.1-nemotron-safety-guard-8b-v3";
  return {
    chat: { apiKey: env.NEMOTRON_API_KEY ?? "", baseUrl, model: env.NEMOTRON_MODEL ?? "", timeoutMs: num(env.NEMOTRON_TIMEOUT_MS, 90_000) },
    nvidiaKey,
    embed: { baseUrl: env.NEMOTRON_EMBED_BASE_URL || NVIDIA_API, model: env.NEMOTRON_EMBED_MODEL || "nvidia/nemotron-3.5-embed-1b" },
    rerank: nvidiaKey && rerankModel !== "off"
      ? { model: rerankModel, url: env.NEMOTRON_RERANK_URL || `${NVIDIA_RETRIEVAL}/${rerankModel.replace(/\./g, "_")}/reranking` }
      : null,
    guard: nvidiaKey && guardModel && guardModel !== "off" ? { baseUrl: NVIDIA_API, model: guardModel } : null,
    limits: {
      maxTurns: num(env.AGENT_MAX_TURNS, 14),
      maxToolCalls: num(env.AGENT_MAX_TOOL_CALLS, 24),
      maxRevisions: num(env.AGENT_MAX_REVISIONS, 3),
      runTimeoutMs: num(env.AGENT_RUN_TIMEOUT_MS, 20 * 60_000),
      maxTokens: num(env.AGENT_MAX_TOKENS, 150_000),
    },
    workers: { concurrency: num(env.AGENT_CONCURRENCY, 4), mode: env.AGENT_WORKERS === "external" ? "external" : "inline" },
    opsDbPath: env.AGENT_DB_PATH || sqlitePath(env.DATABASE_URL, ".cache/agent/ops.db"),
    knowledgeDbPath: env.KNOWLEDGE_DB_PATH || "data/knowledge.db",
  };
}

export const chatConfigured = (c: Config = config()) => Boolean(c.chat.apiKey && c.chat.model);
