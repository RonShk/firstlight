/**
 * Writes the deterministic simulated population to data/ so non-UI code
 * (Nemotron agent, RAG, Photon intake) can use the exact same people.
 *   npm run personas
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { AGENTS, POLICY_FORMS } from "../src/lib/sim/data";
import { generatePersonas, PERSONA_SEED } from "../src/lib/sim/personas";

const personas = generatePersonas();
mkdirSync("data", { recursive: true });
writeFileSync("data/personas.json", JSON.stringify({ seed: PERSONA_SEED, count: personas.length, personas }, null, 1));
writeFileSync("data/agents.json", JSON.stringify(AGENTS, null, 1));
writeFileSync("data/policy_forms.json", JSON.stringify(POLICY_FORMS, null, 1));
console.log(`Wrote ${personas.length} personas, ${AGENTS.length} agents, ${POLICY_FORMS.length} policy forms to data/`);
