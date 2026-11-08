import type { NextRequest } from "next/server";
import { ops } from "@/cases/db";
import { runView } from "@/cases/views";

export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const view = runView(ops(), (await ctx.params).id);
  return view ? Response.json(view) : Response.json({ error: "Run not found" }, { status: 404 });
}
