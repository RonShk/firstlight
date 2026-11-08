// POST /api/cases/:id/review: human reviewer actions. Each becomes a new audit event; nothing in the
// history is overwritten. "request_investigation" queues a new agent run that sees the reviewer note.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { config } from "@/config";
import { PROMPT_VERSION } from "@/agent/schemas";
import { ops } from "@/cases/db";
import { appendEvent } from "@/cases/events";
import { getCase } from "@/cases/repository";
import { enqueueRun } from "@/cases/runs";
import { releaseHeld } from "@/delivery/outbox";
import { startWorkers } from "@/workers/agent-worker";

const Action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request_investigation"), note: z.string().trim().min(3).max(1_000) }),
  z.object({ action: z.literal("correct_finding"), run_id: z.string(), finding_index: z.number().int().min(0).max(20),
    status: z.enum(["likely_covered", "likely_excluded", "unclear", "no_policy"]).optional(), note: z.string().trim().min(3).max(1_000) }),
  z.object({ action: z.literal("approve_reply"), outbox_id: z.string() }),
  z.object({ action: z.literal("note"), note: z.string().trim().min(1).max(1_000) }),
]);

// No authentication in this demo: every action is attributed to one reviewer identity.
const REVIEWER = "demo-reviewer";

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = ops();
  if (!getCase(db, id)) return Response.json({ error: "Case not found" }, { status: 404 });
  const parsed = Action.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid action", issues: z.flattenError(parsed.error) }, { status: 400 });
  const a = parsed.data;
  switch (a.action) {
    case "request_investigation": {
      appendEvent(db, { caseId: id, actor: "reviewer", type: "reviewer.investigation_requested", title: "Reviewer requested further investigation", detail: { note: a.note, by: REVIEWER } });
      const { run } = enqueueRun(db, { caseId: id, trigger: "reviewer", note: a.note, model: config().chat.model || "unconfigured", promptVersion: PROMPT_VERSION });
      startWorkers();
      return Response.json({ ok: true, runId: run.id }, { status: 202 });
    }
    case "correct_finding":
      appendEvent(db, { caseId: id, runId: a.run_id, actor: "reviewer", type: "reviewer.correction",
        title: `Reviewer corrected finding ${a.finding_index + 1}${a.status ? ` to ${a.status.replace("_", " ")}` : ""}`, detail: { ...a, by: REVIEWER } });
      return Response.json({ ok: true });
    case "approve_reply":
      return releaseHeld(db, a.outbox_id, REVIEWER) ? Response.json({ ok: true }) : Response.json({ error: "No held reply with that id" }, { status: 409 });
    case "note":
      appendEvent(db, { caseId: id, actor: "reviewer", type: "reviewer.note", title: "Reviewer note", detail: { note: a.note, by: REVIEWER } });
      return Response.json({ ok: true });
  }
}
