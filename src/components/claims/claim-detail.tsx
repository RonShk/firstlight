"use client";

import type { PolicyLine } from "@/types/sim";
import type { ClaimView, ReviewState } from "@/types/claims";
import { cn } from "@/lib/utils";
import { sectionLabel } from "@/lib/claims/format";
import { DOCUMENT_FORMS, LINE_LABEL, appliesNote } from "@/lib/claims/policy-documents";
import { AGENTS } from "@/lib/sim/data";
import { HOUSEHOLD_LABELS } from "@/lib/sim/personas";
import { ADJUSTER, useClaims } from "./claims-provider";

const REVIEW_LABEL: Record<ReviewState, string> = {
  quick: "Quick read",
  reviewing: "Quick read · Nemotron is reviewing",
  reviewed: "Reviewed by Nemotron",
  offline: "Quick read · Nemotron offline",
  unavailable: "Quick read · Nemotron unavailable",
  human_review: "Human intervention needed · queued for claims review",
  none: "",
};

const POLICY_ROW_LABEL: Record<PolicyLine, string> = { auto: "Auto policy", home: "Homeowners policy", umbrella: "Umbrella policy" };

function Label({ children }: { children: React.ReactNode }) {
  return <p className="text-[14px] text-subtle">{children}</p>;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[172px_1fr] items-baseline gap-2 py-[7px]">
      <dt className="text-[14px] text-subtle">{label}</dt>
      <dd className="min-w-0 text-[16px] text-ink">{children}</dd>
    </div>
  );
}

function PolicyRow({ claim, line }: { claim: ClaimView; line: PolicyLine }) {
  const policy = claim.persona.policies.find((p) => p.line === line);
  if (!policy) return <Detail label={POLICY_ROW_LABEL[line]}><span className="text-subtle">None on file</span></Detail>;
  const applies = claim.documents.some((d) => d.line === line);
  return (
    <Detail label={POLICY_ROW_LABEL[line]}>
      <span className={applies ? undefined : "text-subtle"}>{policy.id}</span>
      {applies ? <span className="ml-2 rounded-full bg-soft px-2.5 py-0.5 text-[13.5px] font-semibold">Applies</span> : null}
      {applies ? <p className="mt-0.5 text-[14px] text-subtle">{appliesNote(line, claim.review.lines, claim.peril)}</p> : null}
    </Detail>
  );
}

interface ClaimDetailProps {
  claim: ClaimView;
  onConversation: () => void;
  onDocuments: (docId?: string, page?: number | null) => void;
}

