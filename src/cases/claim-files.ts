// Claims. A case gets a claim (first notice of loss) drafted either automatically, when the agent's
// verified review proves every reported loss covered, or manually, when a reviewer starts one at any
// point. Nothing has to be typed: date of loss, location and cause come from the case and policy record.
// Lifecycle: pending (drafted, awaiting human confirmation) -> confirmed (filed) | denied.
// Payment is out of scope for now: no settlement or bank call happens here.
import { randomUUID } from "node:crypto";
import type { Citation } from "../knowledge/citations";
import type { Sqlite } from "../db/sqlite";
import { findPolicyholder, type PolicyholderFile } from "../customers/directory";
import type { Finding } from "../agent/schemas";
import type { StoredDecision } from "../workers/agent-worker";
import { appendEvent } from "./events";
import { getCase, lastCustomerSeq, messages } from "./repository";
import { caseRuns } from "./runs";

export type ClaimStatus = "pending" | "confirmed" | "denied";
export type ClaimSource = "auto" | "manual";

export interface ClaimPayload {
  caseId: string;
  runId: string | null;
  customer: PolicyholderFile;
  summary: string;
  findings: Finding[];
  evidence: (Citation & { finding: number })[];
  reportedText: string[];
  incidentDate: string;
  location: string;
  cause: string;
  severity: number | null;
  /** How the claim reached filing, in plain words. */
  basis: string;
}

export interface FiledClaim extends ClaimPayload {
  id: string;
  filedAt: string;
  status: ClaimStatus;
  source: ClaimSource;
  decidedAt: string | null;
  decisionNote: string | null;
}

const toClaim = (_db: Sqlite, r: Record<string, unknown>): FiledClaim => ({
  ...(JSON.parse(String(r.payload)) as ClaimPayload),
  id: String(r.id), caseId: String(r.case_id), filedAt: String(r.filed_at),
  status: (r.status === "filed" ? "pending" : r.status === "approved" ? "confirmed" : r.status) as ClaimStatus,
  source: r.source as ClaimSource, decidedAt: r.decided_at ? String(r.decided_at) : null,
  decisionNote: r.decision_note ? String(r.decision_note) : null,
});

export function claimFiles(db: Sqlite): FiledClaim[] {
  return db.all<Record<string, unknown>>("SELECT * FROM filed_claims ORDER BY filed_at DESC").map((r) => toClaim(db, r));
}

export function getClaim(db: Sqlite, id: string): FiledClaim | null {
  const r = db.get<Record<string, unknown>>("SELECT * FROM filed_claims WHERE id=?", id);
  return r ? toClaim(db, r) : null;
}

export function claimForCase(db: Sqlite, caseId: string): FiledClaim | null {
  const r = db.get<Record<string, unknown>>("SELECT * FROM filed_claims WHERE case_id=?", caseId);
  return r ? toClaim(db, r) : null;
}

/** The latest completed review, if it proves every reported loss covered and nothing blocks filing. */
export function draftFor(db: Sqlite, caseId: string) {
  const c = getCase(db, caseId);
  if (!c) return null;
  const r = caseRuns(db, caseId).at(-1);
  const stored = r?.decision as StoredDecision | null;
  const d = stored?.decision;
  if (!r || r.status !== "completed" || !stored?.verified || !d?.findings.length || d.findings.some((f) => f.status !== "covered") ||
    d.unknowns.length || d.immediate_danger || d.next_action === "human_review" || r.throughSeq !== lastCustomerSeq(db, caseId)) return null;
  if (db.get("SELECT id FROM outbox WHERE run_id=? AND status='held'", r.id)) return null;
  return { caseId, runId: r.id, stored };
}

function buildPayload(db: Sqlite, caseId: string, source: ClaimSource): ClaimPayload {
  const c = getCase(db, caseId)!;
  const customer = findPolicyholder({ personaId: c.customerId ?? "" });
  if (!customer) throw new Error("Only verified policyholders can have a claim filed.");
  // Newest run that produced a decision, whatever its state: a manual filing uses the best review there is.
  const run = [...caseRuns(db, caseId)].reverse().find((r) => (r.decision as StoredDecision | null)?.decision);
  const stored = run?.decision as StoredDecision | null;
  const d = stored?.decision;
  const reportedText = messages(db, caseId).filter((m) => m.role === "customer").map((m) => m.text);
  const firstReport = messages(db, caseId).find((m) => m.role === "customer");
  const verified = source === "auto";
  return {
    caseId, runId: run?.id ?? null, customer,
    summary: d?.summary ?? reportedText.join(" ").slice(0, 600),
    findings: d?.findings ?? [],
    evidence: (stored?.citations ?? []) as ClaimPayload["evidence"],
    reportedText,
    incidentDate: (firstReport?.at ?? c.createdAt).slice(0, 10),
    location: customer.address,
    cause: lossCause(reportedText.join(" "), c.channel === "simulation"),
    severity: d?.severity ?? null,
    basis: verified
      ? "Drafted automatically: the agent's verified review proved every reported loss covered."
      : d
        ? `Drafted by a reviewer. Agent review at the time: ${d.findings.map((f) => `${f.item} (${f.status.replaceAll("_", " ")})`).join("; ") || "no coverage findings"}.`
        : "Drafted by a reviewer before the agent completed a review.",
  };
}

