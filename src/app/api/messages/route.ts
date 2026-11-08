// POST /api/messages: accept a message, persist it, queue an agent run, return its id (202).
// The sender's identity is resolved here (simulator persona, or phone number on file); a client can
// never supply policy data. The agent runs in workers, not in this request.
import { z } from "zod";
import { findPolicyholder } from "@/customers/directory";
import { ops } from "@/cases/db";
import { receive } from "@/cases/intake";
import { startWorkers } from "@/workers/agent-worker";

const Turn = z.object({ from: z.enum(["policyholder", "state_farm"]), text: z.string().trim().min(1).max(4_000) });
const Body = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("simulation"), personaId: z.string().trim().min(1).max(32), conversation: z.array(Turn).min(1).max(60) }),
  z.object({ channel: z.enum(["sms", "web"]), from: z.string().trim().min(7).max(32), text: z.string().trim().min(1).max(4_000) }),
]);

export async function POST(request: Request) {
  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid message", issues: z.flattenError(parsed.error) }, { status: 400 });
  const body = parsed.data;
  const db = ops();
  let result;
  if (body.channel === "simulation") {
    const customer = findPolicyholder({ personaId: body.personaId });
    if (!customer) return Response.json({ error: `Unknown policyholder ${body.personaId}` }, { status: 404 });
    result = receive(db, { channel: "simulation", address: `sim:${customer.policyholder_id}`, customerId: customer.policyholder_id,
      turns: body.conversation.map((t) => ({ role: t.from === "policyholder" ? "customer" as const : "company" as const, text: t.text })) });
  } else {
    const customer = findPolicyholder({ phone: body.from });
    result = receive(db, { channel: body.channel, address: body.from.replace(/[^\d+]/g, ""), customerId: customer?.policyholder_id ?? null, text: body.text });
  }
  startWorkers();
  return Response.json({ caseId: result.case.id, runId: result.run?.id ?? null, runStatus: result.run?.status ?? null,
    deduplicated: result.deduplicated, appended: result.appended }, { status: 202 });
}
