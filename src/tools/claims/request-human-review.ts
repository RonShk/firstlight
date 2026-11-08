import { randomUUID } from "node:crypto";
import { z } from "zod";
import { now } from "../../cases/db";
import { defineTool } from "../types";

export const requestHumanReview = defineTool({
  name: "request_human_review",
  description: "Put this case in the human claims team's queue with a priority and the reason. Use for present danger, liability to others, " +
    "large or disputed losses, missing policy, or anything you cannot verify. Does not call or text anyone by itself.",
  effect: "write",
  timeoutMs: 2_000,
  input: {
    priority: z.enum(["urgent", "high", "normal"]),
    reason: z.string().trim().min(5).max(400),
  },
  outputSchema: z.object({ review_request_id: z.string(), priority: z.string(), status: z.literal("queued") }),
  // One review request per run: retries and repeated calls do not stack up duplicate tasks.
  idempotencyKey: (_i, ctx) => ctx.runId,
  title: (i) => `Request ${i.priority} human review: ${i.reason}`.slice(0, 160),
  async execute(input, ctx) {
    const id = `review_${randomUUID().slice(0, 10)}`;
    ctx.db.run("INSERT INTO review_requests VALUES (?,?,?,?,?,?,?)", id, ctx.caseId, ctx.runId, input.priority, input.reason, "queued", now());
    return { review_request_id: id, priority: input.priority, status: "queued" as const };
  },
});
