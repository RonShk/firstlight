// PDFs/HTML -> pages -> section-aware chunks -> SQLite (documents, chunks, FTS5) -> embeddings.
// Vectors are reused for unchanged passages (from the previous knowledge DB or the legacy JSON index),
// so re-ingesting only embeds text that changed.
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { chunkPages, htmlToText, parseManifest, RAW_DIR, MANIFEST_PATH, type PolicyChunk } from "./documents";
import type { Embedder } from "./embeddings";
import { passage } from "./search";
import { KnowledgeStore } from "./store";

export interface IngestOptions {
  file: string;
  manifestPath?: string;
  rawDir?: string;
  embedder?: Embedder | null;
  /** Legacy data/policy_index.json, read only to reuse vectors. */
  legacyIndexPath?: string;
  log?: (line: string) => void;
}

export interface IngestedDocument {
  doc_id: string;
  line: PolicyChunk["line"];
  title: string;
  form_number: string;
  source_type: string;
  pages: string[];
  defaultSection: string;
}

async function pagesOf(file: string): Promise<string[]> {
  if (file.endsWith(".html")) return [htmlToText(readFileSync(file, "utf8"))];
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(file)));
  return (await extractText(pdf, { mergePages: false })).text;
}

export async function loadManifestDocuments(manifestPath = MANIFEST_PATH, rawDir = RAW_DIR, log = console.log): Promise<IngestedDocument[]> {
  const docs: IngestedDocument[] = [];
  for (const entry of parseManifest(readFileSync(manifestPath, "utf8"))) {
    const file = [".pdf", ".html"].map((ext) => path.join(rawDir, `${entry.doc_id}${ext}`)).find(existsSync);
    if (!file) { log(`  ! ${entry.doc_id}: missing source file in ${rawDir}`); continue; }
    const isOpinion = entry.source_type.includes("Court");
    docs.push({ doc_id: entry.doc_id, line: entry.line, title: entry.policy_type, form_number: entry.form_number,
      source_type: entry.source_type, pages: await pagesOf(file),
      defaultSection: isOpinion ? "Court opinion" : file.endsWith(".html") ? "Web overview" : "General" });
  }
  return docs;
}

/** Write documents into a fresh knowledge DB. Returns the store (open). */
export async function ingestDocuments(docs: IngestedDocument[], options: IngestOptions): Promise<KnowledgeStore> {
  const log = options.log ?? console.log;
  const reuse = new Map<string, Float32Array>();
  if (options.embedder) collectReusableVectors(options, options.embedder.model, reuse, log);
  if (options.file !== ":memory:") for (const suffix of ["", "-wal", "-shm"]) rmSync(options.file + suffix, { force: true });

  const store = new KnowledgeStore(options.file);
  const all: PolicyChunk[] = [];
  store.sql.tx(() => {
    for (const doc of docs) {
      const chunks = chunkPages(doc.pages, { doc_id: doc.doc_id, line: doc.line, form_number: doc.form_number, state: "", policy_type: doc.title },
        { defaultSection: doc.defaultSection });
      store.sql.run("INSERT INTO documents VALUES (?,?,?,?,?,?)", doc.doc_id, doc.line, doc.title, doc.form_number, doc.source_type, chunks.length);
      chunks.forEach((c, ord) => {
        store.sql.run("INSERT INTO chunks VALUES (?,?,?,?,?,?)", c.chunk_id, c.doc_id, ord, c.page, c.section, c.text);
        store.sql.run("INSERT INTO chunk_fts(chunk_id, section, text) VALUES (?,?,?)", c.chunk_id, c.section, c.text);
      });
      all.push(...chunks);
      log(`  ${doc.doc_id}: ${chunks.length} chunks`);
    }
    store.sql.run("INSERT OR REPLACE INTO meta VALUES ('built_at', ?)", new Date().toISOString());
  });

  if (options.embedder) {
    const model = options.embedder.model;
    const todo = all.filter((c) => !reuse.has(passage(c)));
    log(`  embeddings: ${all.length - todo.length} reused, ${todo.length} to embed with ${model}`);
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const c = todo[next++];
        const [v] = await options.embedder!.embed([passage(c)], "passage");
        reuse.set(passage(c), v);
      }
    };
    await Promise.all(Array.from({ length: 3 }, worker));
    store.sql.tx(() => {
      for (const c of all) {
        const v = reuse.get(passage(c))!;
        store.sql.run("INSERT INTO embeddings VALUES (?,?,?)", c.chunk_id, model, new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
      }
      store.sql.run("INSERT OR REPLACE INTO meta VALUES ('embed_model', ?)", model);
    });
  } else {
    log("  no embedder configured: lexical (BM25) retrieval only");
  }
  return store;
}

function collectReusableVectors(options: IngestOptions, model: string, into: Map<string, Float32Array>, log: (l: string) => void) {
  if (options.file !== ":memory:" && existsSync(options.file)) {
    const old = new KnowledgeStore(options.file);
    if (old.meta("embed_model") === model) {
      for (const r of old.sql.all<{ section: string; text: string; vector: Uint8Array }>(
        "SELECT c.section, c.text, e.vector FROM embeddings e JOIN chunks c USING (chunk_id)")) {
        into.set(passage(r), new Float32Array(r.vector.buffer.slice(r.vector.byteOffset, r.vector.byteOffset + r.vector.byteLength)));
      }
    }
    old.sql.close();
  }
  const legacy = options.legacyIndexPath;
  if (legacy && existsSync(legacy)) {
    const index = JSON.parse(readFileSync(legacy, "utf8")) as { embed_model?: string; chunks: { section: string; text: string; embedding?: number[] }[] };
    if (index.embed_model === model) for (const c of index.chunks) if (c.embedding) into.set(passage(c), Float32Array.from(c.embedding));
  }
  log(`  ${into.size} reusable vectors found`);
}
