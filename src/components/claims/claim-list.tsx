"use client";

import { Popover } from "@base-ui/react/popover";
import { Search } from "lucide-react";
import type { PolicyLine } from "@/types/sim";
import type { ClaimView, Severity } from "@/types/claims";
import { cn } from "@/lib/utils";
import { ageLabel } from "@/lib/claims/format";
import { LINE_LABEL } from "@/lib/claims/policy-documents";
import { SEVERITIES } from "@/lib/claims/quick-read";
import { useClaims } from "./claims-provider";
import { SEVERITY_META } from "./severity";

export const PAGE_SIZE = 20;

export type Assignment = "all" | "mine" | "unassigned";

export interface ClaimFilters {
  severities: Severity[];
  lines: PolicyLine[];
  assignment: Assignment;
}

export const NO_FILTERS: ClaimFilters = { severities: [], lines: [], assignment: "all" };

const ASSIGNMENT_LABEL: Record<Assignment, string> = { all: "All claims", mine: "Assigned to me", unassigned: "Unassigned" };
const LINES: PolicyLine[] = ["auto", "home", "umbrella"];

const toggle = <T,>(list: T[], item: T) => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 py-1 text-[14px] text-ink">
      <input type="checkbox" checked={checked} onChange={onChange} className="size-3.5 accent-brand" />
      {label}
    </label>
  );
}

function FilterMenu({ filters, onChange }: { filters: ClaimFilters; onChange: (f: ClaimFilters) => void }) {
  const active = filters.severities.length + filters.lines.length + (filters.assignment === "all" ? 0 : 1);
  return (
    <Popover.Root>
      <Popover.Trigger className="shrink-0 cursor-pointer text-[15px] font-semibold text-ink hover:underline">Filters{active ? ` (${active})` : ""}</Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="end" sideOffset={10} className="z-30">
          <Popover.Popup className="w-[230px] rounded-xl border border-line bg-white p-4 shadow-lg outline-none">
            <p className="mb-1 text-[13px] font-semibold text-subtle">Severity</p>
            {SEVERITIES.map((s) => (
              <Check key={s} label={SEVERITY_META[s].label} checked={filters.severities.includes(s)} onChange={() => onChange({ ...filters, severities: toggle(filters.severities, s) })} />
            ))}
            <p className="mt-3 mb-1 text-[13px] font-semibold text-subtle">Policy</p>
            {LINES.map((l) => (
              <Check key={l} label={LINE_LABEL[l]} checked={filters.lines.includes(l)} onChange={() => onChange({ ...filters, lines: toggle(filters.lines, l) })} />
            ))}
            <p className="mt-3 mb-1 text-[13px] font-semibold text-subtle">Assignment</p>
            <select
              aria-label="Assignment"
              value={filters.assignment}
              onChange={(e) => onChange({ ...filters, assignment: e.target.value as Assignment })}
              className="w-full rounded-lg border border-line bg-white px-2 py-1.5 text-[14px] text-ink"
            >
              {(Object.keys(ASSIGNMENT_LABEL) as Assignment[]).map((a) => (
                <option key={a} value={a}>
                  {ASSIGNMENT_LABEL[a]}
                </option>
              ))}
            </select>
            {active ? (
              <button type="button" onClick={() => onChange(NO_FILTERS)} className="mt-3 cursor-pointer text-[14px] font-semibold text-ink hover:underline">
                Clear filters
              </button>
            ) : null}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Row({ claim, selected, onSelect }: { claim: ClaimView; selected: boolean; onSelect: () => void }) {
  const { isRead } = useClaims();
  return (
    <button type="button" onClick={onSelect} aria-current={selected || undefined} className={cn("relative block w-full cursor-pointer border-b border-line px-[22px] pt-[14px] pb-[13px] text-left", selected ? "bg-soft" : "hover:bg-[#fafafa]")}>
      {isRead(claim.id) ? null : <span aria-label="Unread" className="absolute top-[21px] left-[9px] size-[5px] rounded-full bg-ink" />}
      <span className="flex items-baseline justify-between gap-3">
        <span className="truncate text-[15px] font-semibold text-ink">{claim.persona.name}</span>
        <span className="shrink-0 text-[13px] text-subtle">{ageLabel(claim.minutesAgo)}</span>
      </span>
      <span className="mt-0.5 block truncate text-[14.5px] text-ink-2">{claim.subject}</span>
      <span className="mt-0.5 block text-[13px] text-subtle">{claim.number}</span>
    </button>
  );
}

interface ClaimListProps {
  claims: ClaimView[];
  selectedId: string | undefined;
  onSelect: (id: string) => void;
  search: string;
  onSearch: (value: string) => void;
  filters: ClaimFilters;
  onFilters: (filters: ClaimFilters) => void;
  page: number;
  onPage: (page: number) => void;
}

export function ClaimList({ claims, selectedId, onSelect, search, onSearch, filters, onFilters, page, onPage }: ClaimListProps) {
  const rows = claims.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const lastPage = Math.max(0, Math.ceil(claims.length / PAGE_SIZE) - 1);
  const first = claims.length ? page * PAGE_SIZE + 1 : 0;
  const last = Math.min(claims.length, (page + 1) * PAGE_SIZE);

  return (
    <aside className="flex w-[380px] shrink-0 flex-col border-r border-line bg-white">
      <div className="flex items-center gap-4 border-b border-line px-[22px] py-[22px]">
        <label className="flex h-[38px] min-w-0 flex-1 items-center gap-2 rounded-full bg-soft px-4">
          <Search className="size-[14px] shrink-0 text-subtle" strokeWidth={2} />
          <input aria-label="Search claims" value={search} onChange={(e) => onSearch(e.target.value)} placeholder="Search name, claim, or message" className="w-full min-w-0 bg-transparent text-[15px] text-ink outline-none placeholder:text-subtle" />
        </label>
        <FilterMenu filters={filters} onChange={onFilters} />
      </div>

      <div className="thin-scroll min-h-0 flex-1 overflow-y-auto">
        {SEVERITIES.map((s) => (
          <section key={s}>
            <h2 className="flex items-center gap-2 border-b border-line px-[22px] py-[9px] text-[14px] font-semibold text-ink">
              <span className={cn("size-[7px] rounded-full", SEVERITY_META[s].dot)} />
              {SEVERITY_META[s].label}
              <span className="ml-0.5 font-normal text-ink-2">{claims.filter((c) => c.review.severity === s).length.toLocaleString("en-US")}</span>
            </h2>
            {rows.filter((c) => c.review.severity === s).map((c) => (
              <Row key={c.id} claim={c} selected={c.id === selectedId} onSelect={() => onSelect(c.id)} />
            ))}
          </section>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-line px-[22px] py-[17px] text-[14px]">
        <span className="text-ink-2">{first}–{last} of {claims.length.toLocaleString("en-US")}</span>
        <span className="flex gap-5 text-[15px] font-semibold">
          <button type="button" disabled={page === 0} onClick={() => onPage(page - 1)} className="cursor-pointer text-ink hover:underline disabled:cursor-default disabled:text-disabled disabled:no-underline">Previous</button>
          <button type="button" disabled={page >= lastPage} onClick={() => onPage(page + 1)} className="cursor-pointer text-ink hover:underline disabled:cursor-default disabled:text-disabled disabled:no-underline">Next</button>
        </span>
      </div>
    </aside>
  );
}
