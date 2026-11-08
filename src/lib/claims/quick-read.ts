/**
 * The instant first pass that ranks the whole queue. It reads only what State Farm can see (the
 * policyholder's words and their file), never the simulator's hidden truth.
 */
import type { Persona, PolicyLine } from "../../types/sim";
import type { QuickRead, Severity } from "../../types/claims";

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

interface Signal {
  re: RegExp;
  severity: Severity;
  finding?: string;
  /** Names the ask when there is nothing to report, for the summary line. */
  request?: string;
  risk?: string;
}

// Most urgent first: the first match that names a risk decides it. Text is lowercased
// with apostrophes removed, so "can't" and a sloppy "cant" read the same.
const SIGNALS: Signal[] = [
  { re: /\btrapped\b|cant get out/, severity: "critical", finding: "someone who may be trapped", risk: "Safety concern" },
  { re: /oxygen|dialysis|insulin|chest pains?|contractions|cant breathe|newborn/, severity: "critical", finding: "an urgent medical need", risk: "Medical need" },
  { re: /\bat the er\b|ambulance|\b(leg|arm|ankle|ribs?)\b.{0,12}\bbroken\b|hit (my|their) head|throwing up|cut up bad|bleeding|got hurt|\bis hurt\b|stitches/, severity: "critical", finding: "an injury", risk: "Injury reported" },
  { re: /smells? gas|gas leak|(is|still) on fire/, severity: "critical", finding: "an active fire or gas hazard", risk: "Safety concern" },
  { re: /blocking (part of )?the (road|lane|intersection)|middle of the (road|highway)/, severity: "critical", finding: "a roadway hazard", risk: "Safety concern" },
  { re: /(cant|not) be driven|think it can be driven|not drivable|wont start|totaled/, severity: "high", finding: "an immobilized vehicle", risk: "Vehicle out of service" },
  { re: /\b(is|are) gone\b|nothing left|flattened|to the foundation|collapsed|torn open|wrecked/, severity: "high", finding: "a destroyed or unlivable home", risk: "Displaced household" },
  { re: /cant stay|(?<!stayed )out of the house|need a hotel|where do we go|place to stay|pay for a hotel/, severity: "high", finding: "a displaced household", risk: "Displaced household" },
  { re: /water.{0,30}(spreading|getting in|coming in)|leaking|flooded|soaked|burst/, severity: "high", finding: "active water damage", risk: "Active water damage" },
  { re: /tree (came|fell) (through|on)|roof is (peeled|gone)|half the roof/, severity: "high", finding: "structural damage", risk: "Structural damage" },
  { re: /lawyer|attorney|lawsuit|\bsued?\b|suing/, severity: "high", finding: "a possible legal claim", risk: "Liability exposure" },
  { re: /receipts/, severity: "medium", request: "document submission" },
  { re: /estimate/, severity: "medium", request: "repair estimate" },
  { re: /rental/, severity: "medium", request: "rental extension" },
  { re: /backed into|neighbors? (fence|car|garage)/, severity: "medium", finding: "possible damage to someone else's property", risk: "Liability exposure" },
  { re: /shingles|fence|hail|windshield|\bdents?\b|cracked|smashed|broke in|stolen|windows?|bumper|burned|crumpled/, severity: "medium", finding: "property damage" },
  { re: /\bstatus\b|any update/, severity: "low", request: "status update" },
  { re: /\bwere (okay|safe|good|fine)\b|no damage|all good|fine here|we good/, severity: "low", finding: "no damage" },
];

const VAGUE = /its bad|need help|messed up|got hit|not sure what to do/;

const VEHICLE_WORDS = /\b(car|truck|suv|van|vehicle|windshield|bumper|hood|radiator|driving|driven|drive|rental|body shop|tow|towed|rear ?ended|trunk|parked|intersection|red light)\b/;
const HOME_WORDS = /\b(house|home|roof|shingles|ceiling|kitchen|apartment|unit|fence|windows?(?! in the)|pipe|bathroom|garage|hotel|drywall|cabinets|stove|steps|back door|laptop|furniture|basement|hallway)\b/;

