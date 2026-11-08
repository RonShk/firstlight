"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ListFilter } from "lucide-react";
import type { Severity } from "@/types/claims";
import { cn } from "@/lib/utils";
import { SEVERITY_META } from "./severity";

export type ClaimFilterKey = Severity | "claim_pending" | "claim_filed";
export const SEVERITY_KEYS: Severity[] = ["critical", "high", "medium", "low"];
const CLAIM_OPTIONS: { key: ClaimFilterKey; label: string; dot: string }[] = [
  { key: "claim_pending", label: "Claim drafted · awaiting confirmation", dot: "bg-high" },
  { key: "claim_filed", label: "Claim filed", dot: "bg-emerald-600" },
];

/** Severity and claim-status filter for the inbox, in a small dropdown. */
export function ClaimFilter({ value, onChange, counts }: { value: Set<ClaimFilterKey>; onChange: (next: Set<ClaimFilterKey>) => void; counts: Record<ClaimFilterKey, number> }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);
  const toggle = (key: ClaimFilterKey) => { const next = new Set(value); if (!next.delete(key)) next.add(key); onChange(next); };
  const Option = ({ k, label, dot }: { k: ClaimFilterKey; label: string; dot: string }) => (
    <button role="menuitemcheckbox" aria-checked={value.has(k)} onClick={() => toggle(k)}
      className={cn("flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left text-sm hover:bg-soft", value.has(k) && "bg-soft")}>
      <span className={cn("grid size-4 shrink-0 place-items-center rounded border", value.has(k) ? "border-brand bg-brand text-white" : "border-line bg-white")}>{value.has(k) && <Check className="size-3" strokeWidth={3} />}</span>
      <span className={cn("size-2 shrink-0 rounded-full", dot)} />
      <span className="flex-1">{label}</span>
      <span className="text-xs text-subtle">{counts[k]}</span>
    </button>
  );
  return <div ref={root} className="relative">
    <button aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}
      className={cn("flex h-full items-center gap-1.5 rounded-lg border px-3 text-sm", value.size ? "border-brand text-brand" : "border-line text-ink hover:bg-soft")}>
      <ListFilter className="size-4" />Filter{value.size > 0 && <span className="grid size-5 place-items-center rounded-full bg-brand text-[11px] font-semibold text-white">{value.size}</span>}
    </button>
    {open && <div role="menu" className="absolute top-full right-0 z-30 mt-2 w-72 rounded-xl border border-line bg-white p-2 shadow-xl">
      <p className="px-2.5 pt-1 pb-1.5 text-[11px] font-semibold tracking-wider text-subtle uppercase">Severity</p>
      {SEVERITY_KEYS.map((k) => <Option key={k} k={k} label={SEVERITY_META[k].label} dot={SEVERITY_META[k].dot} />)}
      <div className="my-2 h-px bg-line" />
      <p className="px-2.5 pb-1.5 text-[11px] font-semibold tracking-wider text-subtle uppercase">Claim</p>
      {CLAIM_OPTIONS.map((o) => <Option key={o.key} k={o.key} label={o.label} dot={o.dot} />)}
      <div className="mt-2 flex justify-between border-t border-line px-1 pt-2">
        <button disabled={!value.size} onClick={() => onChange(new Set())} className="rounded px-2 py-1 text-sm text-subtle hover:text-ink disabled:opacity-40">Clear all</button>
        <button onClick={() => setOpen(false)} className="rounded-lg bg-brand px-3 py-1 text-sm font-semibold text-white">Done</button>
      </div>
    </div>}
  </div>;
}

/** Severities narrow among themselves (any of), claim statuses likewise, and the two groups combine (both). */
export function matchesFilter(value: Set<ClaimFilterKey>, severity: Severity, claimStatus: string | undefined): boolean {
  const severities = SEVERITY_KEYS.filter((k) => value.has(k));
  const claims = [...value].filter((k) => k.startsWith("claim_"));
  const claimKey = claimStatus === "confirmed" ? "claim_filed" : claimStatus === "pending" ? "claim_pending" : null;
  return (!severities.length || severities.includes(severity)) && (!claims.length || (!!claimKey && claims.includes(claimKey)));
}
