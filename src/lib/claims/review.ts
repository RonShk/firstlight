/** Turns a Nemotron run into what the claim page shows, keeping the quick read until a real review lands. */
import type { Citation } from "../../knowledge/citations";
import type { Claim, ClaimReview, ClaimView, ReviewState, Severity } from "../../types/claims";
import { decisionOf, type AgentRun } from "../sim/triage";
import { coverageLayers, selectDocuments } from "./policy-documents";
import { SEVERITIES } from "./quick-read";

const severityOf = (n: number): Severity => n >= 90 ? "critical" : n >= 70 ? "high" : n >= 30 ? "medium" : "low";

/** Only persisted, delivered replies and validated citations appear in the dashboard. */
export function reviewClaim(claim: Claim, run: AgentRun | undefined, online: boolean | null): ClaimReview {
  const { severity, summary, risk, lines } = claim.quick;
  const quick = { severity, summary, risk, lines };
  const keepQuick = (state: ReviewState): ClaimReview => ({ ...quick, state, citations: [], reply: null });
  if (claim.silent) return keepQuick("none");
  if (!run) return keepQuick(online === false ? "offline" : "quick");
  const reply = run.result?.reply?.status === "sent" ? run.result.reply.body : null;
  if (run.result?.humanInterventionNeeded) return { ...keepQuick("human_review"),
    summary: "The agent reached its investigation limit. A claims specialist needs to review this case.", reply };
  if (run.status === "error") return { ...keepQuick("unavailable"), reply };
  if (run.status !== "done") return keepQuick("reviewing");
  const d = decisionOf(run);
  if (!d) return keepQuick("unavailable");
  const policyIds = new Set(d.findings.map((f) => f.policy_id));
  const matchedLines = claim.persona.policies.filter((p) => policyIds.has(p.id)).map((p) => p.line);
  const citations = [...new Map((run.result?.decision?.citations as Citation[] ?? [])
    .map((c) => [`${c.doc_id}:${c.section}:${c.page}:${c.quote}`, c])).values()];
  return {
    state: d.next_action === "human_review" ? "human_review" : "reviewed",
    severity: d.immediate_danger ? "critical" : severityOf(d.severity),
    summary: d.summary,
    risk: d.immediate_danger ? "Safety concern" : d.severity >= 70 ? "Severe damage" : d.severity >= 30 ? "Moderate damage" : "No active risk",
    lines: matchedLines.length ? [...new Set(matchedLines)] : quick.lines,
    citations, reply,
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
