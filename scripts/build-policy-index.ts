// Build data/policy_index.json from data/policies/manifest.csv and the hand-supplied files in
// data/policies/raw/ (<doc_id>.pdf or <doc_id>.html). A document without a file is recorded as
// "missing". Embeddings (input_type "passage") are added when NEMOTRON_EMBED_API_KEY is set;
// otherwise retrieval is lexical. Queries are embedded with the same model (input_type "query").
// Usage: npm run agent:index [-- --no-embed]

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { agentConfig } from "../src/lib/agent/config";
import { createNemotronClient } from "../src/lib/agent/nemotron";
import {
  INDEX_PATH, MANIFEST_PATH, RAW_DIR, chunkPages, htmlToText, parseManifest,
  type PolicyChunk, type PolicyIndex,
} from "../src/lib/agent/policy-docs";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

// The hosted embedding endpoint fails (HTTP 500) on batches of more than about two inputs and
// rate-limits requests (HTTP 429), so embed one chunk per request, back off on 429, and reuse
// vectors from the previous index for unchanged chunks so a rerun only embeds what changed.
const EMBED_CONCURRENCY = 3;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pagesOf(file: string): Promise<string[]> {
  if (file.endsWith(".html")) return [htmlToText(readFileSync(file, "utf8"))];
  const pdf = await getDocumentProxy(new Uint8Array(readFileSync(file)));
  return (await extractText(pdf, { mergePages: false })).text;
}

async function main() {
  const manifest = parseManifest(readFileSync(MANIFEST_PATH, "utf8"));
  const documents: PolicyIndex["documents"] = [];
  const chunks: PolicyChunk[] = [];

  for (const entry of manifest) {
    const file = [".pdf", ".html"].map((ext) => path.join(RAW_DIR, `${entry.doc_id}${ext}`)).find(existsSync);
    if (!file) {
      console.warn(`  ! ${entry.doc_id}: no file; place it at ${path.join(RAW_DIR, `${entry.doc_id}.pdf`)}`);
      documents.push({ doc_id: entry.doc_id, status: "missing", chunks: 0 });
      continue;
    }
    const isOpinion = entry.source_type.includes("Court");
    const docChunks = chunkPages(await pagesOf(file), {
      doc_id: entry.doc_id, line: entry.line, form_number: entry.form_number, state: entry.state,
      policy_type: entry.policy_type,
    }, { defaultSection: isOpinion ? "Court opinion" : file.endsWith(".html") ? "Web overview" : "General" });
    chunks.push(...docChunks);
    documents.push({ doc_id: entry.doc_id, status: "indexed", chunks: docChunks.length });
    console.log(`  ${entry.doc_id}: ${docChunks.length} chunks`);
  }

  const config = agentConfig();
  let embedModel: string | null = null;
  let embedError: unknown = null;
  if (!process.argv.includes("--no-embed") && config.embedApiKey) {
    console.log(`  embedding ${chunks.length} chunks with ${config.embedModel} at ${config.embedBaseUrl}`);
    const client = createNemotronClient(config);
    const passage = (c: PolicyChunk) => `${c.section}. ${c.text}`;
    const previous = new Map<string, number[]>();
    if (existsSync(INDEX_PATH)) {
      const old = JSON.parse(readFileSync(INDEX_PATH, "utf8")) as PolicyIndex;
      if (old.embed_model === config.embedModel) {
        for (const c of old.chunks) if (c.embedding) previous.set(passage(c), c.embedding);
      }
    }
    const todo = chunks.filter((c) => !(c.embedding = previous.get(passage(c))));
    console.log(`  ${chunks.length - todo.length} reused, ${todo.length} to embed`);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < todo.length) {
        const c = todo[next++];
        for (let wait = 2_000; ; wait = Math.min(wait * 2, 60_000)) {
          try {
            const [vector] = await client.embed([passage(c)], "passage");
            c.embedding = vector.map((v) => Math.round(v * 1e5) / 1e5);
            break;
          } catch (e) {
            if (!/HTTP 429/.test((e as Error).message)) throw e;
            await sleep(wait);
          }
        }
        if (++done % 50 === 0) console.log(`  embedded ${done}/${todo.length}`);
      }
    };
    // A partial index is still safe to write: retrieval uses embeddings only when every chunk in
    // the pool has one, and the next run reuses what was embedded here.
    embedError = await Promise.all(Array.from({ length: EMBED_CONCURRENCY }, worker)).then(() => null, (e) => e);
    embedModel = config.embedModel;
  } else {
    console.log("  (no embeddings: NEMOTRON_EMBED_API_KEY not set or --no-embed; lexical retrieval only)");
  }

  const index: PolicyIndex = { built_at: new Date().toISOString(), embed_model: embedModel, documents, chunks };
  writeFileSync(INDEX_PATH, JSON.stringify(index));
  const embedded = chunks.filter((c) => c.embedding).length;
  console.log(`wrote ${INDEX_PATH}: ${chunks.length} chunks (${embedded} embedded), ${documents.filter((d) => d.status === "missing").length} missing`);
  if (embedError) throw embedError;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
