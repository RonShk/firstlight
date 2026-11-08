// POST /api/agent/analyze  {from, text, cache?} -> acknowledgment, analysis, update (see src/lib/agent/pipeline.ts)
// `cache: true` (sent by the simulator dashboard) reuses a saved result for the same sender and text,
// so reloading the demo doesn't re-run every household through Nemotron. Real inbound texts omit it.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { agentConfig } from "@/lib/agent/config";
import { defaultDeps, handleIncomingText, type PipelineResult } from "@/lib/agent/pipeline";

const Body = z.object({
  from: z.string().trim().min(1).max(64),
  text: z.string().trim().min(1).max(4000),
  cache: z.boolean().optional(),
});

const CACHE_DIR = path.join(process.cwd(), ".cache", "analyze");

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "body must be {from, text}", issues: parsed.error.issues }, { status: 400 });
  }
  const { cache, ...msg } = parsed.data;
  if (!cache) return Response.json(await handleIncomingText(msg, defaultDeps()));

  const key = createHash("sha256").update(JSON.stringify([agentConfig().model, msg.from, msg.text])).digest("hex").slice(0, 24);
  const file = path.join(CACHE_DIR, `${key}.json`);
  if (existsSync(file)) return Response.json(JSON.parse(readFileSync(file, "utf8")) as PipelineResult);

  const result = await handleIncomingText(msg, defaultDeps());
  // Failures aren't cached, so the next load tries the model again.
  if (result.result.status !== "agent_unavailable") {
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(file, JSON.stringify(result));
  }
  return Response.json(result);
}
