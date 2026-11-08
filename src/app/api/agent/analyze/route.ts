// POST /api/agent/analyze  {from, text} -> acknowledgment, analysis, update (see src/lib/agent/pipeline.ts)

import { z } from "zod";
import { defaultDeps, handleIncomingText } from "@/lib/agent/pipeline";

const Body = z.object({
  from: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(4000),
});

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "body must be {from, text}", issues: parsed.error.issues }, { status: 400 });
  }
  return Response.json(await handleIncomingText(parsed.data, defaultDeps()));
}
