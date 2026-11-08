// GET /api/runs/:id/events: Server-Sent Events stream of a run's audit events, in order.
// Resumable via Last-Event-ID / ?after=<seq>. Closes once the run is finished and delivery settled.
import type { NextRequest } from "next/server";
import { ops } from "@/cases/db";
import { bus, runEvents, type CaseEvent } from "@/cases/events";
import { getRun } from "@/cases/runs";
import { outboxFor } from "@/delivery/outbox";

const TERMINAL = new Set(["completed", "failed", "superseded"]);
const SETTLED = new Set(["sent", "failed", "cancelled", "held"]);

export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const db = ops();
  const run = getRun(db, id);
  if (!run) return Response.json({ error: "Run not found" }, { status: 404 });
  let after = Number(request.headers.get("last-event-id") ?? request.nextUrl.searchParams.get("after") ?? 0) || 0;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const send = (e: CaseEvent) => controller.enqueue(encoder.encode(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`));
      const flush = () => {
        if (closed) return;
        for (const e of runEvents(db, id)) if (e.seq > after) { send(e); after = e.seq; }
        const r = getRun(db, id);
        const out = outboxFor(db, id);
        if (r && TERMINAL.has(r.status) && (r.status !== "completed" || (out && SETTLED.has(out.status)))) close();
      };
      const onEvent = (e: CaseEvent) => { if (e.runId === id) flush(); };
      const poll = setInterval(flush, 1_000); // other worker processes write to the same DB
      const ping = setInterval(() => !closed && controller.enqueue(encoder.encode(": ping\n\n")), 15_000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(poll); clearInterval(ping);
        bus.off(`case:${run.caseId}`, onEvent);
        controller.enqueue(encoder.encode("event: end\ndata: {}\n\n"));
        controller.close();
      };
      bus.on(`case:${run.caseId}`, onEvent);
      request.signal.addEventListener("abort", () => { if (!closed) { closed = true; clearInterval(poll); clearInterval(ping); bus.off(`case:${run.caseId}`, onEvent); } });
      flush();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" } });
}
