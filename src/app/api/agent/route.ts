import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getPersona } from "@/lib/sim/personas";
import { agentConfig, runAgent } from "@/lib/agent/nemotron";
import { loadedPolicyDocs } from "@/lib/agent/policy-search";
import type { AgentRequest, AgentResult, AgentStatus } from "@/lib/agent/types";
import { connection } from "next/server";

/** Results are cached on disk by conversation, so re-running the demo doesn't spend credit. */
const CACHE_DIR = path.join(process.cwd(), ".cache", "agent");

function cacheKey(req: AgentRequest, model: string): string {
  return createHash("sha256").update(JSON.stringify([model, req.personaId, req.conversation])).digest("hex").slice(0, 24);
}

export async function GET() {
  // Read config at request time, not at build time.
  await connection();
  const { configured, model, baseUrl } = agentConfig();
  const status: AgentStatus = { configured, model: model || null, baseUrl: configured ? baseUrl : null, policiesLoaded: loadedPolicyDocs() };
  return Response.json(status);
}

export async function POST(request: Request) {
  const config = agentConfig();
  if (!config.configured) {
    return Response.json({ error: "Agent not configured. Set NEMOTRON_MODEL (and NEMOTRON_API_KEY for the hosted API) in .env.local." }, { status: 503 });
  }
  let body: AgentRequest;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const persona = getPersona(String(body.personaId));
  if (!persona) return Response.json({ error: "Unknown policyholder" }, { status: 404 });
  const conversation = Array.isArray(body.conversation)
    ? body.conversation
        .filter((m) => m && (m.from === "policyholder" || m.from === "state_farm") && typeof m.text === "string")
        .map((m) => ({ from: m.from, text: m.text.slice(0, 2_000) }))
        .slice(-20)
    : [];
  if (!conversation.some((m) => m.from === "policyholder")) return Response.json({ error: "No message from the policyholder" }, { status: 400 });

  const req: AgentRequest = { personaId: persona.id, conversation };
  const file = path.join(CACHE_DIR, `${cacheKey(req, config.model)}.json`);
  if (!body.fresh && existsSync(file)) {
    const cached = JSON.parse(readFileSync(file, "utf8")) as AgentResult;
    return Response.json({ ...cached, cached: true });
  }
  try {
    const result = await runAgent(persona, req);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(result));
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 502 });
  }
}
