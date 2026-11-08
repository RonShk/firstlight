/**
 * Which policy document to show for a claim. Only three kinds are valid (auto, homeowners, umbrella),
 * and a claim shows at most one of each: the form that best fits this person, for the lines the
 * claim actually involves and the policyholder actually holds.
 */
import type { Persona, Policy, PolicyLine } from "../../types/sim";
import type { CoverageLayer, DocumentForm, Peril, SelectedDocument } from "../../types/claims";
import { POLICY_FORMS } from "../sim/data";
import { money } from "../sim/status";

const PDF_PAGES: Record<string, number> = {
  "SF-AUTO-TX": 43,
  "SF-AUTO-MT": 39,
  "SF-BIZAUTO-OH": 44,
  "SF-HOME-CA": 42,
  "SF-HOME-ME": 45,
  "SF-HOME-OK": 40,
  "SF-HOME-TX": 42,
  "SF-UMB-CASE-HI": 15,
  "SF-UMB-CASE-OH": 12,
};

/** Forms in data/policies/manifest.csv that POLICY_FORMS (the persona generator's list) leaves out. */
const EXTRA_FORMS = [
  { id: "SF-HOME-TX", line: "home", name: "Homeowners Policy", formNumber: "HW-2143", state: "TX", personaFit: "homeowning family/couple", url: "" },
  { id: "SF-UMB-CASE-HI", line: "umbrella", name: "Court filing quoting umbrella policy language", formNumber: "FP-7950.2", state: "HI", personaFit: "parent with resident adult child", url: "" },
  { id: "SF-UMB-CASE-OH", line: "umbrella", name: "Court opinion on umbrella policy language", formNumber: "n/a", state: "OH", personaFit: "married couple", url: "" },
] as const;

export const DOCUMENT_FORMS: Record<string, DocumentForm> = Object.fromEntries(
  [...POLICY_FORMS, ...EXTRA_FORMS].map((f) => [f.id, { ...f, pages: PDF_PAGES[f.id] ?? 1, hasPdf: f.id in PDF_PAGES }]),
);

/** The saved text of the umbrella overview page, the only form we have no PDF for. */
export const UMBRELLA_OVERVIEW = {
  intro: "If you experience a major insurance claim or lawsuit, your underlying policies such as auto, homeowners, or boat owners may not provide enough liability coverage. A State Farm® Personal Liability Umbrella Policy may provide the additional liability coverage you need to help protect your financial future.",
  provides: [
    "Additional liability protection at a reasonable price",
    "Protection against personal claims, such as defamation of character, libel, or slander, that may not be covered by your other policies",
    "Minimum coverage of $1 million for covered claims, which can be increased in $1 million increments",
  ],
  examples: [
    ["Auto", "While driving, you change lanes and cause an accident, which results in multiple injuries to passengers of another vehicle."],
    ["Home", "While cooking, you leave your stove unattended. In addition to damaging your property, the fire also damages your neighbor's property and injures your neighbors. As a result, you may have to pay for any repairs to your neighbor's dwelling in addition to any injury claims."],
  ],
  disclosure: "This document contains only a general description of the State Farm Personal Liability Umbrella Policy coverage and is not a statement of contract. All coverages are subject to all policy provisions and minimum underlying insurance requirements.",
};

const head = (p: Persona) => p.members[0];
const married = (p: Persona) => p.members.some((m) => m.relation === "spouse");

function bestAutoForm(p: Persona, policy: Policy): { id: string; why: string } {
  if (p.selfEmployed) return { id: "SF-BIZAUTO-OH", why: `Self-employed: ${p.occupation.toLowerCase()}` };
  if (head(p).age >= 62) return { id: "SF-AUTO-MT", why: `Older driver, age ${head(p).age}` };
  // Rural isn't kept on the persona, but it's the only other reason the generator assigns this form.
  if (policy.formId === "SF-AUTO-MT") return { id: "SF-AUTO-MT", why: "Rural driver" };
  return { id: "SF-AUTO-TX", why: `${married(p) ? "Married" : "Single"} driver, age ${head(p).age}` };
}

function bestHomeForm(p: Persona, policy: Policy): { id: string; why: string } {
  const local = Object.values(DOCUMENT_FORMS).find((f) => f.line === "home" && f.state === p.address.state);
  return local ? { id: local.id, why: `Home in ${p.address.state}` } : { id: policy.formId, why: "Form on file" };
}

