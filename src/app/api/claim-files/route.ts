// GET  /api/claim-files[?caseId=]  filed claims (auto-files any case whose verified review is ready first)
// POST /api/claim-files {caseId}    file a claim manually, wherever the agent is in its review
import type { NextRequest } from "next/server";
import { z } from "zod";
import { ops } from "@/cases/db";
import { autoFileReady, claimFiles, claimForCase, fileClaim } from "@/cases/claim-files";

export async function GET(request: NextRequest) {
  const db = ops();
  autoFileReady(db);
  const caseId = request.nextUrl.searchParams.get("caseId");
  if (caseId) return Response.json({ claim: claimForCase(db, caseId) });
  return Response.json({ claims: claimFiles(db) });
}

export async function POST(request: Request) {
  const p = z.object({ caseId: z.string().min(1) }).safeParse(await request.json().catch(() => null));
  if (!p.success) return Response.json({ error: "Choose a case to file." }, { status: 400 });
  try {
    return Response.json(fileClaim(ops(), p.data.caseId, "manual"));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
