export type StateCode = "OK";

export type HouseholdType =
  | "single_young"
  | "single_adult"
  | "single_senior"
  | "couple_young"
  | "couple_senior"
  | "family_young_kids"
  | "family_teens"
  | "single_parent"
  | "multigen";

export type Relation = "self" | "spouse" | "child" | "parent";

export interface Member {
  name: string;
  age: number;
  relation: Relation;
  medicalNeeds?: string;
  limitedMobility?: boolean;
}

export type PolicyLine = "home" | "auto" | "umbrella";

/** One row of the State Farm RAG manifest. Policies point at these via formId. */
export interface PolicyForm {
  id: string;
  line: PolicyLine;
  name: string;
  formNumber: string;
  state: string;
  personaFit: string;
  url: string;
}

export interface HomeCoverage {
  dwelling: number;
  personalProperty: number;
  lossOfUse: number;
  deductible: number;
  windHailDeductible: number;
}

export interface Vehicle {
  year: number;
  make: string;
  model: string;
  value: number;
}

export interface AutoCoverage {
  vehicles: Vehicle[];
  liability: string;
  collisionDeductible: number;
  comprehensiveDeductible: number;
}

export interface Policy {
  id: string;
  line: PolicyLine;
  formId: string;
  premiumAnnual: number;
  home?: HomeCoverage;
  auto?: AutoCoverage;
  umbrellaLimit?: number;
}

export interface Address {
  street: string;
  city: string;
  state: StateCode;
  zip: string;
  lat: number;
  lon: number;
}

export interface Agent {
  id: string;
  name: string;
  city: string;
  state: StateCode;
  phone: string;
  lat: number;
  lon: number;
}

export interface Persona {
  id: string;
  name: string;
  phone: string;
  householdType: HouseholdType;
  members: Member[];
  address: Address;
  housing: "own" | "rent";
  homeValue: number | null;
  occupation: string;
  selfEmployed: boolean;
  agentId: string;
  policies: Policy[];
  /** 0..1, how likely they are to answer an outreach message. */
  responsiveness: number;
  /** Human-readable flags that raise triage priority. */
  vulnerabilities: string[];
}

// ── Catastrophe simulation ───────────────────────────────────────────

export type ScenarioKind = "tornado";

export interface Scenario {
  id: string;
  kind: ScenarioKind;
  title: string;
  headline: string;
  detail: string;
  state: StateCode;
  /** Tornado path, from touchdown to lift. */
  start: [number, number];
  end: [number, number];
  /** Local time of touchdown, e.g. "19:42". */
  touchdown: string;
  /** Half-width of the damage core, in km. */
  radiusKm: number;
  /** Outer band where light damage still happens, in km. */
  outerKm: number;
  /** How hard this scenario hits property and people, 0..1. */
  ferocity: number;
  /** Sim minutes the tornado takes to travel from start to end. */
  trackMinutes: number;
}

export type DamageLevel = "none" | "minor" | "moderate" | "severe" | "destroyed";

/**
 * The simulator's hidden answer key for one affected household. Never sent to
 * the agent; only used to generate the persona's texts and to score the agent.
 */
export interface WorldTruth {
  personaId: string;
  intensity: number;
  /** Sim minutes after touchdown when the tornado reaches this home. */
  impactAt: number;
  damage: DamageLevel;
  injured: boolean;
  medicalUrgent: boolean;
  displaced: boolean;
  vehicleDamaged: boolean;
  /** Damage happened but no policy covers it (e.g. renter without a property policy). */
  uninsuredLoss: boolean;
  /** Severity under the same rubric the agent is given. */
  severity: number;
  expectedRoute: ClaimRoute;
  /** Sim minute of each text they send, or empty if they never reply. */
  replyTimes: number[];
  /** The texts themselves, written from the truth above. Messy on purpose. */
  messages: string[];
}

export type TriageStatus =
  | "monitoring"
  | "awaiting"
  | "silent"
  | "analyzing"
  | "unassessed"
  | "critical"
  | "needs_help"
  | "safe";

export type ClaimRoute = "auto_approve" | "human_review" | "none";

export interface ThreadMessage {
  at: number;
  from: "system" | "persona" | "agent";
  text: string;
  /** Typed live in the demo rather than scripted by the simulator. */
  live?: boolean;
}
