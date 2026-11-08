// Build the policy knowledge base (data/knowledge.db): chunks, FTS5 index and Nemotron embeddings.
// Usage: npm run knowledge:ingest [-- --no-embed]
import { existsSync } from "node:fs";
import { config } from "../src/config";
import { nvidiaEmbedder } from "../src/knowledge/embeddings";
import { ingestDocuments, loadManifestDocuments } from "../src/knowledge/ingest";

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const c = config();
  const docs = await loadManifestDocuments();
  const store = await ingestDocuments(docs, {
    file: c.knowledgeDbPath,
    embedder: process.argv.includes("--no-embed") ? null : nvidiaEmbedder(c),
    legacyIndexPath: "data/policy_index.json",
  });
  const count = store.sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM chunks")!.n;
  const vectors = store.sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM embeddings")!.n;
  console.log(`wrote ${c.knowledgeDbPath}: ${docs.length} documents, ${count} chunks, ${vectors} vectors`);
}

main().catch((e) => { console.error(e); process.exit(1); });
