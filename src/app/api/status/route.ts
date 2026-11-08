// GET /api/status: which NVIDIA services and data are configured, for the UI header.
import { connection } from "next/server";
import { chatConfigured, config } from "@/config";
import { ops } from "@/cases/db";
import { queueStats, type QueueStats } from "@/cases/progress";
import { knowledge, knowledgeAvailable } from "@/knowledge/store";

export interface AgentStatus {
  configured: boolean;
  model: string | null;
  services: { embeddings: string | null; reranker: string | null; guard: string | null; verifier: boolean };
  knowledge: { documents: number; chunks: number; embedModel: string | null } | null;
  queue: QueueStats | null;
}

export async function GET() {
  await connection();
  const c = config();
  let kb: AgentStatus["knowledge"] = null;
  if (knowledgeAvailable()) {
    const store = knowledge();
    kb = { documents: store.documents().length, chunks: store.sql.get<{ n: number }>("SELECT COUNT(*) AS n FROM chunks")!.n, embedModel: store.meta("embed_model") };
  }
  const status: AgentStatus = {
    configured: chatConfigured(c) && !!kb,
    model: c.chat.model || null,
    services: { embeddings: c.nvidiaKey ? c.embed.model : null, reranker: c.rerank?.model ?? null, guard: c.guard?.model ?? null,
      verifier: process.env.AGENT_VERIFIER !== "off" },
    knowledge: kb,
    queue: queueStats(ops()),
  };
  return Response.json(status);
}
