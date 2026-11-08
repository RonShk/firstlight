// The policy knowledge base: documents, chunks, an FTS5 full-text index and embedding vectors, in
// one SQLite file built by `npm run knowledge:ingest`. Read-only at serving time.
import { existsSync } from "node:fs";
import { Sqlite } from "../db/sqlite";
import { config } from "../config";
import type { PolicyLine } from "./documents";

export interface StoredChunk {
  chunk_id: string;
  doc_id: string;
  ord: number;
  page: number | null;
  section: string;
  text: string;
}

export interface StoredDocument {
  doc_id: string;
  line: PolicyLine;
  title: string;
  form_number: string;
  source_type: string;
  chunks: number;
}

export const KNOWLEDGE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS documents (
    doc_id TEXT PRIMARY KEY, line TEXT NOT NULL, title TEXT NOT NULL, form_number TEXT NOT NULL,
    source_type TEXT NOT NULL, chunks INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS chunks (
    chunk_id TEXT PRIMARY KEY, doc_id TEXT NOT NULL REFERENCES documents(doc_id), ord INTEGER NOT NULL,
    page INTEGER, section TEXT NOT NULL, text TEXT NOT NULL, UNIQUE(doc_id, ord));
  CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
    chunk_id UNINDEXED, section, text, tokenize='porter unicode61');
  CREATE TABLE IF NOT EXISTS embeddings (
    chunk_id TEXT PRIMARY KEY REFERENCES chunks(chunk_id), model TEXT NOT NULL, vector BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`;

export class KnowledgeStore {
  readonly sql: Sqlite;
  private vectors = new Map<string, Float32Array>();
  private vectorModel: string | null | undefined;

  constructor(file: string) {
    this.sql = new Sqlite(file);
    this.sql.exec(KNOWLEDGE_SCHEMA);
  }

  meta(key: string): string | null {
    return this.sql.get<{ value: string }>("SELECT value FROM meta WHERE key=?", key)?.value ?? null;
  }

  documents(): StoredDocument[] {
    return this.sql.all<StoredDocument>("SELECT * FROM documents ORDER BY doc_id");
  }

  chunk(id: string): StoredChunk | null {
    return this.sql.get<StoredChunk>("SELECT * FROM chunks WHERE chunk_id=?", id) ?? null;
  }

  chunksOf(docId: string, fromOrd: number, toOrd: number): StoredChunk[] {
    return this.sql.all<StoredChunk>("SELECT * FROM chunks WHERE doc_id=? AND ord BETWEEN ? AND ? ORDER BY ord", docId, fromOrd, toOrd);
  }

  /** Every chunk of one section label in a document, in reading order. */
  section(docId: string, section: string): StoredChunk[] {
    return this.sql.all<StoredChunk>("SELECT * FROM chunks WHERE doc_id=? AND section=? ORDER BY ord", docId, section);
  }

  /** Distinct section headings of a document with their first chunk, in reading order. */
  outline(docId: string): { section: string; chunk_id: string; page: number | null }[] {
    return this.sql.all("SELECT section, chunk_id, page FROM chunks WHERE doc_id=? AND ord IN (SELECT MIN(ord) FROM chunks WHERE doc_id=? GROUP BY section) ORDER BY ord", docId, docId);
  }

  /** BM25 over section + text, restricted to docIds. Lower bm25() is better; returned best first. */
  lexical(query: string, docIds: string[], limit: number): { chunk_id: string; score: number }[] {
    const terms = ftsTerms(query);
    if (!terms.length || !docIds.length) return [];
    const marks = docIds.map(() => "?").join(",");
    return this.sql.all<{ chunk_id: string; score: number }>(
      `SELECT f.chunk_id AS chunk_id, -bm25(chunk_fts, 0.0, 2.0, 1.0) AS score FROM chunk_fts f
       JOIN chunks c ON c.chunk_id = f.chunk_id
       WHERE chunk_fts MATCH ? AND c.doc_id IN (${marks}) ORDER BY bm25(chunk_fts, 0.0, 2.0, 1.0) LIMIT ?`,
      terms.join(" OR "), ...docIds, limit);
  }

  /** Normalized vectors for docIds, loaded once per process. Null when the index has none. */
  vectorsFor(docIds: string[]): { model: string; vectors: [string, Float32Array][] } | null {
    if (this.vectorModel === undefined) {
      this.vectorModel = this.meta("embed_model");
      for (const row of this.sql.all<{ chunk_id: string; vector: Uint8Array }>("SELECT chunk_id, vector FROM embeddings")) {
        const v = new Float32Array(row.vector.buffer.slice(row.vector.byteOffset, row.vector.byteOffset + row.vector.byteLength));
        this.vectors.set(row.chunk_id, normalize(v));
      }
    }
    if (!this.vectorModel || !this.vectors.size) return null;
    const allowed = new Set(docIds);
    const out: [string, Float32Array][] = [];
    for (const [id, v] of this.vectors) if (allowed.has(id.slice(0, id.lastIndexOf("#")))) out.push([id, v]);
    return { model: this.vectorModel, vectors: out };
  }
}

export function normalize(v: Float32Array): Float32Array {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return v.map((x) => x / n);
}

const STOP = new Set(("the and for that this with from are was were has have had not but any all our your you their they them " +
  "his her its who what when where which while will would shall may can been being into onto under over than then there these " +
  "those such per each other also does did done very just only more most some about my me im is it of to in on at a an or be do " +
  "if so as by we us").split(" "));

/** Quoted FTS5 terms: letters/digits only, so customer text can never inject query syntax. */
export function ftsTerms(query: string): string[] {
  const words = (query.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length >= 3 && !STOP.has(t));
  return [...new Set(words)].slice(0, 32).map((t) => `"${t}"`);
}

let shared: KnowledgeStore | undefined;
export function knowledge(): KnowledgeStore {
  if (!shared) {
    const file = config().knowledgeDbPath;
    if (!existsSync(file)) throw new Error(`Knowledge base not built: run \`npm run knowledge:ingest\` to create ${file}`);
    shared = new KnowledgeStore(file);
  }
  return shared;
}
export const knowledgeAvailable = () => existsSync(config().knowledgeDbPath);
