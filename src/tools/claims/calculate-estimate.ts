// Deterministic arithmetic from the declarations: limit, which deductible applies, and an
// illustrative payable amount. Code does the money math; the model never does.
import { z } from "zod";
import { policyScope } from "../scope";
import { defineTool, ToolError } from "../types";

const WIND = /wind|hail|tornado|twister|storm|hurricane/i;

export const calculateEstimate = defineTool({
  name: "calculate_estimate",
  description: "Illustrative payout arithmetic from the customer's declarations: applicable limit and deductible for a coverage and peril, and min(loss, limit) minus deductible. " +
    "Only for losses you have a customer-stated or clearly reasonable amount for. The result is an illustration, never an approval or a payment.",
  effect: "read",
  timeoutMs: 2_000,
  input: {
    policy_id: z.string(),
    coverage: z.enum(["dwelling", "other_structures", "personal_property", "loss_of_use", "comprehensive", "collision"]),
    peril: z.string().trim().min(2).max(80).describe("Cause of loss, e.g. 'tornado wind', 'fire', 'fallen tree'."),
    estimated_loss_usd: z.number().nonnegative().max(10_000_000),
    vehicle: z.string().optional().describe("Make or model, for auto policies with several vehicles."),
  },
  outputSchema: z.object({
    policy_id: z.string(), coverage: z.string(), limit_usd: z.number().nullable(), deductible_usd: z.number(),
    deductible_basis: z.string(), estimated_loss_usd: z.number(), illustrative_payable_usd: z.number(), caveats: z.array(z.string()),
  }),
  title: (i) => `Estimate ${i.coverage.replace("_", " ")} for $${i.estimated_loss_usd.toLocaleString("en-US")} (${i.peril})`,
  async execute(input, ctx) {
    const [policy] = policyScope(ctx, input.policy_id).policies;
    const caveats = ["Illustration only: coverage must still be confirmed and the loss adjusted.", "Does not account for depreciation, sub-limits or other occurrences."];
    let limit: number | null = null;
    let deductible = 0;
    let basis = "";
    if (policy.home) {
      const h = policy.home;
      if (["comprehensive", "collision"].includes(input.coverage)) throw new ToolError("invalid_input", "That coverage belongs to an auto policy.");
      limit = input.coverage === "personal_property" ? h.coverage_b_personal_property
        : input.coverage === "loss_of_use" ? h.coverage_c_loss_of_use : h.coverage_a_dwelling;
      if (input.coverage === "other_structures") caveats.push("Other Structures is included within the Coverage A Dwelling limit on these forms.");
      if (input.coverage === "loss_of_use") { deductible = 0; basis = "No deductible applies to Coverage C Loss of Use."; }
      else if (WIND.test(input.peril)) { deductible = h.deductible_wind_hail; basis = "Wind/hail deductible (peril involves wind or hail)."; }
      else { deductible = h.deductible_all_other_perils; basis = "All-other-perils deductible."; }
    } else if (policy.auto) {
      const a = policy.auto;
      if (!["comprehensive", "collision"].includes(input.coverage)) throw new ToolError("invalid_input", "Auto policies use 'comprehensive' or 'collision'.");
      const want = input.vehicle?.toLowerCase();
      const car = a.vehicles.find((v) => want && (want.includes(v.model.toLowerCase()) || want.includes(v.make.toLowerCase()))) ?? (a.vehicles.length === 1 ? a.vehicles[0] : null);
      if (!car && a.vehicles.length > 1) caveats.push("Several vehicles on the policy; the vehicle was not identified, so no value cap applied.");
      limit = car?.value ?? null;
      deductible = input.coverage === "collision" ? a.collision_deductible : a.comprehensive_deductible;
      basis = `${input.coverage === "collision" ? "Collision" : "Comprehensive"} deductible${car ? `; capped at the ${car.year} ${car.make} ${car.model} value on file` : ""}.`;
    } else {
      throw new ToolError("invalid_input", "Umbrella policies cover liability to others; there is no first-party estimate.");
    }
    const capped = Math.min(input.estimated_loss_usd, limit ?? Infinity);
    return { policy_id: policy.policy_id, coverage: input.coverage, limit_usd: limit, deductible_usd: deductible, deductible_basis: basis,
      estimated_loss_usd: input.estimated_loss_usd, illustrative_payable_usd: Math.max(0, capped - deductible), caveats };
  },
});
