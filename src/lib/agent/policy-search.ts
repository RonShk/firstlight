import "server-only";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { POLICY_FORMS } from "@/lib/sim/data";

/**
 * Keyword (BM25) search over the policy forms in data/policies (run `npm run policies`).
 * Searches are always restricted to the policyholder's own forms.
 */

export interface PolicyChunk {
  docId: string;
  section: string;
  page: number;
  text: string;
}

export interface PolicyHit extends PolicyChunk {
  score: number;
}

const CHUNK_CHARS = 900;
const STOP = new Set("a an and are as at be by for from has have if in into is it its of on or that the this to was were will with we you your our any not no".split(" "));

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

function isHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 4 || t.length > 90 || /\.{4,}/.test(t)) return false;
  const letters = t.replace(/[^A-Za-z]/g, "");
  return letters.length >= 4 && letters === letters.toUpperCase();
}

function chunkDocument(docId: string, raw: string): PolicyChunk[] {
  const chunks: PolicyChunk[] = [];
  let page = 1;
  let section = "General";
  let buf: string[] = [];
  let size = 0;
  const flush = () => {
    // Re-join words the PDF hyphenated across line breaks ("prop- erty" → "property").
    const text = buf.join(" ").replace(/\s+/g, " ").replace(/([a-z])- ([a-z])/g, "$1$2").trim();
    const isToc = /TABLE OF CONTENTS/i.test(section) || (text.match(/\.{5,}/g)?.length ?? 0) >= 3;
    if (text.length > 80 && !isToc) chunks.push({ docId, section, page, text });
    buf = [];
    size = 0;
  };
  for (const line of raw.split("\n")) {
    const pageMatch = line.match(/^\[page (\d+)\]$/);
    if (pageMatch) {
      page = Number(pageMatch[1]);
      continue;
    }
    if (isHeading(line)) {
      flush();
      section = line.trim().replace(/\s+/g, " ");
      continue;
    }
    buf.push(line);
    size += line.length;
    if (size > CHUNK_CHARS) flush();
  }
  flush();
  return chunks;
}

interface Index {
  chunks: PolicyChunk[];
  tokens: string[][];
  df: Map<string, number>;
  avgLen: number;
  loaded: string[];
}

let index: Index | null = null;

function buildIndex(): Index {
  const chunks: PolicyChunk[] = [];
  const loaded: string[] = [];
  for (const form of POLICY_FORMS) {
    const file = path.join(process.cwd(), "data", "policies", `${form.id}.txt`);
    if (!existsSync(file)) continue;
    chunks.push(...chunkDocument(form.id, readFileSync(file, "utf8")));
    loaded.push(form.id);
  }
  const tokens = chunks.map((c) => tokenize(`${c.section} ${c.text}`));
  const df = new Map<string, number>();
  for (const toks of tokens) for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
  const avgLen = tokens.reduce((s, t) => s + t.length, 0) / Math.max(1, tokens.length);
  return { chunks, tokens, df, avgLen, loaded };
}

function getIndex(): Index {
  index ??= buildIndex();
  return index;
}

export function loadedPolicyDocs(): string[] {
  return getIndex().loaded;
}

export function searchPolicy(query: string, docIds: string[], limit = 4): PolicyHit[] {
  const { chunks, tokens, df, avgLen } = getIndex();
  const allowed = new Set(docIds);
  const q = [...new Set(tokenize(query))];
  const n = chunks.length;
  const k1 = 1.4;
  const b = 0.75;
  const hits: PolicyHit[] = [];
  chunks.forEach((chunk, i) => {
    if (!allowed.has(chunk.docId)) return;
    const toks = tokens[i];
    let score = 0;
    for (const term of q) {
      const tf = toks.filter((t) => t === term).length;
      if (!tf) continue;
      const idf = Math.log(1 + (n - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * toks.length) / avgLen)));
    }
    if (score > 0) hits.push({ ...chunk, score });
  });
  return hits.sort((a, b2) => b2.score - a.score).slice(0, limit);
}
