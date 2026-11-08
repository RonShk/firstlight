import type { Persona, Vehicle } from "@/types/sim";
import { AGENTS } from "@/lib/sim/data";
import type { ClaimDecision, Extent, ModelAssessment } from "./types";

/**
 * "The model decides meaning, code decides money." Turns Nemotron's assessment
 * into dollar estimates from the actual policy limits, and applies the routing rules.
 */

export const AUTO_APPROVE_CAP = 5_000;
export const HUMAN_SEVERITY = 70;
const ALE_NIGHTLY = 210;

const DWELLING_PCT: Record<Extent, number> = { minor: 0.03, moderate: 0.15, severe: 0.45, total: 1 };
const CONTENTS_PCT: Record<Extent, number> = { minor: 0.02, moderate: 0.1, severe: 0.3, total: 0.8 };
const OTHER_STRUCTURES_PCT: Record<Extent, number> = { minor: 0.005, moderate: 0.02, severe: 0.05, total: 0.1 };
const VEHICLE_PCT: Record<Extent, number> = { minor: 0.05, moderate: 0.15, severe: 0.35, total: 1 };
const ALE_NIGHTS: Record<Extent, number> = { minor: 3, moderate: 10, severe: 45, total: 120 };

const round = (n: number, step = 50) => Math.round(n / step) * step;

function matchVehicle(item: string, vehicles: Vehicle[]): Vehicle | undefined {
  const text = item.toLowerCase();
  return vehicles.find((v) => text.includes(v.model.toLowerCase()) || text.includes(v.make.toLowerCase())) ?? vehicles[0];
}

export function decide(p: Persona, a: ModelAssessment): ClaimDecision {
  const home = p.policies.find((x) => x.home)?.home;
  const auto = p.policies.find((x) => x.auto)?.auto;
  const lines: ClaimDecision["lines"] = [];
  let homeLoss = 0;
  let autoDeductibles = 0;

  for (const c of a.claims) {
    const citation = c.citation_doc_id && c.citation_quote ? { docId: c.citation_doc_id, quote: c.citation_quote } : null;
    let estimate = 0;
    let basis = "Not payable under the policy on file";
    if (c.coverage === "covered") {
      if (c.coverage_part === "dwelling" && home) {
        estimate = round(home.dwelling * DWELLING_PCT[c.extent], 100);
        basis = `${Math.round(DWELLING_PCT[c.extent] * 100)}% of Coverage A ($${home.dwelling.toLocaleString()}) for ${c.extent} damage`;
        homeLoss += estimate;
      } else if (c.coverage_part === "other_structures" && home) {
        estimate = round(home.dwelling * OTHER_STRUCTURES_PCT[c.extent]);
        basis = `Other structures, ${c.extent} damage`;
        homeLoss += estimate;
      } else if (c.coverage_part === "personal_property" && home) {
        estimate = round(home.personalProperty * CONTENTS_PCT[c.extent], 100);
        basis = `${Math.round(CONTENTS_PCT[c.extent] * 100)}% of Coverage B ($${home.personalProperty.toLocaleString()})`;
        homeLoss += estimate;
      } else if (c.coverage_part === "loss_of_use" && home) {
        const nights = ALE_NIGHTS[c.extent];
        estimate = Math.min(home.lossOfUse, nights * ALE_NIGHTLY);
        basis = `${nights} nights × $${ALE_NIGHTLY}, capped at Coverage C ($${home.lossOfUse.toLocaleString()})`;
      } else if (c.coverage_part === "vehicle" && auto?.vehicles.length) {
        const v = matchVehicle(c.item, auto.vehicles)!;
        estimate = round(v.value * VEHICLE_PCT[c.extent]);
        basis = c.extent === "total" ? `Total loss: ${v.year} ${v.make} ${v.model} value` : `${Math.round(VEHICLE_PCT[c.extent] * 100)}% of ${v.year} ${v.make} ${v.model} value`;
        autoDeductibles += auto.comprehensiveDeductible;
      } else {
        basis = "Covered, amount needs an adjuster";
      }
    }
    lines.push({ item: c.item, coverage: c.coverage, coveragePart: c.coverage_part, extent: c.extent, estimate, basis, citation });
  }

  // Tornado damage is wind damage: the wind/hail deductible applies once to the home claim.
  const homeDeductible = home && homeLoss > 0 ? Math.min(homeLoss, home.windHailDeductible) : 0;
  const deductibleApplied = homeDeductible + autoDeductibles;
  const gross = lines.reduce((s, l) => s + l.estimate, 0);
  const total = Math.max(0, gross - deductibleApplied);

  const s = a.safety;
  const contested = lines.some((l) => l.coverage !== "covered" && l.extent !== "minor");
  let route: ClaimDecision["route"];
  let routeReason: string;
  if (s.injury_reported || s.medical_urgent || s.trapped_or_missing) {
    route = "human_review";
    routeReason = "Life-safety issue reported. A person takes over immediately.";
  } else if (a.severity >= HUMAN_SEVERITY) {
    route = "human_review";
    routeReason = `Severity ${a.severity} is at or above ${HUMAN_SEVERITY}.`;
  } else if (contested) {
    route = "human_review";
    routeReason = "Coverage is excluded, unclear or missing for a significant loss.";
  } else if (a.confidence < 0.6) {
    route = "human_review";
    routeReason = `Agent confidence is low (${Math.round(a.confidence * 100)}%).`;
  } else if (lines.length === 0 || total === 0) {
    route = a.severity >= 40 ? "human_review" : "none";
    routeReason = a.severity >= 40 ? "Needs help but nothing payable yet." : "No covered loss to pay.";
  } else if (total > AUTO_APPROVE_CAP) {
    route = "human_review";
    routeReason = `Estimated $${total.toLocaleString()} is above the $${AUTO_APPROVE_CAP.toLocaleString()} auto-approval cap.`;
  } else {
    route = "auto_approve";
    routeReason = `Covered, low severity and under the $${AUTO_APPROVE_CAP.toLocaleString()} cap.`;
  }

  // Displaced households get a hotel advance right away even while a person reviews the rest.
  const ale = lines.find((l) => l.coveragePart === "loss_of_use" && l.coverage === "covered");
  const payableNow = route === "auto_approve" ? total : s.displaced && ale ? Math.min(ale.estimate, 1_500) : 0;

  return {
    route,
    routeReason,
    lines,
    total,
    payableNow,
    deductibleApplied,
    claimNumber: lines.length ? `CLM-${p.id.slice(3)}-${p.address.zip.slice(-2)}` : null,
  };
}

/** Final text to the policyholder: the model's words plus the numbers code is accountable for. */
export function composeReply(p: Persona, a: ModelAssessment, d: ClaimDecision): string {
  const agent = AGENTS.find((x) => x.id === p.agentId);
  const parts = [a.reply_text.trim()];
  if (a.safety.injury_reported || a.safety.medical_urgent || a.safety.trapped_or_missing) {
    if (!/911/.test(a.reply_text)) parts.push("If anyone needs medical help right now, call 911.");
  }
  if (d.route === "auto_approve" && d.claimNumber) {
    parts.push(`Claim ${d.claimNumber} is approved for $${d.total.toLocaleString()}. Funds are on the way.`);
  } else if (d.route === "human_review") {
    if (d.payableNow > 0) parts.push(`We're sending $${d.payableNow.toLocaleString()} now for a place to stay.`);
    if (agent) parts.push(`${agent.name}, your agent in ${agent.city}, will call you shortly.`);
  }
  if (a.follow_up_question) parts.push(a.follow_up_question.trim());
  return parts.join(" ");
}
