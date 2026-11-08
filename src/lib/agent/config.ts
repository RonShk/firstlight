// Agent configuration. Server-side only: secrets never use NEXT_PUBLIC_.
// Chat (Nemotron on our Brev vLLM server) and embeddings (NVIDIA hosted) have separate hosts and keys.

export const DEFAULT_NEMOTRON_BASE_URL = "https://integrate.api.nvidia.com/v1";

export interface AgentConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  embedApiKey: string;
  embedBaseUrl: string;
  embedModel: string;
  provisionalCapUsd: number;
  minCosine: number;
  minLexicalScore: number;
}

export function agentConfig(env: Record<string, string | undefined> = process.env): AgentConfig {
  const baseUrl = env.NEMOTRON_BASE_URL || DEFAULT_NEMOTRON_BASE_URL;
  return {
    apiKey: env.NEMOTRON_API_KEY ?? "",
    baseUrl,
    model: env.NEMOTRON_MODEL ?? "",
    timeoutMs: Number(env.NEMOTRON_TIMEOUT_MS || 60_000),
    // The chat key is reused for embeddings only when chat also runs on NVIDIA's hosted API;
    // a Brev vLLM key is never sent to another host.
    embedApiKey: env.NEMOTRON_EMBED_API_KEY || (baseUrl === DEFAULT_NEMOTRON_BASE_URL ? env.NEMOTRON_API_KEY ?? "" : ""),
    embedBaseUrl: env.NEMOTRON_EMBED_BASE_URL || DEFAULT_NEMOTRON_BASE_URL,
    embedModel: env.NEMOTRON_EMBED_MODEL || "nvidia/nemotron-3.5-embed-1b",
    provisionalCapUsd: Number(env.PROVISIONAL_CAP_USD || 2500),
    // Calibrated for nvidia/nemotron-3.5-embed-1b: unrelated text scores about 0.1, policy clauses 0.25-0.5.
    minCosine: Number(env.RAG_MIN_COSINE || 0.2),
    minLexicalScore: Number(env.RAG_MIN_LEXICAL_SCORE || 7.5),
  };
}