/** Kind of loss in ACORD terms, from what the policyholder reported. */
function lossCause(reported: string, simulated: boolean): string {
  const t = reported.toLowerCase();
  const kinds = [[/hail/, "Hail"], [/tornado|twister|wind|storm|blew/, "Windstorm"], [/tree|limb|branch/, "Falling object (tree)"],
    [/flood|water|rain|leak/, "Water damage"], [/fire|smoke/, "Fire"], [/car|truck|vehicle|windshield/, "Auto physical damage"]] as const;
  const found = kinds.filter(([re]) => re.test(t)).map(([, k]) => k);
  return `${found.length ? [...new Set(found)].join(", ") : "As reported by the policyholder"}${simulated ? " (EF4 tornado event, Moore, OK)" : ""}`;
}

/**
 * File the case's claim. Idempotent per case: filing again returns the existing claim.
 * "auto" requires a ready, verified review; "manual" files from wherever the agent is.
 */
export function fileClaim(db: Sqlite, caseId: string, source: ClaimSource, by = source === "auto" ? "agent" : "reviewer"): FiledClaim {
  return db.tx(() => {
    const prior = claimForCase(db, caseId);
    if (prior) return prior;
    if (!getCase(db, caseId)) throw new Error("Case not found.");
    if (source === "auto" && !draftFor(db, caseId)) throw new Error("This case is not ready to file automatically.");
    const payload = buildPayload(db, caseId, source);
    const id = `CL-${randomUUID().slice(0, 8).toUpperCase()}`;
    db.run("INSERT INTO filed_claims(id,case_id,run_id,payload,filed_at,status,source) VALUES (?,?,?,?,?,'pending',?)",
      id, caseId, payload.runId, JSON.stringify(payload), new Date().toISOString(), source);
    appendEvent(db, { caseId, runId: payload.runId, actor: source === "auto" ? "system" : "reviewer", type: "claim.filed",
      title: `Claim ${id} drafted ${source === "auto" ? "automatically (verified covered)" : "by a reviewer"}; awaiting human confirmation`,
      detail: { claimId: id, source, by, basis: payload.basis } });
    return getClaim(db, id)!;
  });
}

/** File every case whose latest review is ready. Safe to call repeatedly. */
export function autoFileReady(db: Sqlite, caseIds?: string[]): FiledClaim[] {
  const ids = caseIds ?? db.all<{ id: string }>("SELECT c.id FROM cases c LEFT JOIN filed_claims f ON f.case_id=c.id WHERE f.id IS NULL").map((r) => r.id);
  const filed: FiledClaim[] = [];
  for (const id of ids) if (!claimForCase(db, id) && draftFor(db, id)) filed.push(fileClaim(db, id, "auto"));
  return filed;
}

/** Human decision on a drafted claim: confirm files it; deny closes it with a reason. Idempotent. */
export function decideClaim(db: Sqlite, claimId: string, input: { decision: "confirm" | "deny"; note?: string; by?: string }): FiledClaim {
  return db.tx(() => {
    const claim = getClaim(db, claimId);
    if (!claim) throw new Error("Claim not found.");
    const wanted: ClaimStatus = input.decision === "confirm" ? "confirmed" : "denied";
    if (claim.status === wanted) return claim;
    if (claim.status !== "pending") throw new Error(`This claim was already ${claim.status}.`);
    if (wanted === "denied" && !input.note?.trim()) throw new Error("Give a reason for the denial.");
    db.run("UPDATE filed_claims SET status=?, decided_at=?, decision_note=? WHERE id=? AND status='pending'", wanted, new Date().toISOString(), input.note?.trim() || null, claimId);
    appendEvent(db, { caseId: claim.caseId, actor: "reviewer", type: wanted === "confirmed" ? "claim.confirmed" : "claim.denied",
      title: wanted === "confirmed" ? `Claim ${claimId} confirmed and filed` : `Claim ${claimId} denied`,
      detail: { claimId, note: input.note ?? null, by: input.by ?? "reviewer" } });
    return getClaim(db, claimId)!;
  });
}
