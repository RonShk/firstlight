// GET /api/agent -> is the Nemotron agent configured? The frontend sends texts to /api/agent/analyze.

import { connection } from "next/server";
import { agentConfig } from "@/lib/agent/config";
import { loadPolicyIndex } from "@/lib/agent/policy-docs";
import type { AgentStatus } from "@/lib/agent/types";

export async function GET() {
  // Read config at request time, not at build time.
  await connection();
  const { apiKey, model, baseUrl } = agentConfig();
  const configured = !!apiKey && !!model;
  let policiesLoaded: string[] = [];
  try {
    policiesLoaded = loadPolicyIndex().documents.filter((d) => d.status === "indexed").map((d) => d.doc_id);
  } catch {
    // No index built yet; retrieval will find nothing and items go to human review.
  }
  const status: AgentStatus = { configured, model: model || null, baseUrl: configured ? baseUrl : null, policiesLoaded };
  return Response.json(status);
}
