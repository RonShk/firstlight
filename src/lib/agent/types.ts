import type { ClaimRoute, PolicyLine } from "@/types/sim";

/** What the agent is allowed to see: the conversation, nothing from the simulator's truth. */
export interface AgentRequest {
  personaId: string;
  conversation: { from: "policyholder" | "state_farm"; text: string }[];
  /** Skip the response cache. */
  fresh?: boolean;
}

export type CoverageCall = "covered" | "excluded" | "unclear" | "no_policy";
export type CoveragePart = "dwelling" | "other_structures" | "personal_property" | "loss_of_use" | "vehicle" | "liability" | "other";
export type Extent = "minor" | "moderate" | "severe" | "total";

/** Nemotron's structured judgment, submitted via the submit_assessment tool. */
export interface ModelAssessment {
  summary: string;
  safety: {
    injury_reported: boolean;
    medical_urgent: boolean;
    displaced: boolean;
    trapped_or_missing: boolean;
  };
  severity: number;
  severity_reason: string;
  confidence: number;
  claims: {
    line: PolicyLine | "none";
    coverage_part: CoveragePart;
    item: string;
    extent: Extent;
    coverage: CoverageCall;
    citation_doc_id: string | null;
    citation_quote: string | null;
    reasoning: string;
  }[];
  needs: string[];
  reply_text: string;
  follow_up_question: string | null;
}

/** Money and routing, computed by code from the assessment and the policy record. */
export interface ClaimDecision {
  route: ClaimRoute;
  routeReason: string;
  lines: { item: string; coverage: CoverageCall; coveragePart: CoveragePart; extent: Extent; estimate: number; basis: string; citation: { docId: string; quote: string } | null }[];
  total: number;
  payableNow: number;
  deductibleApplied: number;
  claimNumber: string | null;
}

export interface AgentStep {
  kind: "model" | "tool";
  name: string;
  detail: string;
  ms: number;
}

export interface AgentResult {
  personaId: string;
  assessment: ModelAssessment;
  decision: ClaimDecision;
  /** Final text sent back to the policyholder's phone. */
  reply: string;
  steps: AgentStep[];
  model: string;
  ms: number;
  cached: boolean;
}

export interface AgentStatus {
  configured: boolean;
  model: string | null;
  baseUrl: string | null;
  policiesLoaded: string[];
}