export function ClaimDetail({ claim, onConversation, onDocuments }: ClaimDetailProps) {
  const { isAssigned, toggleAssigned } = useClaims();
  const { persona: p, review } = claim;
  const assigned = isAssigned(claim.id);
  const typeLabel = `${review.lines[0] ? LINE_LABEL[review.lines[0]] : "General"} · ${claim.peril}`;

  return (
    <div className="px-[36px] pt-[36px] pb-[48px]">
      <section className="mt-[42px] border-b border-line pb-[45px]">
        <h2 className="text-[16px] font-semibold text-ink">{claim.subject}</h2>
        {claim.body.length ? (
          claim.body.map((text, i) => <p key={i} className="mt-3 max-w-[680px] text-[17.5px] leading-[26.5px] text-ink">{text}</p>)
        ) : (
          <p className="mt-3 max-w-[680px] text-[17.5px] leading-[26.5px] text-subtle">No message received. This household hasn&apos;t answered either tornado check-in.</p>
        )}
      </section>

      <section className="mt-[42px] border-b border-line pb-[35px]">
        <div className="flex items-baseline gap-3">
          <h2 className="text-[14.5px] font-semibold text-subtle">Analysis</h2>
          {REVIEW_LABEL[review.state] ? <span className="text-[13px] text-subtle">{REVIEW_LABEL[review.state]}</span> : null}
        </div>
        <p className="mt-3 max-w-[680px] text-[16px] leading-[23px] text-ink">{review.summary}</p>

        <div className="mt-4">
          <Label>Risk</Label>
          <p className="text-[16px] text-ink">{review.risk}</p>
        </div>

        <div className="mt-4">
          <Label>Coverage layers</Label>
          {claim.layers.length ? (
            claim.layers.map((l) => (
              <div key={l.name} className="mt-2 grid grid-cols-3 gap-4 text-[16px]">
                <span className="text-ink">{l.name}</span>
                <span className="text-ink">{l.amount}</span>
                <span className="text-subtle">{l.note}</span>
              </div>
            ))
          ) : (
            <p className="mt-1 text-[16px] text-subtle">No coverage identified yet</p>
          )}
        </div>

        <div className="mt-4">
          <Label>Sources</Label>
          {review.citations.length ? (
            <div className="mt-1.5 flex flex-wrap gap-x-[22px] gap-y-1 text-[15px] font-semibold text-ink">
              {review.citations.map((c) => {
                const text = `${DOCUMENT_FORMS[c.doc_id]?.name ?? "Form"} ${c.form_number} · ${sectionLabel(c.section)}`;
                return (
                  <button key={`${c.doc_id}:${c.section}:${c.quote}`} type="button" title={c.quote} onClick={() => onDocuments(c.doc_id, c.page)} className="cursor-pointer text-left hover:underline">{text}</button>
                );
              })}
            </div>
          ) : (
            <p className="mt-1 text-[15px] text-subtle">{review.state === "reviewing" ? "Searching the policy forms…" : claim.silent ? "None until the policyholder replies" : review.state === "reviewed" ? "No policy clause was cited" : "Added after Nemotron reviews the claim"}</p>
          )}
        </div>

        <div className="mt-[34px] flex gap-3.5">
          <button type="button" onClick={onConversation} className="h-[38px] cursor-pointer rounded-full bg-brand px-[23px] text-[16px] font-semibold text-white hover:bg-brand-dark">Reply</button>
          <button type="button" onClick={() => toggleAssigned(claim.id)} className={cn("h-[38px] cursor-pointer rounded-full border border-[#bdbdbd] px-[22px] text-[16px] font-semibold text-ink hover:bg-soft", assigned && "bg-[#f7f7f7]")}>{assigned ? "Return to queue" : "Assign to me"}</button>
        </div>
      </section>

      <section className="mt-[42px]">
        <h2 className="mb-2 text-[14.5px] font-semibold text-subtle">Policyholder details</h2>
        <dl>
          <Detail label="Policyholder">{p.name}</Detail>
          <Detail label="Phone">{p.phone}</Detail>
          <PolicyRow claim={claim} line="auto" />
          <PolicyRow claim={claim} line="home" />
          <PolicyRow claim={claim} line="umbrella" />
          <Detail label="Claim type">{typeLabel}</Detail>
          <Detail label="Location">{p.address.street}, {p.address.city}, {p.address.state} {p.address.zip}</Detail>
          <Detail label="Occupation">{p.occupation}{p.selfEmployed ? " · Self-employed" : ""}</Detail>
          <Detail label="Housing">{p.housing === "own" ? "Homeowner" : "Renter"}</Detail>
          <Detail label="Local agent">{AGENTS.find((a) => a.id === p.agentId)?.name ?? "Not assigned"}</Detail>
          <Detail label="Household">{HOUSEHOLD_LABELS[p.householdType]} · {p.members.length} {p.members.length === 1 ? "person" : "people"}</Detail>
          {p.vulnerabilities.length ? <Detail label="Household flags">{p.vulnerabilities.join(" · ")}</Detail> : null}
          <Detail label="Assigned to">{assigned ? ADJUSTER : "Unassigned"}</Detail>
        </dl>
        <div className="mt-6 grid gap-3 xl:grid-cols-2">{p.members.map((m) => <article key={`${m.name}:${m.relation}`} className="rounded-lg border border-line p-4"><h3 className="text-sm font-semibold">{m.name} · {m.age}</h3><p className="mt-1 text-xs text-subtle">{m.relation}{m.limitedMobility ? " · Limited mobility" : ""}{m.medicalNeeds ? ` · ${m.medicalNeeds}` : ""}</p></article>)}</div>
      </section>
    </div>
  );
}
