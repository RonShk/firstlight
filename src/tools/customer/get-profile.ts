import { z } from "zod";
import { defineTool, ToolError } from "../types";

export const getProfile = defineTool({
  name: "get_customer_profile",
  description: "The verified policyholder's household on file: members, ages, medical needs, mobility, vulnerability flags, housing, city and local agent. No contact details.",
  effect: "read",
  timeoutMs: 2_000,
  input: {},
  outputSchema: z.object({
    verified: z.boolean(),
    name: z.string(), housing: z.string(), household: z.string(), city: z.string(),
    members: z.array(z.object({ name: z.string(), age: z.number(), relation: z.string(), medical_needs: z.string().optional(), limited_mobility: z.boolean().optional() })),
    vulnerability_flags: z.array(z.string()),
    local_agent: z.object({ name: z.string(), city: z.string() }).nullable(),
  }),
  title: () => "Read the customer's household profile",
  async execute(_input, ctx) {
    const c = ctx.customer;
    if (!c) throw new ToolError("not_found", "The sender is not a verified policyholder. Ask for their name and policy number.");
    return {
      verified: true, name: c.name, housing: c.housing, household: c.household,
      city: c.address.split(",").slice(-2, -1)[0]?.trim() ?? "",
      members: c.members.map((m) => ({ name: m.name, age: m.age, relation: m.relation,
        ...(m.medical_needs ? { medical_needs: m.medical_needs } : {}), ...(m.limited_mobility ? { limited_mobility: true } : {}) })),
      vulnerability_flags: c.vulnerability_flags,
      local_agent: c.local_agent ? { name: c.local_agent.name, city: c.local_agent.city } : null,
    };
  },
});