/** Words that mean someone outside the household may have been harmed, which is when umbrella matters. */
const LIABILITY = /\b(i|we) (hit|rear ?ended|backed into|sideswiped|ran into|clipped)\b|ran a red|intersection|lawyer|attorney|lawsuit|\bsued?\b|their passenger|neighbors? (fence|car|garage|house|roof|window)s?.{0,40}(smashed|damaged|broke|hit)|(slipped|fell) on our/;

const LEAD: Record<Severity, string> = {
  critical: "Immediate response recommended",
  high: "Same-day response recommended",
  medium: "Routine follow-up",
  low: "No urgent action",
};

const normalize = (text: string) => text.toLowerCase().replace(/['’]/g, "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function englishList(items: string[]): string {
  if (items.length < 3) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function vehicleWords(p: Persona): RegExp | null {
  const names = p.policies.flatMap((x) => x.auto?.vehicles ?? []).flatMap((v) => [v.make, v.model]);
  return names.length ? new RegExp(`\\b(${names.map((n) => escapeRe(n.toLowerCase())).join("|")})\\b`) : null;
}

export function detectLines(text: string, p: Persona, fallback: PolicyLine[] = []): PolicyLine[] {
  const t = normalize(text);
  const own = vehicleWords(p);
  const autoAt = Math.min(...[t.search(VEHICLE_WORDS), own ? t.search(own) : -1].map((i) => (i < 0 ? Infinity : i)));
  const homeAt = t.search(HOME_WORDS);
  const lines: PolicyLine[] = [];
  if (autoAt !== Infinity) lines.push("auto");
  if (homeAt >= 0) lines.push("home");
  if (lines.length === 2 && homeAt < autoAt) lines.reverse();
  if (!lines.length) lines.push(...fallback);
  if (LIABILITY.test(t)) lines.push("umbrella");
  return lines;
}

/** Vulnerable households and long waits rise inside their severity group. */
function score(p: Persona, minutesAgo: number, signals: number): number {
  return Math.min(10, p.vulnerabilities.length * 3.5) + Math.min(20, minutesAgo / 12) + signals;
}

function highestSeverity(matched: Signal[]): Severity | null {
  return SEVERITIES.find((s) => matched.some((m) => m.severity === s)) ?? null;
}

export function quickRead(messages: string[], p: Persona, minutesAgo: number, fallback: PolicyLine[] = []): QuickRead {
  const text = normalize(messages.join(" "));
  const matched = SIGNALS.filter((s) => s.re.test(text));
  const vague = !matched.length && VAGUE.test(text);
  const severity = vague ? "high" : (highestSeverity(matched) ?? "medium");
  const request = matched.find((s) => s.request)?.request ?? "general question";
  const risk = vague ? "Details unclear" : (matched.find((s) => s.risk)?.risk ?? "No active risk");
  // A "we're okay" alongside real damage isn't a finding.
  const findings = matched.filter((s) => s.finding && (s.severity === severity || s.severity !== "low")).map((s) => s.finding!);
  if (vague) findings.push("damage without any details");

  let summary = findings.length
    ? `${LEAD[severity]}: the policyholder reports ${englishList(findings)}.`
    : `A routine ${request} with no active risk.`;
  if (p.vulnerabilities.length && severity !== "low") summary += ` Household flags: ${p.vulnerabilities.join(", ")}.`;

  return { severity, score: score(p, minutesAgo, matched.length), summary, risk, lines: detectLines(text, p, fallback) };
}

/** No reply to a check-in: silence is the warning sign, so these rise on location and who lives there. */
export function silentRead(p: Persona, intensity: number, minutesAgo: number, age: string): QuickRead {
  const severity: Severity = intensity > 0.5 || p.vulnerabilities.length ? "critical" : "high";
  let summary = `Welfare call recommended: no reply to two check-ins in ${age}${intensity > 0.5 ? " from an address in the damage core" : ""}.`;
  if (p.vulnerabilities.length) summary += ` Household flags: ${p.vulnerabilities.join(", ")}.`;
  const held = p.policies.map((x) => x.line);
  return {
    severity,
    score: score(p, minutesAgo, 0) + intensity * 10,
    summary,
    risk: "Unresponsive in tornado path",
    lines: held.includes("home") ? ["home"] : held.includes("auto") ? ["auto"] : [],
  };
}