function bestUmbrellaForm(p: Persona, policy: Policy): { id: string; why: string } {
  const adultChild = p.members.find((m) => m.relation === "child" && m.age >= 18);
  if (adultChild) return { id: "SF-UMB-CASE-HI", why: `Parent with adult child at home, age ${adultChild.age}` };
  if (p.members.some((m) => m.relation === "child" && m.age >= 16)) return { id: "SF-UMB-WEB", why: "Teen driver in household" };
  if ((policy.umbrellaLimit ?? 0) >= 2_000_000) return { id: "SF-UMB-WEB", why: "High-value household" };
  if (married(p)) return { id: "SF-UMB-CASE-OH", why: "Married couple" };
  return { id: "SF-UMB-WEB", why: "Single policyholder" };
}

const BEST_FORM = { auto: bestAutoForm, home: bestHomeForm, umbrella: bestUmbrellaForm };

/** One document per line the claim involves, skipping lines this person has no policy for. Umbrella last. */
export function selectDocuments(p: Persona, lines: PolicyLine[]): SelectedDocument[] {
  const ordered = [...new Set(lines)].sort((a, b) => Number(a === "umbrella") - Number(b === "umbrella"));
  return ordered.flatMap((line) => {
    const policy = p.policies.find((x) => x.line === line);
    if (!policy) return [];
    const { id, why } = BEST_FORM[line](p, policy);
    return [{ line, policy, form: DOCUMENT_FORMS[id], why }];
  });
}

export const LINE_LABEL: Record<PolicyLine, string> = { auto: "Auto", home: "Home", umbrella: "Umbrella" };

/** "250/500/250" → "$250,000 per person / $500,000 per accident". */
function liabilityLimits(split: string): string {
  const [person, accident] = split.split("/").map((n) => money(Number(n) * 1_000));
  return `${person} per person / ${accident} per accident`;
}

const PHYSICAL_DAMAGE_COLLISION: Peril[] = ["Collision", "Liability", "Rental"];

/** The coverages that respond to this claim. Each note says what the layer pays for, or when it starts. */
export function coverageLayers(p: Persona, lines: PolicyLine[], peril: Peril): CoverageLayer[] {
  const of = (line: PolicyLine) => p.policies.find((x) => x.line === line);
  const liability = lines.includes("umbrella");
  const umbrella = of("umbrella");
  const layers: CoverageLayer[] = [];

  if (lines.includes("auto")) {
    const auto = of("auto")?.auto;
    if (!auto) layers.push({ name: "Auto", amount: "None", note: "No auto policy on file" });
    else {
      if (PHYSICAL_DAMAGE_COLLISION.includes(peril)) layers.push({ name: "Collision", amount: `${money(auto.collisionDeductible)} deductible`, note: "Repairs to the policyholder's vehicle" });
      else layers.push({ name: "Comprehensive", amount: `${money(auto.comprehensiveDeductible)} deductible`, note: "Repairs to the policyholder's vehicle" });
      if (liability) layers.push({ name: "Auto liability", amount: liabilityLimits(auto.liability), note: "Other people's injuries and damage" });
    }
  }

  if (lines.includes("home")) {
    const home = of("home")?.home;
    if (!home) layers.push({ name: "Homeowners", amount: "None", note: "No homeowners policy on file" });
    else {
      const windOrHail = peril === "Tornado" || peril === "Wind" || peril === "Hail";
      const deductible = windOrHail ? `After ${money(home.windHailDeductible)} wind/hail deductible` : `After ${money(home.deductible)} deductible`;
      layers.push({ name: "Dwelling", amount: money(home.dwelling), note: deductible });
      layers.push({ name: "Personal property", amount: money(home.personalProperty), note: deductible });
      layers.push({ name: "Loss of use", amount: money(home.lossOfUse), note: "If the home can't be lived in" });
    }
  }

  if (liability && umbrella?.umbrellaLimit) {
    layers.push({ name: "Umbrella", amount: money(umbrella.umbrellaLimit), note: `Starts once ${lines.includes("auto") ? "auto" : "home"} liability limits are used up` });
  }
  return layers;
}

export function appliesNote(line: PolicyLine, lines: PolicyLine[], peril: Peril): string {
  if (line === "umbrella") {
    const under = lines.includes("auto") ? "auto" : "home";
    return `Excess liability if another party's injuries or damage exceed ${under} limits`;
  }
  if (line === "auto") return `Primary coverage for the ${peril === "Tornado" ? "storm damage to the vehicle" : peril === "Rental" ? "rental" : "vehicle damage, towing, and rental"}`;
  return `Primary coverage for the ${peril === "General" ? "reported loss" : `${peril.toLowerCase()} damage`} and additional living expenses`;
}
