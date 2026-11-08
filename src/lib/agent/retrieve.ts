// Policy retrieval, always filtered to one policy line (claim type) before scoring. All forms of a
// line are treated as one generic policy, whatever their state.
// Uses NVIDIA embeddings when the index has them, BM25 lexical search otherwise. Results below the
// relevance floor are dropped, and the same clause copied in several forms is shown once.

import type { AgentConfig } from "./config";
import { ModelUnavailableError, type ModelClient } from "./nemotron";
import type { PolicyChunk, PolicyIndex, PolicyLine } from "./policy-docs";

export interface RetrievedChunk {
  chunk: PolicyChunk;
  score: number;
}

export interface Retrieval {
  method: "embedding" | "lexical";
  chunks: RetrievedChunk[];
}


const STOP = new Set(
  ("the and for that this with from are was were has have had not but any all our your you " +
    "their they them his her its who what when where which while will would shall may can " +
    "been being into onto under over than then there these those such per each other also " +
    "does did done very just only more most some").split(" "),
);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+/g) ?? [])
    .filter((t) => t.length >= 3 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") && !t.endsWith("ss") ? t.slice(0, -1) : t));
}

interface Lexical {
  docs: { chunk: PolicyChunk; tf: Map<string, number>; len: number }[];
  df: Map<string, number>;
  avgLen: number;
}

const lexicalCache = new WeakMap<PolicyIndex, Map<PolicyLine, Lexical>>();

function lexicalFor(index: PolicyIndex, line: PolicyLine): Lexical {
  let byLine = lexicalCache.get(index);
  if (!byLine) lexicalCache.set(index, (byLine = new Map()));
  let lex = byLine.get(line);
  if (!lex) {
    const docs = index.chunks
      .filter((c) => c.line === line)
      .map((chunk) => {
        const tokens = tokenize(`${chunk.section} ${chunk.text}`);
        const tf = new Map<string, number>();
        for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
        return { chunk, tf, len: tokens.length };
      });
    const df = new Map<string, number>();
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const avgLen = docs.reduce((s, d) => s + d.len, 0) / Math.max(docs.length, 1);
    byLine.set(line, (lex = { docs, df, avgLen }));
  }
  return lex;
}

/** BM25 over one line's chunks; a hit needs at least two distinct query terms. */
export function lexicalSearch(
  index: PolicyIndex,
  line: PolicyLine,
  query: string,
  limit: number,
  minScore: number,
): RetrievedChunk[] {
  const { docs, df, avgLen } = lexicalFor(index, line);
  const terms = [...new Set(tokenize(query))];
  const k1 = 1.2;
  const b = 0.75;
  return docs
    .map((d) => {
      let score = 0;
      let matched = 0;
      for (const t of terms) {
        const f = d.tf.get(t);
        if (!f) continue;
        matched++;
        const idf = Math.log(1 + (docs.length - df.get(t)! + 0.5) / (df.get(t)! + 0.5));
        score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgLen));
      }
      return { chunk: d.chunk, score: matched >= 2 ? score : 0 };
    })
    .filter((r) => r.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * The same clause copied in another form: same section, different document, and most words shared
 * relative to the smaller chunk (chunk boundaries drift between forms, so plain Jaccard misses
 * shifted copies). Neighbouring chunks of one form overlap by design and never count.
 */
function nearDuplicate(a: PolicyChunk, b: PolicyChunk): boolean {
  if (a.doc_id === b.doc_id || a.section !== b.section) return false;
  const ta = new Set(tokenize(a.text));
  const tb = new Set(tokenize(b.text));
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / Math.max(Math.min(ta.size, tb.size), 1) >= 0.7;
}

function addDistinct(out: RetrievedChunk[], r: RetrievedChunk): boolean {
  if (out.some((o) => nearDuplicate(o.chunk, r.chunk))) return false;
  out.push(r);
  return true;
}

export interface RetrieveOptions {
  limit?: number;
  candidates?: number;
  /**
   * Sections that must be represented: for each pattern with no match in the results, the best
   * matching chunk of that section is added if it scores at least half the relevance floor.
   * Used to always show the clause that defines the item's coverage (e.g. Other Structures).
   */
  pin?: RegExp[];
}

export async function retrieve(
  index: PolicyIndex,
  line: PolicyLine,
  query: string,
  client: ModelClient,
  config: AgentConfig,
  { limit = 6, candidates = 30, pin = [] }: RetrieveOptions = {},
): Promise<Retrieval> {
  const pool = index.chunks.filter((c) => c.line === line);
  let method: Retrieval["method"] = "lexical";
  let scored: RetrievedChunk[] | null = null; // the whole pool, best first, before the floor
  let floor = config.minLexicalScore;

  // Query and passages must come from the same embedding model, or the scores mean nothing.
  if (index.embed_model && index.embed_model !== config.embedModel) {
    console.warn(`[agent] index embedded with ${index.embed_model}, config uses ${config.embedModel}; using lexical search`);
  } else if (index.embed_model && pool.length && pool.every((c) => c.embedding)) {
    try {
      const [q] = await client.embed([query], "query");
      scored = pool.map((chunk) => ({ chunk, score: cosine(q, chunk.embedding!) })).sort((a, b) => b.score - a.score);
      floor = config.minCosine;
      method = "embedding";
    } catch (e) {
      if (!(e instanceof ModelUnavailableError)) throw e;
      console.warn(`[agent] query embedding failed, using lexical search: ${e.message}`);
    }
  }
  scored ??= lexicalSearch(index, line, query, pool.length, 0);
  const found = scored.filter((r) => r.score >= floor).slice(0, candidates);

  const chunks: RetrievedChunk[] = [];
  for (const r of found) {
    if (chunks.length >= limit) break;
    addDistinct(chunks, r);
  }
  if (chunks.length) {
    for (const section of pin) {
      if (chunks.some((r) => section.test(r.chunk.section))) continue;
      const best = scored.find((r) => section.test(r.chunk.section) && r.score >= floor / 2);
      if (best) addDistinct(chunks, best);
    }
  }
  return { method, chunks };
}
