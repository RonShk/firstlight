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
