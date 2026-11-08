"use client";

import { Search } from "lucide-react";
import type { ClaimView } from "@/types/claims";
import { cn } from "@/lib/utils";
import { agentStatus } from "@/lib/claims/agent-status";
import { ageLabel } from "@/lib/claims/format";
import { useClaims } from "./claims-provider";
import { SEVERITY_META } from "./severity";
import { claimStatusMeta } from "./claim-panel";

export const PAGE_SIZE = 20;
interface Props {
  claims: ClaimView[]; selectedId?: string; onSelect: (id: string) => void;
  search: string; onSearch: (s: string) => void; page: number; onPage: (n: number) => void;
  /** Filter control shown beside the search box. */
  filter?: React.ReactNode;
}
export function ClaimList({ claims, selectedId, onSelect, search, onSearch, page, onPage, filter }: Props) {
  const { isRead, runFor, claimFor } = useClaims();
  const rows = claims.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const lastPage = Math.max(0, Math.ceil(claims.length / PAGE_SIZE) - 1);
  const controls = <nav aria-label="Inbox pages" className="flex shrink-0 items-center justify-between border-t border-line bg-white px-5 py-4 text-xs">
    <span className="text-subtle">{claims.length ? page * PAGE_SIZE + 1 : 0}–{Math.min(claims.length, (page + 1) * PAGE_SIZE)} of {claims.length}</span>
    <div className="flex gap-4 text-sm font-semibold text-ink">
      <button disabled={!page} onClick={() => onPage(page - 1)} className="cursor-pointer hover:underline disabled:cursor-default disabled:text-disabled disabled:no-underline">Previous</button>
      <button disabled={page >= lastPage} onClick={() => onPage(page + 1)} className="cursor-pointer hover:underline disabled:cursor-default disabled:text-disabled disabled:no-underline">Next</button>
    </div>
  </nav>;
  return <aside className="flex w-[280px] shrink-0 flex-col border-r border-line bg-white xl:w-[330px]">
    <div className="border-b border-line p-5"><h2 className="font-semibold">Case inbox <span className="ml-1 text-sm font-normal text-subtle">{claims.length}</span></h2>
      <div className="mt-3 flex gap-2"><label className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-line px-3 py-2"><Search className="size-4 shrink-0 text-subtle" /><input aria-label="Search cases" value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Name, case, or message" className="min-w-0 flex-1 text-sm outline-none" /></label>{filter}</div>
    </div>
    <div className="inbox-scroll min-h-0 flex-1 overflow-y-auto">{rows.map((c) => { const status = agentStatus(runFor(c.id)); return <button key={c.id} type="button" aria-current={selectedId === c.id || undefined} onClick={() => onSelect(c.id)} className={cn("block w-full cursor-pointer border-b border-line p-5 text-left", selectedId === c.id ? "border-l-2 border-l-brand bg-critical-soft/40" : "hover:bg-soft")}>
      <span className="flex items-center gap-2"><span className={cn("size-1.5 shrink-0 rounded-full", isRead(c.id) ? "bg-transparent" : "bg-brand")} /><span className="min-w-0 flex-1 truncate font-semibold">{c.persona.name}</span><span className="text-xs text-subtle">{ageLabel(c.minutesAgo)}</span></span>
      <span className="mt-1 block truncate text-sm">{c.subject}</span><span className="mt-2 flex items-center justify-between gap-2 text-xs"><span className="text-subtle">{c.persona.address.city} · {c.silent ? "No response" : c.peril}</span><span className={cn("rounded-full px-2 py-0.5", SEVERITY_META[c.review.severity].chip)}>{SEVERITY_META[c.review.severity].label}</span></span>
      <span className={cn("mt-3 inline-block rounded px-2 py-1 text-xs font-medium", status.tone === "running" ? "bg-blue-50 text-blue-800" : status.tone === "done" ? "bg-emerald-50 text-emerald-800" : status.tone === "review" ? "bg-high-soft text-high-ink" : status.tone === "failed" ? "bg-critical-soft text-critical-ink" : "bg-soft text-subtle")}>Agent: {status.label}</span>
      {(() => { const filed = claimFor(c.id); return filed && <span className={cn("mt-2 block w-fit rounded px-2 py-1 text-xs font-semibold", claimStatusMeta(filed.status).chip)}>{claimStatusMeta(filed.status).label}</span>; })()}
    </button>; })}{!rows.length && <p className="p-5 text-sm text-subtle">No matching cases.</p>}</div>
    {controls}
  </aside>;
}
