import type { NextRequest } from "next/server";
import { ops } from "@/cases/db";
import { artifact } from "@/cases/events";

export async function GET(_request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const a = artifact(ops(), (await ctx.params).id);
  return a ? Response.json(a) : Response.json({ error: "Artifact not found" }, { status: 404 });
}
