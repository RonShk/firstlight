import { z } from "zod";
import { defineTool } from "../types";

export const updatePlan = defineTool({
  name: "update_plan",
  description: "Record or revise your short investigation plan (visible to the human reviewer). Call it first, and again when new evidence changes what you will do.",
  effect: "read",
  timeoutMs: 1_000,
  input: {
    steps: z.array(z.string().trim().min(3).max(160)).min(1).max(8).describe("Ordered steps you intend to take."),
    current_step: z.number().int().min(1).max(8).optional().describe("1-based index of the step you are on."),
  },
  outputSchema: z.object({ recorded: z.literal(true) }),
  title: (i) => `Plan: ${i.steps.join(" → ")}`.slice(0, 160),
  async execute() {
    return { recorded: true as const };
  },
});
