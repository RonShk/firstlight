import type { NextRequest } from "next/server";
import { ops } from "@/cases/db";
import { caseView } from "@/cases/views";

export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const view = caseView(ops(), (await ctx.params).id);
  return view ? Response.json(view) : Response.json({ error: "Case not found" }, { status: 404 });
}
