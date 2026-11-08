// GET /api/claim-files/:id/pdf  the claim's simulated State Farm property loss notice, rendered fresh
// so it always shows the current status and settlement.
import type { NextRequest } from "next/server";
import { ops } from "@/cases/db";
import { getClaim } from "@/cases/claim-files";
import { claimPdf } from "@/cases/claim-pdf";

export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const claim = getClaim(ops(), (await ctx.params).id);
  if (!claim) return Response.json({ error: "Claim not found" }, { status: 404 });
  const pdf = await claimPdf(claim);
  return new Response(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${claim.id}.pdf"`, "Cache-Control": "no-store" } });
}
