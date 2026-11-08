// POST /api/claim-files/:id/decision {decision: "confirm"} | {decision: "deny", note}
// Confirming a drafted claim files it; denying closes it with a reason.
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ops } from "@/cases/db";
import { decideClaim } from "@/cases/claim-files";

const Body = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("confirm"), note: z.string().max(1000).optional() }),
  z.object({ decision: z.literal("deny"), note: z.string().trim().min(3).max(1000) }),
]);

export async function POST(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const p = Body.safeParse(await request.json().catch(() => null));
  if (!p.success) return Response.json({ error: "Confirm the claim, or deny it with a reason." }, { status: 400 });
  try {
    return Response.json(decideClaim(ops(), (await ctx.params).id, p.data));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
