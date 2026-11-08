// Hybrid retrieval over one customer's own policy forms:
//   1. BM25 (SQLite FTS5, porter stemming) and dense Nemotron embeddings each nominate candidates.
//   2. Reciprocal-rank fusion merges the two lists, so exact policy wording and paraphrases both surface.
//   3. The Nemotron cross-encoder reranker re-orders the fused shortlist.
// Any NVIDIA service that is down degrades the search (recorded in `degraded`), never fails it.
import type { Embedder } from "./embeddings";
import type { Reranker } from "./rerank";
import type { KnowledgeStore, StoredChunk } from "./store";

export interface SearchHit {
  chunk: StoredChunk;
  score: number;
  signals: { lexical_rank: number | null; dense_rank: number | null; dense_cosine: number | null; rerank_logit: number | null };
}

export interface SearchResult {
  hits: SearchHit[];
  methods: ("bm25" | "dense" | "rrf" | "rerank")[];
  degraded: string[];
}

export interface SearchOptions {
  limit?: number;
  candidates?: number;
  rerankDepth?: number;
  embedder?: Embedder | null;
  reranker?: Reranker | null;
  signal?: AbortSignal;
}

const RRF_K = 60;
const MIN_DENSE_ONLY_COSINE = 0.15;

export async function hybridSearch(store: KnowledgeStore, query: string, docIds: string[], options: SearchOptions = {}): Promise<SearchResult> {
  const { limit = 5, candidates = 40, rerankDepth = 20, embedder, reranker, signal } = options;
  const methods: SearchResult["methods"] = [];
  const degraded: string[] = [];
  if (!docIds.length || !query.trim()) return { hits: [], methods, degraded };

  const lexical = store.lexical(query, docIds, candidates);
  methods.push("bm25");

  let dense: { chunk_id: string; cosine: number }[] = [];
  const vectors = store.vectorsFor(docIds);
  if (!vectors) degraded.push("no embeddings in knowledge base");
  else if (!embedder) degraded.push("embedding service not configured");
  else if (embedder.model !== vectors.model) degraded.push(`index embedded with ${vectors.model}, query model is ${embedder.model}`);
  else {
    try {
      const [q] = await embedder.embed([query], "query", signal);
      const qn = unit(q);
      dense = vectors.vectors.map(([chunk_id, v]) => ({ chunk_id, cosine: dot(qn, v) }))
        .sort((a, b) => b.cosine - a.cosine).slice(0, candidates);
      methods.push("dense");
    } catch (e) {
      if (signal?.aborted) throw e;
      degraded.push(`dense retrieval unavailable: ${(e as Error).message}`);
    }
  }

  const fused = new Map<string, SearchHit["signals"] & { rrf: number }>();
  const entry = (id: string) => {
    let e = fused.get(id);
    if (!e) fused.set(id, (e = { lexical_rank: null, dense_rank: null, dense_cosine: null, rerank_logit: null, rrf: 0 }));
    return e;
  };
  lexical.forEach((r, i) => { const e = entry(r.chunk_id); e.lexical_rank = i + 1; e.rrf += 1 / (RRF_K + i + 1); });
  dense.forEach((r, i) => {
    if (r.cosine < MIN_DENSE_ONLY_COSINE && !fused.has(r.chunk_id)) return;
    const e = entry(r.chunk_id); e.dense_rank = i + 1; e.dense_cosine = round(r.cosine); e.rrf += 1 / (RRF_K + i + 1);
  });
  if (dense.length) methods.push("rrf");

  let ranked = [...fused.entries()].sort((a, b) => b[1].rrf - a[1].rrf).slice(0, Math.max(rerankDepth, limit));
  const chunks = new Map(ranked.map(([id]) => [id, store.chunk(id)!]));

  if (reranker && ranked.length > 1) {
    try {
      const logits = await reranker.rerank(query, ranked.map(([id]) => passage(chunks.get(id)!)), signal);
      ranked.forEach(([, s], i) => { s.rerank_logit = round(logits[i]); });
      ranked = ranked.sort((a, b) => (b[1].rerank_logit ?? -Infinity) - (a[1].rerank_logit ?? -Infinity));
      methods.push("rerank");
    } catch (e) {
      if (signal?.aborted) throw e;
      degraded.push(`reranker unavailable: ${(e as Error).message}`);
    }
  }

  const hits = ranked.slice(0, limit).map(([id, s]) => ({
    chunk: chunks.get(id)!,
    score: round(s.rerank_logit ?? s.rrf),
    signals: { lexical_rank: s.lexical_rank, dense_rank: s.dense_rank, dense_cosine: s.dense_cosine, rerank_logit: s.rerank_logit },
  }));
  return { hits, methods, degraded };
}

export const passage = (c: Pick<StoredChunk, "section" | "text">) => `${c.section}. ${c.text}`;

function unit(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;
