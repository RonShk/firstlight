// The policyholder file State Farm already has on record: who lives there, and every policy with its
// declarations (limits, deductibles). Resolved by the server from the case, never from request
// bodies or model arguments. Simulator-only fields (hidden damage, reply likelihood) never leave the simulation.

import type { Persona } from "@/types/sim";
import { AGENTS, FORMS_BY_ID } from "@/lib/sim/data";
import { HOUSEHOLD_LABELS, getPersona, getPersonas } from "@/lib/sim/personas";
import type { PolicyLine } from "@/knowledge/documents";

export interface PolicyOnFile {
  policy_id: string;
  line: PolicyLine;
  doc_id: string; // the form in data/policies; retrieval is restricted to it
  form: string;
  form_number: string;
  home?: {
    coverage_a_dwelling: number; // includes Other Structures on State Farm homeowners forms
    coverage_b_personal_property: number;
    coverage_c_loss_of_use: number;
    deductible_all_other_perils: number;
    deductible_wind_hail: number;
  };
  auto?: {
    vehicles: { year: number; make: string; model: string; value: number }[];
    liability_limits: string;
    comprehensive_deductible: number;
    collision_deductible: number;
  };
  umbrella_limit?: number;
}

export interface PolicyholderFile {
  policyholder_id: string;
  name: string;
  phone: string;
  address: string;
  housing: "owns home" | "rents";
  household: string;
  members: { name: string; age: number; relation: string; medical_needs?: string; limited_mobility?: true }[];
  vulnerability_flags: string[];
  local_agent: { name: string; city: string; phone: string } | null;
  policies: PolicyOnFile[];
}

export function policyholderRecord(p: Persona): PolicyholderFile {
  const agent = AGENTS.find((a) => a.id === p.agentId);
  return {
    policyholder_id: p.id,
    name: p.name,
    phone: p.phone,
    address: `${p.address.street}, ${p.address.city}, ${p.address.state} ${p.address.zip}`,
    housing: p.housing === "own" ? "owns home" : "rents",
    household: HOUSEHOLD_LABELS[p.householdType],
    members: p.members.map((m) => ({
      name: m.name,
      age: m.age,
      relation: m.relation,
      ...(m.medicalNeeds ? { medical_needs: m.medicalNeeds } : {}),
      ...(m.limitedMobility ? { limited_mobility: true as const } : {}),
    })),
    vulnerability_flags: p.vulnerabilities,
    local_agent: agent ? { name: agent.name, city: agent.city, phone: agent.phone } : null,
    policies: p.policies.map((pol) => {
      const form = FORMS_BY_ID[pol.formId];
      return {
        policy_id: pol.id,
        line: pol.line,
        doc_id: pol.formId,
        form: form.name,
        form_number: form.formNumber,
        ...(pol.home
          ? {
              home: {
                coverage_a_dwelling: pol.home.dwelling,
                coverage_b_personal_property: pol.home.personalProperty,
                coverage_c_loss_of_use: pol.home.lossOfUse,
                deductible_all_other_perils: pol.home.deductible,
                deductible_wind_hail: pol.home.windHailDeductible,
              },
            }
          : {}),
        ...(pol.auto
          ? {
              auto: {
                vehicles: pol.auto.vehicles.map((v) => ({ ...v })),
                liability_limits: pol.auto.liability,
                comprehensive_deductible: pol.auto.comprehensiveDeductible,
                collision_deductible: pol.auto.collisionDeductible,
              },
            }
          : {}),
        ...(pol.umbrellaLimit ? { umbrella_limit: pol.umbrellaLimit } : {}),
      };
    }),
  };
}

const digits = (s: string) => s.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");

/** The file for a policyholder id, or for the phone number a text came from. Null when not on file. */
export function findPolicyholder({ personaId, phone }: { personaId?: string; phone?: string }): PolicyholderFile | null {
  if (personaId) {
    const p = getPersona(personaId);
    return p ? policyholderRecord(p) : null;
  }
  const want = phone ? digits(phone) : "";
  if (want.length < 10) return null;
  const p = getPersonas().find((x) => digits(x.phone) === want);
  return p ? policyholderRecord(p) : null;
}

/** This customer's policies of one line. */
export const policiesOn = (file: PolicyholderFile, line: PolicyLine) => file.policies.filter((p) => p.line === line);

/**
 * Index documents that carry a form's wording. The umbrella form itself is a short overview; the two
 * court filings quote the same FP-7950 contract language.
 */
const RELATED_DOCS: Record<string, string[]> = {
  "SF-UMB-WEB": ["SF-UMB-WEB", "SF-UMB-CASE-HI", "SF-UMB-CASE-OH"],
};

export const policyDocIds = (policies: PolicyOnFile[]) =>
  [...new Set(policies.flatMap((p) => RELATED_DOCS[p.doc_id] ?? [p.doc_id]))];
