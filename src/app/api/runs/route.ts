// GET /api/runs?ids=a,b,c: run summaries in one request (the simulator tracks many runs at once).
import type { NextRequest } from "next/server";
import { ops } from "@/cases/db";
import { getRun } from "@/cases/runs";
import { queueStats } from "@/cases/progress";
import { runSummary } from "@/cases/views";

export async function GET(request: NextRequest) {
  const ids = (request.nextUrl.searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  const db = ops();
  const queue = queueStats(db);
  const runs = ids.flatMap((id) => { const r = getRun(db, id); return r ? [runSummary(db, r, queue)] : []; });
  return Response.json({ runs, queue });
}
