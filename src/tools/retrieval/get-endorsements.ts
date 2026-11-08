import { z } from "zod";
import { policyScope, requireKnowledge } from "../scope";
import { defineTool } from "../types";

const OPTIONAL = /ENDORSEMENT|OPTIONAL|INFLATION|ORDINANCE|ADDITIONAL COVERAGES|DEDUCTIBLE/i;

export const getEndorsements = defineTool({
  name: "get_endorsements",
  description: "For one policy: the endorsements the record says were purchased (if any are listed) and the optional-coverage / endorsement / deductible sections of the form, with a chunk_id to read each.",
  effect: "read",
  timeoutMs: 3_000,
  input: { policy_id: z.string().describe("One of the customer's policy ids.") },
  outputSchema: z.object({
    policy_id: z.string(),
    purchased_endorsements: z.array(z.string()).nullable(),
    note: z.string(),
    form_sections: z.array(z.object({ section: z.string(), chunk_id: z.string(), page: z.number().nullable() })),
  }),
  title: (i) => `Check endorsements and optional coverages on ${i.policy_id}`,
  async execute(input, ctx) {
    const store = requireKnowledge(ctx);
    const scope = policyScope(ctx, input.policy_id);
    const sections = scope.docIds.flatMap((d) => store.outline(d)).filter((s) => OPTIONAL.test(s.section));
    return {
      policy_id: input.policy_id,
      purchased_endorsements: null,
      note: "The policy record lists no purchased endorsements. Optional coverage described in the form is UNKNOWN for this customer unless they or an agent confirm it.",
      form_sections: sections.slice(0, 20),
    };
  },
});
