// Ad-hoc retrieval check: the exact query and retrieve() call the pipeline makes for each item
// (embeddings when the index has them, lexical otherwise), filtered by claim type.
// Usage: npx tsx scripts/retrieval-check.ts   (reads .env.local)
import { existsSync } from "node:fs";
import { itemRetrieval } from "../src/lib/agent/analyze";
import { agentConfig } from "../src/lib/agent/config";
import { createNemotronClient } from "../src/lib/agent/nemotron";
import { loadPolicyIndex } from "../src/lib/agent/policy-docs";
import { retrieve } from "../src/lib/agent/retrieve";
import type { ClaimItem, Extraction } from "../src/lib/agent/schemas";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const item = (o: Partial<ClaimItem> & Pick<ClaimItem, "description" | "coverage">): ClaimItem => ({
  id: "I", type: "home", kind: "damage", category: "other", owner: "customer", estimated_amount_usd: null,
  amount_is_estimate: true, triage: 2, triage_reason: "", search_terms: [], ...o,
});
const ITEMS: ClaimItem[] = [
  item({ description: "roof shingles torn off", coverage: "dwelling", search_terms: ["windstorm", "roof damage"] }),
  item({ description: "water coming in through the ceiling in the kids' room", coverage: "dwelling", search_terms: ["water damage", "rain"] }),
  item({ description: "back fence broken by a fallen tree", coverage: "other_structures", search_terms: ["fence", "falling tree"] }),
  item({ description: "spoiled food in the fridge after a two-day power outage", coverage: "personal_property", kind: "expense",
         category: "food_spoilage", search_terms: ["refrigerated products"] }),
  item({ description: "hotel for a few nights", coverage: "loss_of_use", kind: "expense", category: "living_expense",
         search_terms: ["additional living expense"] }),
  item({ description: "rental car while the car is repaired", coverage: "vehicle", type: "auto", kind: "expense",
         category: "rental_car", search_terms: ["car rental expense"] }),
];
const extraction = { event_cause: "hurricane wind" } as Extraction;

async function main() {
  const config = agentConfig();
  const index = loadPolicyIndex();
  const client = createNemotronClient(config);
  for (const it of ITEMS) {
    const { query, pin } = itemRetrieval(it, extraction);
    const { method, chunks } = await retrieve(index, it.type, query, client, config, { pin });
    console.log(`\n[${it.type}, ${method}] ${it.description}\n  query: ${query}`);
    for (const h of chunks.slice(0, 3)) {
      console.log(`  ${h.score.toFixed(3)} ${h.chunk.chunk_id} ${h.chunk.section}\n        ${h.chunk.text.slice(0, 160)}`);
    }
    if (chunks.length > 3) console.log(`  (+${chunks.length - 3} more: ${chunks.slice(3).map((h) => h.chunk.chunk_id).join(", ")})`);
    if (!chunks.length) console.log("  (no relevant hits)");
  }
}
main();
