import { z } from "zod";
import { findPolicyholder } from "@/customers/directory";
import { ops } from "@/cases/db";
import { receiveSimulationBatch } from "@/cases/intake";
import { runSummary } from "@/cases/views";
import { queueStats } from "@/cases/progress";
import { startWorkers } from "@/workers/agent-worker";

const Body = z.object({ messages: z.array(z.object({
  personaId: z.string().trim().min(1).max(32),
  conversation: z.array(z.object({ from: z.enum(["policyholder", "state_farm"]), text: z.string().trim().min(1).max(4000) })).min(1).max(60),
})).min(1).max(500) });

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message batch" }, { status: 400 });
  if (parsed.data.messages.some((m) => !findPolicyholder({ personaId: m.personaId }))) return Response.json({ error: "Unknown policyholder in batch" }, { status: 404 });
  const db = ops();
  const received = receiveSimulationBatch(db, parsed.data.messages);
  const stats = queueStats(db);
  const runs = received.flatMap(({ personaId, result }) => result.run ? [{ personaId, run: runSummary(db, result.run, stats) }] : []);
  startWorkers();
  return Response.json({ runs }, { status: 202 });
}
