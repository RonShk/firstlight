import type { Persona } from "@/types/sim";
import { AGENTS, FORMS_BY_ID } from "@/lib/sim/data";
import { HOUSEHOLD_LABELS } from "@/lib/sim/personas";

/**
 * The policyholder file State Farm already has on record. This, the conversation
 * and the policy forms are everything the agent sees. Simulator-only fields
 * (reply likelihood, hidden damage) never leave the simulation.
 */
export function policyholderRecord(p: Persona) {
  const agent = AGENTS.find((a) => a.id === p.agentId);
  return {
    policyholder_id: p.id,
    name: p.name,
    address: `${p.address.street}, ${p.address.city}, ${p.address.state} ${p.address.zip}`,
    housing: p.housing === "own" ? "owns home" : "rents",
    household: HOUSEHOLD_LABELS[p.householdType],
    members: p.members.map((m) => ({
      name: m.name,
      age: m.age,
      relation: m.relation,
      ...(m.medicalNeeds ? { medical_needs: m.medicalNeeds } : {}),
      ...(m.limitedMobility ? { limited_mobility: true } : {}),
    })),
    vulnerability_flags: p.vulnerabilities,
    local_agent: agent ? `${agent.name} (${agent.city})` : null,
    policies: p.policies.map((pol) => {
      const form = FORMS_BY_ID[pol.formId];
      return {
        policy_id: pol.id,
        line: pol.line,
        doc_id: pol.formId,
        form: `${form.name} ${form.formNumber}`,
        ...(pol.home
          ? {
              coverage_a_dwelling: pol.home.dwelling,
              coverage_b_personal_property: pol.home.personalProperty,
              coverage_c_loss_of_use: pol.home.lossOfUse,
              deductible_all_other_perils: pol.home.deductible,
              deductible_wind_hail: pol.home.windHailDeductible,
            }
          : {}),
        ...(pol.auto
          ? {
              vehicles: pol.auto.vehicles.map((v) => `${v.year} ${v.make} ${v.model} (value ${v.value})`),
              liability_limits: pol.auto.liability,
              comprehensive_deductible: pol.auto.comprehensiveDeductible,
              collision_deductible: pol.auto.collisionDeductible,
            }
          : {}),
        ...(pol.umbrellaLimit ? { umbrella_limit: pol.umbrellaLimit } : {}),
      };
    }),
  };
}
