"use client";

import { useState } from "react";
import type { FiledClaim } from "@/cases/claim-files";
import { ClaimPanel, claimStatusMeta } from "./claim-panel";
import { useClaims } from "./claims-provider";

const FILTERS = [["pending", "Awaiting confirmation"], ["confirmed", "Filed"], ["denied", "Denied"]] as const;

/** Every claim: drafted by the agent or a reviewer, then confirmed (filed) or denied by a person. */
export function FilingDesk() {
  const { filedClaims: claims } = useClaims();
  const [filter, setFilter] = useState<FiledClaim["status"]>("pending");
  const [selected, setSelected] = useState<string>();
  const visible = claims.filter((c) => c.status === filter);
  const claim = claims.find((c) => c.id === selected);
  return <div className="flex min-h-0 flex-1 overflow-hidden">
    <aside className="thin-scroll w-80 shrink-0 overflow-y-auto border-r border-line p-5">
      <h1 className="text-2xl font-semibold">Claims</h1>
      <div className="my-4 flex flex-wrap gap-x-4 gap-y-1 text-sm">{FILTERS.map(([s, label]) => <button key={s} onClick={() => setFilter(s)} className={filter === s ? "font-semibold text-brand" : "text-subtle"}>{label} ({claims.filter((c) => c.status === s).length})</button>)}</div>
      {visible.map((c) => <button key={c.id} onClick={() => setSelected(c.id)} className={`mb-2 w-full rounded-lg border p-3 text-left ${c.id === selected ? "border-brand" : "border-line"}`}>
        <strong>{c.customer.name}</strong><span className="float-right text-xs text-subtle">{c.id}</span>
        <span className={`mt-2 inline-block rounded px-2 py-0.5 text-xs font-medium ${claimStatusMeta(c.status).chip}`}>{claimStatusMeta(c.status).label}</span>
        <p className="mt-1 text-xs text-subtle">{c.source === "auto" ? "Drafted by agent" : "Drafted by reviewer"} · {new Date(c.filedAt).toLocaleString()}</p>
        <p className="mt-1 line-clamp-2 text-sm">{c.findings.map((f) => f.item).join(", ") || c.summary}</p>
      </button>)}
      {!visible.length && <p className="text-sm text-subtle">No claims {FILTERS.find(([s]) => s === filter)![1].toLowerCase()}.</p>}
    </aside>
    <main className="min-w-0 flex-1 overflow-hidden">{claim ? <ClaimPanel key={claim.id} claim={claim} /> : <p className="p-8 text-subtle">Select a claim to read its notice and confirm or deny it.</p>}</main>
  </div>;
}
