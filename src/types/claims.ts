import type { Citation } from "../knowledge/citations";
import type { Persona, Policy, PolicyForm, PolicyLine } from "./sim";

export type Severity = "critical" | "high" | "medium" | "low";

export type Peril = "Tornado" | "Collision" | "Comprehensive" | "Liability" | "Rental" | "Fire" | "Water" | "Wind" | "Hail" | "Theft" | "General";

export interface ClaimMessage {
  id: string;
  from: "policyholder" | "state_farm" | "adjuster" | "note";
  text: string;
  minutesAgo: number;
}

/** Instant triage from the message text and policy file. Replaced by Nemotron's review when a claim is opened. */
export interface QuickRead {
  severity: Severity;
  /** Orders claims inside a severity group. */
  score: number;
  summary: string;
  risk: string;
  /** Main line first. Umbrella only when someone else may have been harmed. */
  lines: PolicyLine[];
}

export interface Claim {
  id: string;
  number: string;
  persona: Persona;
  subject: string;
  peril: Peril;
  /** The policyholder's texts. Empty when they never replied to a check-in. */
  body: string[];
  minutesAgo: number;
  thread: ClaimMessage[];
  silent: boolean;
  quick: QuickRead;
}

export type ReviewState = "quick" | "reviewing" | "reviewed" | "offline" | "unavailable" | "human_review" | "none";

export interface ClaimReview {
  state: ReviewState;
  severity: Severity;
  summary: string;
  risk: string;
  lines: PolicyLine[];
  citations: Citation[];
  /** The automated text sent to the policyholder after review. */
  reply: string | null;
}

export interface DocumentForm extends PolicyForm {
  pages: number;
  hasPdf: boolean;
}

/** The one document shown for a policy line on this claim. */
export interface SelectedDocument {
  line: PolicyLine;
  policy: Policy;
  form: DocumentForm;
  why: string;
}

export interface CoverageLayer {
  name: string;
  amount: string;
  note: string;
}

export interface ClaimView extends Claim {
  review: ClaimReview;
  documents: SelectedDocument[];
  layers: CoverageLayer[];
}
