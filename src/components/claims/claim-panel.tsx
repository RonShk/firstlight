"use client";

import { useState } from "react";
import type { FiledClaim } from "@/cases/claim-files";
import { cn } from "@/lib/utils";
import { useClaims } from "./claims-provider";
import { PdfReader } from "./pdf-reader";

export const CLAIM_STATUS: Record<FiledClaim["status"], { label: string; chip: string }> = {
  pending: { label: "Claim drafted · awaiting human confirmation", chip: "bg-high-soft text-high-ink" },
  confirmed: { label: "Claim filed", chip: "bg-emerald-50 text-emerald-800" },
  denied: { label: "Claim denied", chip: "bg-critical-soft text-critical-ink" },
};

/** Status label and style; older builds stored "filed"/"approved", which map onto the current lifecycle. */
export function claimStatusMeta(status: string | undefined) {
  const key = status === "approved" ? "confirmed" : status === "confirmed" || status === "denied" ? status : "pending";
  return CLAIM_STATUS[key];
}

async function postJson(url: string, body: object) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
  return d;
}

/** Start a claim from anywhere in the review loop, or show the claim's status once it exists. */
export function FileClaimButton({ personaId, caseId, onOpen }: { personaId: string; caseId: string | undefined; onOpen: () => void }) {
  const { claimFor, refreshClaims } = useClaims();
  const claim = claimFor(personaId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!caseId) return null;
  if (claim) return <button onClick={onOpen} className={cn("cursor-pointer rounded-full px-3 py-1 text-xs font-semibold", claimStatusMeta(claim.status).chip)}>{claim.id} · {claimStatusMeta(claim.status).label}</button>;
  return <span className="flex flex-col items-end gap-1">
    <button disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await postJson("/api/claim-files", { caseId }); await refreshClaims(); onOpen(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}
      className="cursor-pointer rounded-full bg-brand px-4 py-1.5 text-xs font-semibold text-white disabled:opacity-40">{busy ? "Drafting…" : "Draft claim now"}</button>
    {error && <span role="alert" className="text-xs text-critical-ink">{error}</span>}
  </span>;
}

/** The claim document (scrollable, centered) beside the confirm / deny decision. */
export function ClaimPanel({ claim, caseId }: { claim?: FiledClaim; caseId?: string }) {
  const { refreshClaims } = useClaims();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!claim) {
    if (!caseId) return <p className="p-8 text-sm text-subtle">This household has no case yet, so there is nothing to draft.</p>;
    return <section className="mx-auto max-w-3xl space-y-4 p-9">
      <h2 className="text-2xl font-semibold">No claim drafted yet</h2>
      <p className="text-base leading-relaxed text-ink-2">The agent drafts a claim on its own once its verified review proves every reported loss covered. You can draft it now instead; the claim records the agent review as it stands, and still needs your confirmation to be filed.</p>
      <button disabled={busy} onClick={async () => { setBusy(true); setError(null); try { await postJson("/api/claim-files", { caseId }); await refreshClaims(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}
        className="cursor-pointer rounded-full bg-brand px-6 py-2.5 font-semibold text-white disabled:opacity-40">{busy ? "Drafting…" : "Draft claim now"}</button>
      {error && <p role="alert" className="text-sm text-critical-ink">{error}</p>}
    </section>;
  }

  const decide = async (body: object) => {
    setBusy(true); setError(null);
    try { await postJson(`/api/claim-files/${claim.id}/decision`, body); await refreshClaims(); setNote(""); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const pdfUrl = `/api/claim-files/${claim.id}/pdf?v=${claim.status}`;
  const meta = claimStatusMeta(claim.status);
  return <section className="flex h-full min-h-0">
    {/* The PDF scrolls on its own, centered, so the decision stays in view. */}
    <div className="relative min-h-0 min-w-0 flex-1 border-r border-line">
      <PdfReader key={pdfUrl} url={pdfUrl} label="claim" />
    </div>
    <aside className="thin-scroll w-[340px] shrink-0 space-y-6 overflow-y-auto p-6 2xl:w-[380px]">
      <div>
        <p className="text-xs text-subtle">{claim.id} · drafted {new Date(claim.filedAt).toLocaleString()}</p>
        <span className={cn("mt-2 inline-block rounded-full px-3 py-1 text-xs font-semibold", meta.chip)}>{meta.label}</span>
        <p className="mt-3 text-sm leading-relaxed text-ink-2">{claim.basis}</p>
        <a href={pdfUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-sm font-semibold text-brand">Open PDF in a new tab ↗</a>
      </div>
      {claim.status === "pending" ? <div className="space-y-5 border-t border-line pt-5">
        <div>
          <h3 className="text-lg font-semibold">Confirm and file</h3>
          <p className="mt-1 text-sm text-subtle">Read the notice. Confirming files the claim and moves it to filed claims.</p>
          <button disabled={busy} onClick={() => decide({ decision: "confirm" })} className="mt-3 w-full cursor-pointer rounded-full bg-emerald-700 px-5 py-2.5 font-semibold text-white disabled:opacity-40">{busy ? "Saving…" : "Confirm claim"}</button>
        </div>
        <div className="space-y-2">
          <label className="text-sm font-semibold" htmlFor="deny-note">Or deny</label>
          <textarea id="deny-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-lg border border-line p-2.5 text-sm" placeholder="Reason, e.g. wear and tear exclusion applies" />
          <button disabled={busy || note.trim().length < 3} onClick={() => decide({ decision: "deny", note })} className="cursor-pointer rounded-lg border border-critical px-4 py-2 text-sm font-semibold text-critical-ink disabled:opacity-40">Deny claim</button>
        </div>
      </div> : <div className="space-y-2 border-t border-line pt-5 text-sm">
        <h3 className="text-lg font-semibold">{claim.status === "confirmed" ? "Confirmed and filed" : "Denied"}</h3>
        {claim.decidedAt && <p className="text-subtle">{new Date(claim.decidedAt).toLocaleString()}</p>}
        {claim.decisionNote && <p className="text-ink-2">{claim.decisionNote}</p>}
      </div>}
      {error && <p role="alert" className="text-sm text-critical-ink">{error}</p>}
    </aside>
  </section>;
}
