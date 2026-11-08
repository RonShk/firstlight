import type { RunSummary } from "../../types/agent";

/** Display wording only. Original decisions, conditions and evidence stay in the audit record. */
export function plainCaseText(text: string): string {
  return text
    .replace(/\bCoverage A\s*[–—:-]?\s*Dwelling\b/gi, "home repair coverage")
    .replace(/\bCoverage C\s*[–—:-]?\s*Loss of Use\b/gi, "temporary living expenses coverage")
    .replace(/\bloss of use\b/gi, "temporary living expenses")
    .replace(/\badditional living expenses\b/gi, "extra living costs")
    .replace(/\buninhabitable\b/gi, "unsafe to live in")
    .replace(/\bresidence premises\b/gi, "home")
    .replace(/\bresidence\b/gi, "home")
    .replace(/\bloss insured\b/gi, "covered damage")
    .replace(/\bcauses the home to become\b/gi, "makes the home")
    .replace(/\bCoverage C\b/g, "the temporary housing coverage")
    .replace(/\bCoverage A\b/g, "home repair coverage")
    .replace(/\breasonable increase in cost to maintain normal standard of living\b/gi, "extra costs needed to maintain usual living conditions")
    .replace(/\bcovered peril\b/gi, "covered cause of damage")
    .replace(/\bdeclaration limit\b/gi, "policy limit")
    .replace(/\binsured becomes legally liable\b/gi, "policyholder is legally responsible")
    .replace(/\s*\([A-Z][A-Z-]+#\d+\)/g, "");
}

export function findingTitle(item: string): string {
  return plainCaseText(item.replace(/\s*\(Coverage[^)]*\)/gi, "")).replace(/^temporary living expenses\s*\/\s*extra living costs$/i, "Help with temporary housing");
}

export function activityTitle(title: string): string {
  return title.replace(/\s*\(demo only; no real SMS sent\)/gi, "")
    .replace(/shown on the simulated phone/gi, "added to the conversation")
    .replace(/simulated phone/gi, "conversation");
}

/** A concise handoff from recorded reasons and unresolved questions; no new loss facts inferred. */
export function reviewHandoff(run: RunSummary | undefined, name: string): { reason: string; steps: string[] } | null {
  if (!run) return null;
  const d = run.decision?.decision;
  const queued = run.humanReview?.status === "queued";
  if (!queued && !run.humanInterventionNeeded && d?.next_action !== "human_review" && run.status !== "failed") return null;
  const firstName = name.split(" ")[0];
  const firstSentence = (text: string) => plainCaseText(text.split(/(?<=[.!?])\s+(?=[A-Z])/)[0]);
  const unresolved = d?.findings.find((f) => f.status === "unclear" || f.status === "no_policy");
  let reason: string;
  if (run.status === "failed") reason = `The agent could not complete a reliable assessment. ${run.failure?.summary ?? "The case needs a person to review it."}`;
  else if (d?.immediate_danger) reason = firstSentence(d.severity_reason);
  else if (unresolved) reason = unresolved.status === "no_policy" ? `No policy was found for ${plainCaseText(unresolved.item)}.` : `Coverage for ${plainCaseText(unresolved.item)} could not be confirmed.`;
  else if (run.humanReview?.reason) reason = firstSentence(run.humanReview.reason.replace(/^Follow-up promised to the customer:\s*/i, ""));
  else reason = firstSentence(d?.decision_reason ?? "The case needs a claims specialist to review it.");

  const steps: string[] = [];
  if (d?.immediate_danger) {
    steps.push(`Call ${firstName} now to check immediate safety and what help is needed.`);
    const reported = [...d.reported_facts, d.severity_reason].join(" ");
    if (/oxygen/i.test(reported)) steps.push("Confirm whether the oxygen equipment has power and a working supply.");
    if (/shelter|home destroyed|house.*(?:gone|destroyed)|unsafe to live|uninhabitable/i.test(reported)) steps.push("Confirm where the household can stay safely tonight.");
  }
  for (const unknown of d?.unknowns ?? []) {
    if (steps.length >= 3) break;
    const question = plainCaseText(unknown).replace(/[.!?]+$/, "");
    if (!question.trim()) continue;
    steps.push(`Confirm ${question.charAt(0).toLowerCase()}${question.slice(1)}.`);
    if (steps.length >= 3) break;
  }
  if (!steps.length) steps.push(`Contact ${firstName} to confirm the reported loss and what help is needed.`);
  if (steps.length < 3 && unresolved) steps.push(`Check the policy and resolve the coverage question for ${plainCaseText(unresolved.item)}.`);
  if (run.status === "failed" && steps.length < 3) steps.push("Review the customer’s messages and policy before confirming coverage.");
  return { reason, steps: [...new Set(steps)].slice(0, 3) };
}
