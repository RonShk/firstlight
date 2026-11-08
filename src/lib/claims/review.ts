/** Turns a Nemotron run into what the claim page shows, keeping the quick read until a real review lands. */
import type { Citation, ClaimAnalysis } from "../agent/schemas";
import type { Claim, ClaimReview, ClaimView, ReviewState, Severity } from "../../types/claims";
import { money } from "../sim/status";
import { replyOf, type AgentRun } from "../sim/triage";
import { coverageLayers, selectDocuments } from "./policy-documents";
import { SEVERITIES } from "./quick-read";

const MODEL_SEVERITY: Record<1 | 2 | 3 | 4, Severity> = { 1: "low", 2: "medium", 3: "high", 4: "critical" };

function modelRisk(a: ClaimAnalysis): string {
  if (a.people.some((p) => p.injury)) return "Injury reported";
  if (a.claim_types.includes("umbrella")) return "Liability exposure";
  if (a.triage === 3) return "Severe damage";
  return a.triage === 2 ? "Moderate damage" : "No active risk";
}

function outcome(a: ClaimAnalysis): string {
  const pending = a.items.filter((i) => !i.approved).length;
  return [
    a.claim_amount_usd ? `Estimated ${money(a.claim_amount_usd)}.` : "",
    a.approved_amount_usd ? `${money(a.approved_amount_usd)} advance approved.` : "",
    pending ? `${pending} ${pending === 1 ? "item needs" : "items need"} a claims specialist.` : "",
  ].filter(Boolean).join(" ");
}

function distinctCitations(a: ClaimAnalysis): Citation[] {
  const seen = new Map<string, Citation>();
  for (const c of a.items.flatMap((i) => i.citations)) if (!seen.has(`${c.doc_id}:${c.section}`)) seen.set(`${c.doc_id}:${c.section}`, c);
  return [...seen.values()];
}

/** `online` is null until the agent status has loaded. */
export function reviewClaim(claim: Claim, run: AgentRun | undefined, online: boolean | null): ClaimReview {
  const { severity, summary, risk, lines } = claim.quick;
  const quick = { severity, summary, risk, lines };
  const keepQuick = (state: ReviewState): ClaimReview => ({ ...quick, state, citations: [], reply: null });

  if (claim.silent) return keepQuick("none");
  if (online === false) return keepQuick("offline");
  if (!run) return keepQuick("quick");
  if (run.status === "error") return keepQuick("unavailable");
  if (run.status !== "done" || !run.result) return keepQuick("reviewing");

  const a = run.result.result;
  const reply = replyOf(run.result);
  if (a.status === "agent_unavailable") return keepQuick("unavailable");
  if (a.status === "emergency") {
    return { ...quick, state: "reviewed", severity: "critical", summary: `Emergency: ${a.reason}. The policyholder was told to call 911.`, risk: "Safety concern", citations: [], reply };
  }
  if (a.status === "not_a_claim") {
    return { ...quick, state: "reviewed", severity: "low", summary: "Not a loss report. The policyholder received the help text.", risk: "No active risk", lines: [], citations: [], reply };
  }
  return {
    state: "reviewed",
    severity: MODEL_SEVERITY[a.triage],
    summary: [a.summary, outcome(a)].filter(Boolean).join(" "),
    risk: modelRisk(a),
    lines: a.claim_types.length ? a.claim_types : quick.lines,
    citations: distinctCitations(a),
    reply,
  };
}

export function toView(claim: Claim, run: AgentRun | undefined, online: boolean | null): ClaimView {
  const review = reviewClaim(claim, run, online);
  return { ...claim, review, documents: selectDocuments(claim.persona, review.lines), layers: coverageLayers(claim.persona, review.lines, claim.peril) };
}

export function sortClaims(views: ClaimView[]): ClaimView[] {
  const rank = (v: ClaimView) => SEVERITIES.indexOf(v.review.severity);
  return [...views].sort((a, b) => rank(a) - rank(b) || b.quick.score - a.quick.score);
}
