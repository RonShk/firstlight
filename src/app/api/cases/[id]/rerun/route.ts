// POST /api/cases/:id/rerun: start a fresh agent run on the case's current conversation, even if the
// last run failed or already completed. Earlier runs and their history are kept.
import type { NextRequest } from "next/server";
import { config } from "@/config";
import { PROMPT_VERSION } from "@/agent/schemas";
import { ops } from "@/cases/db";
import { getCase, lastCustomerSeq } from "@/cases/repository";
import { enqueueRun } from "@/cases/runs";
import { startWorkers } from "@/workers/agent-worker";

export async function POST(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = ops();
  if (!getCase(db, id)) return Response.json({ error: "Case not found" }, { status: 404 });
  if (!lastCustomerSeq(db, id)) return Response.json({ error: "No customer message to process" }, { status: 409 });
  const { run } = enqueueRun(db, { caseId: id, trigger: "message", model: config().chat.model || "unconfigured", promptVersion: PROMPT_VERSION, force: true });
  startWorkers();
  return Response.json({ caseId: id, runId: run.id }, { status: 202 });
}
