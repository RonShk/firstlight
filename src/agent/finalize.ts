// Validates a proposed decision against what actually happened in this run. Issues go back to the
// model to fix; if it cannot, `sanitize` produces a safe decision that routes to a human.
import { documentUrl, quoteAppears, type Citation as ResolvedCitation } from "../knowledge/citations";
import type { PolicyholderFile } from "../customers/directory";
import type { Evidence } from "../tools/types";
import type { Decision, Finding } from "./schemas";

const OFFICIAL = /official|Insurance Dept|Bureau of Insurance/i;

/** Things only a tool or a person could make true; no tool here pays, schedules, dispatches or files. */
const OVERPROMISE: [RegExp, string][] = [
  [/\b(we|i)('ve| have)? (sent|paid|deposited|wired|transferred|issued)\b/i, "claims money was sent"],
  [/\b(payment|funds|money|advance)\b[^.]{0,40}\b(is|are|was|were|has been|have been) (sent|on (its|the) way|approved|issued|deposited)/i, "claims a payment was made or approved"],
  [/\b(your )?claim (has been|was|is) (approved|filed|submitted|opened)\b/i, "claims a claim was filed or approved"],
  [/\bclaim (number|#)\s*:?\s*[A-Z0-9-]{4,}/i, "invents a claim number"],
  [/\b(will|is going to) (call|text) you (at|by|within|in) \d/i, "promises a specific callback time"],
  [/\b(we|i)('ve| have)? (dispatched|sent) (an? )?(adjuster|crew|ambulance|help|someone)\b/i, "claims someone was dispatched"],
  [/\b(is|are) (fully )?covered\b(?![^.]{0,60}\b(may|might|likely|if|once|subject|depend))/i, "states coverage as certain"],
  [/\b(policy|coverage|insurance|plan)\s+(covers|will cover|will pay|pays for)\b/i, "states coverage as certain (say it may cover, pending an adjuster)"],
];

/** Follow-up promises are only true when this run queued a person or a claim draft. */
export const FOLLOW_UP = /\b(specialist|adjuster|agent|someone|team|we)\b[^.]{0,30}\b(will|is going to|are going to)\s+(contact|call|reach out|follow up|be in touch|schedule)/i;

const INTERNAL = /\bchunk[_ ]?id\b|[A-Z]{2,}-[A-Z]+(-[A-Z]+)?#\d+|\bseverity (score|of) \d+|\b(update_plan|search_policy|read_section|finish_review|tool call)\b/i;

export interface Validation {
  issues: string[];
  citations: (ResolvedCitation & { finding: number })[];
}

export interface RunActions {
  /** Tools that succeeded in this run (e.g. request_human_review, prepare_claim). */
  completedTools: Set<string>;
}

const ordOf = (chunkId: string) => Number(chunkId.slice(chunkId.lastIndexOf("#") + 1));

/**
 * The retrieved passage a quote comes from. Usually the cited chunk; the model sometimes cites a
 * neighbour of the right passage, or quotes across the boundary between two adjacent passages it
 * retrieved. Those are accepted (the words are still verbatim) and attributed to the passage where
 * the quote starts. Returns null when the words do not appear in anything retrieved from that document.
 */
export function locateQuote(evidence: Map<string, Evidence>, chunkId: string, quote: string): Evidence | null {
  const cited = evidence.get(chunkId);
  if (cited && quoteAppears(cited.text, quote)) return cited;
  const docId = cited?.doc_id ?? chunkId.slice(0, chunkId.lastIndexOf("#"));
  const same = [...evidence.values()].filter((e) => e.doc_id === docId).sort((a, b) => ordOf(a.chunk_id) - ordOf(b.chunk_id));
  const single = same.find((e) => quoteAppears(e.text, quote));
  if (single) return single;
  for (let i = 0; i + 1 < same.length; i++) {
    if (ordOf(same[i + 1].chunk_id) - ordOf(same[i].chunk_id) === 1 && quoteAppears(`${same[i].text} ${same[i + 1].text}`, quote)) return same[i];
  }
  return null;
}

/** Checks one finding; used when the agent records it and again on the final decision. */
export function checkFinding(f: Finding, label: string, evidence: Map<string, Evidence>, customer: PolicyholderFile | null):
  { issues: string[]; citations: Omit<Validation["citations"][number], "finding">[]; finding: Finding } {
  const issues: string[] = [];
  const citations: Omit<Validation["citations"][number], "finding">[] = [];
  const policyIds = new Set(customer?.policies.map((p) => p.policy_id) ?? []);
  const decisive = f.status === "likely_covered" || f.status === "likely_excluded";
  if (f.policy_id && !policyIds.has(f.policy_id)) issues.push(`${label} names policy ${f.policy_id}, which is not one of this customer's policies (${[...policyIds].join(", ") || "none"}).`);
  if (f.status === "no_policy" && f.policy_id) issues.push(`${label} is no_policy, so policy_id must be null.`);
  if (decisive && !customer) issues.push(`${label} draws a coverage conclusion without a verified policyholder; mark it unclear.`);
  if (decisive && !f.citations.length) issues.push(`${label} is ${f.status} without a citation. Quote a passage you retrieved, or mark it unclear.`);
  let official = false;
  const fixed = [];
  for (const c of f.citations) {
    const ev = locateQuote(evidence, c.chunk_id, c.quote);
    if (!ev) {
      issues.push(evidence.has(c.chunk_id) || [...evidence.keys()].some((k) => k.startsWith(c.chunk_id.slice(0, c.chunk_id.lastIndexOf("#") + 1)))
        ? `${label}: those exact words are not in ${c.chunk_id} or its neighbours. Copy a sentence exactly as written (you may use "..." to skip words).`
        : `${label} cites ${c.chunk_id}, which was not retrieved in this run.`);
      continue;
    }
    if (f.policy_id && ev.policy_id && ev.policy_id !== f.policy_id) issues.push(`${label} cites a passage from policy ${ev.policy_id}, not ${f.policy_id}.`);
    official ||= OFFICIAL.test(ev.source_type);
    fixed.push({ chunk_id: ev.chunk_id, quote: c.quote });
    citations.push({ chunk_id: ev.chunk_id, doc_id: ev.doc_id, form_number: ev.form_number, section: ev.section, page: ev.page,
      quote: c.quote, url: documentUrl(ev.doc_id, ev.page) });
  }
  if (f.status === "likely_covered" && citations.length && !official) {
    issues.push(`${label} relies only on a web overview or court opinion, which does not prove purchased coverage; mark it unclear.`);
  }
  return { issues, citations, finding: { ...f, citations: fixed.length === f.citations.length ? fixed : f.citations } };
}

export function validateDecision(d: Decision, evidence: Map<string, Evidence>, customer: PolicyholderFile | null, actions?: RunActions): Validation {
  const issues: string[] = [];
  const citations: Validation["citations"] = [];
  d.findings.forEach((f, i) => {
    const r = checkFinding(f, `Finding ${i + 1} ("${f.item}")`, evidence, customer);
    issues.push(...r.issues);
    citations.push(...r.citations.map((c) => ({ ...c, finding: i })));
  });

  if (d.immediate_danger && !/\b911\b/.test(d.reply)) issues.push("immediate_danger is true but the reply does not tell them to call 911.");
  if (d.immediate_danger && d.next_action !== "human_review") issues.push("immediate_danger requires next_action human_review.");
  for (const [pattern, what] of OVERPROMISE) {
    const hit = pattern.exec(d.reply);
    if (hit) issues.push(`The reply ${what}: "${sentenceAround(d.reply, hit.index)}". Nothing in this run made that true; rewrite that sentence conditionally.`);
  }
  if (INTERNAL.test(d.reply)) issues.push("The reply exposes internal identifiers, tool names or scores. Remove them.");
  if (/\*\*|^#{1,3} |^\s*[-*] \*\*/m.test(d.reply)) issues.push("The reply is a text message: use plain text, no markdown.");
  const followUpQueued = d.next_action === "human_review" || !!actions && ["request_human_review", "prepare_claim"].some((t) => actions.completedTools.has(t));
  if (actions && FOLLOW_UP.test(d.reply) && !followUpQueued) {
    issues.push("The reply promises that someone will contact the customer, but nothing in this run queued that. Call request_human_review or prepare_claim, or remove the promise.");
  }
  return { issues, citations };
}

function sentenceAround(text: string, at: number): string {
  const start = Math.max(text.lastIndexOf(".", at) + 1, text.lastIndexOf("\n", at) + 1, 0);
  const end = text.slice(at).search(/[.\n]/);
  return text.slice(start, end < 0 ? undefined : at + end + 1).trim().slice(0, 200);
}

export const FALLBACK_REPLY = "Thank you for letting us know. We have your message and a State Farm claims specialist will review it and follow up with you. If anyone is hurt or in danger right now, call 911.";

/** A decision that is always safe to send: unverified findings become unclear, and a human takes over. */
export function sanitize(d: Decision, evidence: Map<string, Evidence>, customer: PolicyholderFile | null, reason: string): Decision {
  const findings: Finding[] = d.findings.map((f) => {
    const valid = f.citations.filter((c) => locateQuote(evidence, c.chunk_id, c.quote));
    const keep = valid.length === f.citations.length && (f.status === "unclear" || f.status === "no_policy" || valid.length > 0) && !!customer;
    return keep ? f : { ...f, status: "unclear", citations: valid, explanation: `${f.explanation} (Not verified against the policy text; needs review.)`.slice(0, 700) };
  });
  // Once validation is exhausted, the proposed reply is untrusted too. A wording
  // check cannot establish that its coverage statements follow from the evidence.
  return { ...d, findings, next_action: "human_review", decision_reason: `${d.decision_reason} [Routed to a human: ${reason}]`.slice(0, 500),
    reply: FALLBACK_REPLY };
}
