// Creates a claim DRAFT for an adjuster. It does not file a claim, approve anything or move money.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { json } from "../../db/sqlite";
import { now } from "../../cases/db";
import { policyScope } from "../scope";
import { defineTool, ToolError } from "../types";

export const prepareClaim = defineTool({
  name: "prepare_claim",
  description: "Create a first-notice-of-loss DRAFT for a claims adjuster, with the reported items and the evidence passages you relied on. " +
    "It does not file the claim, approve coverage or pay anything; tell the customer only that their details were passed to a claims specialist. Repeating the same draft returns the existing one.",
  effect: "write",
  timeoutMs: 3_000,
  input: {
    policy_id: z.string(),
    cause_of_loss: z.string().trim().min(2).max(120),
    items: z.array(z.object({
      description: z.string().trim().min(2).max(200),
      coverage: z.string().trim().min(2).max(60).describe("e.g. 'Coverage A Dwelling', 'Comprehensive'."),
      estimated_amount_usd: z.number().nonnegative().nullable(),
    })).min(1).max(12),
    evidence_chunk_ids: z.array(z.string()).max(12).describe("Passages (chunk_id) retrieved in this run that support the draft."),
  },
  outputSchema: z.object({ claim_draft_id: z.string(), status: z.literal("draft_pending_adjuster"), items: z.number() }),
  idempotencyKey: (i) => json([i.policy_id, i.cause_of_loss.toLowerCase(), i.items.map((x) => x.description.toLowerCase()).sort()]),
  title: (i) => `Prepare claim draft on ${i.policy_id}: ${i.items.map((x) => x.description).join(", ")}`.slice(0, 160),
  async execute(input, ctx) {
    policyScope(ctx, input.policy_id);
    const unknown = input.evidence_chunk_ids.filter((id) => !ctx.evidence.has(id));
    if (unknown.length) throw new ToolError("invalid_input", `Evidence not retrieved in this run: ${unknown.join(", ")}`);
    const id = `draft_${randomUUID().slice(0, 10)}`;
    ctx.db.run("INSERT INTO claim_drafts VALUES (?,?,?,?,?,?)", id, ctx.caseId, ctx.runId, "draft_pending_adjuster", json(input), now());
    return { claim_draft_id: id, status: "draft_pending_adjuster" as const, items: input.items.length };
  },
});
