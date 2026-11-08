// Smoke test against the live endpoints (reads .env.local; never prints keys):
//   1. chat model: tool call -> tool result -> final answer (tool calling on our Brev vLLM server)
//   2. the pipeline's own prompts return valid JSON (danger check, extraction)
//   3. a query embedding from the NVIDIA hosted embedding model
// Usage: npm run agent:smoke. Exits non-zero with the real error on the first failure.

import { existsSync } from "node:fs";
import OpenAI from "openai";
import { agentConfig } from "../src/lib/agent/config";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

const TOOL: OpenAI.Chat.ChatCompletionTool = {
  type: "function",
  function: {
    name: "lookup_policy",
    description: "Return the policy on file for a policyholder.",
    parameters: { type: "object", properties: { policyholder_id: { type: "string" } }, required: ["policyholder_id"] },
  },
};

const elapsed = (t0: number) => `${((performance.now() - t0) / 1000).toFixed(1)}s`;

async function main(): Promise<number> {
  const config = agentConfig();
  console.log(`chat:  model=${config.model || "(unset)"} base_url=${config.baseUrl}`);
  console.log(`embed: model=${config.embedModel} base_url=${config.embedBaseUrl}`);
  if (!config.apiKey || !config.model) {
    console.log("FAIL NEMOTRON_API_KEY and NEMOTRON_MODEL must be set");
    return 1;
  }

  // 1. Tool calling.
  let t0 = performance.now();
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl, timeout: 60_000 });
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: "Use the provided tools to answer." },
    { role: "user", content: "Which policy does policyholder PH-1 have? Use the tool." },
  ];
  const first = await client.chat.completions.create({ model: config.model, messages, tools: [TOOL], temperature: 0 });
  const call = first.choices[0].message.tool_calls?.[0];
  if (!call || call.type !== "function") {
    console.log(`FAIL no tool call returned; content=${JSON.stringify(first.choices[0].message.content)}`);
    return 2;
  }
  console.log(`tool_call: ${call.function.name}(${call.function.arguments})`);
  messages.push(first.choices[0].message, {
    role: "tool",
    tool_call_id: call.id,
    content: JSON.stringify({ policyholder_id: "PH-1", policy: "Homeowners HW-2143", dummy: true }),
  });
  const final = await client.chat.completions.create({ model: config.model, messages, tools: [TOOL], temperature: 0 });
  console.log(`final: ${JSON.stringify(final.choices[0].message.content)}`);
  console.log(`OK tool calling verified (${elapsed(t0)})`);

  // 2. The pipeline's prompts, through the pipeline's own client and validation.
  const { createNemotronClient } = await import("../src/lib/agent/nemotron");
  const { loadPolicyIndex } = await import("../src/lib/agent/policy-docs");
  const { checkDanger, extractClaim } = await import("../src/lib/agent/analyze");
  const deps = { config, client: createNemotronClient(config), index: loadPolicyIndex() };
  t0 = performance.now();
  const danger = await checkDanger("ayuda el agua sube", deps);
  console.log(`danger check: ${JSON.stringify(danger)} (${elapsed(t0)})`);
  t0 = performance.now();
  const ex = await extractClaim("Power was out two days, about $300 of food in the fridge spoiled. We're fine.", deps);
  console.log(`extraction: is_claim=${ex.is_claim} items=${JSON.stringify(ex.items.map((i) => [i.category, i.triage]))} (${elapsed(t0)})`);
  console.log("OK pipeline prompts return valid JSON");

  // 3. Embeddings.
  if (!config.embedApiKey) {
    console.log("SKIP embeddings: NEMOTRON_EMBED_API_KEY not set (retrieval will be lexical)");
    return 0;
  }
  t0 = performance.now();
  const [vector] = await deps.client.embed(["hotel while the house is repaired"], "query");
  console.log(`OK query embedding: ${vector.length} dimensions (${elapsed(t0)})`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.log(`FAIL ${(e as Error).name}: ${(e as Error).message}`);
    process.exit(1);
  });
