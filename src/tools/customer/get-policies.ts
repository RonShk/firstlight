import { z } from "zod";
import { POLICY_LINES } from "../../knowledge/documents";
import { defineTool, ToolError } from "../types";

export const getPolicies = defineTool({
  name: "get_policies",
  description: "The customer's policies with declarations: policy id, line (home/auto/umbrella), form, limits and deductibles. Lines with no policy are listed as absent. Declarations are customer data; use search_policy for the policy wording.",
  effect: "read",
  timeoutMs: 2_000,
  input: {},
  outputSchema: z.object({
    policies: z.array(z.object({
      policy_id: z.string(), line: z.enum(POLICY_LINES), form: z.string(), form_number: z.string(),
      declarations: z.record(z.string(), z.unknown()),
    })),
    lines_without_policy: z.array(z.enum(POLICY_LINES)),
    note: z.string(),
  }),
  title: () => "Read the customer's policies and declarations",
  async execute(_input, ctx) {
    const c = ctx.customer;
    if (!c) throw new ToolError("not_found", "The sender is not a verified policyholder; no policies can be looked up.");
    return {
      policies: c.policies.map((p) => ({
        policy_id: p.policy_id, line: p.line, form: p.form, form_number: p.form_number,
        declarations: p.home ? { ...p.home, note: "On these State Farm forms Other Structures is included in Coverage A Dwelling." }
          : p.auto ? { ...p.auto } : { umbrella_limit: p.umbrella_limit ?? null },
      })),
      lines_without_policy: POLICY_LINES.filter((l) => !c.policies.some((p) => p.line === l)),
      note: "The record does not list purchased optional endorsements; treat optional coverages as unknown unless verified.",
    };
  },
});
