"use client";

import { useCallback, useMemo, useState } from "react";
import type { RunSummary } from "@/types/agent";
import { agentStatus } from "@/lib/claims/agent-status";
import { cn } from "@/lib/utils";
import { SituationView } from "./claim-detail";
import { ClaimList, PAGE_SIZE } from "./claim-list";
import { useClaims } from "./claims-provider";
import { PolicyOverlay } from "./policy-overlay";
import { CaseTimeline } from "../sim/case-timeline";
import { CaseMessages, CasePolicies, RunOverview } from "./case-views";

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "messages", label: "Messages" },
  { id: "timeline", label: "Agent timeline" },
  { id: "policies", label: "Policies" },
  { id: "situation", label: "Situation" },
] as const;
type Tab = typeof TABS[number]["id"];
export function ClaimsWorkspace() {
  const { claims, markRead, runFor, queue, ready, loadError } = useClaims();
  const [selectedId, setSelectedId] = useState<string | undefined>(() => claims.find((c) => !c.silent)?.id);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [tab, setTab] = useState<Tab>("overview");
  const [target, setTarget] = useState<{ docId: string; page: number | null } | null>(null);
  const visible = useMemo(() => claims.filter((c) => !c.silent && [c.persona.name, c.number, c.subject, ...c.body].some((s) => s.toLowerCase().includes(search.trim().toLowerCase()))), [claims, search]);
  const selected = visible.find((c) => c.id === selectedId) ?? visible[page * PAGE_SIZE] ?? visible[0];
  const run = selected ? runFor(selected.id) : undefined;

  const customerId = selected?.id;
  const followRun = useCallback((summary: RunSummary | undefined) => {
    if (!customerId || !summary) return;
    const tracked = queue.runsFor(customerId).at(-1);
    if (tracked?.runId !== summary.id) queue.restore(customerId, tracked?.conversation ?? [], summary, true);
  }, [customerId, queue]);
  const openDocument = (docId: string, p: number | null) => { setTarget({ docId, page: p }); };
  return <div className="flex min-h-0 flex-1 flex-col">
    {loadError && <p role="alert" className="bg-critical-soft px-6 py-2 text-sm text-critical-ink">{loadError}. Reload before starting another investigation.</p>}
    <div className="flex min-h-0 flex-1">
      <ClaimList claims={visible} selectedId={selected?.id} onSelect={(id) => { setSelectedId(id); setTarget(null); markRead(id); }} search={search} onSearch={(s) => { setSearch(s); setPage(0); }} page={Math.min(page, Math.max(0, Math.ceil(visible.length / PAGE_SIZE) - 1))} onPage={(p) => { setPage(p); setSelectedId(visible[p * PAGE_SIZE]?.id); setTarget(null); }} />
      <main className="flex min-w-0 flex-1 flex-col bg-white">
        {selected ? <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-7 py-4"><div><p className="text-xs text-subtle">{selected.number} · {selected.persona.address.city}, {selected.persona.address.state}</p><h1 className="text-xl font-semibold">{selected.persona.name}</h1></div><p className="max-w-xs text-right text-xs text-subtle">{ready ? agentStatus(run).label : "Loading cases…"}</p></div>
          <nav aria-label="Case views" className="flex gap-5 border-b border-line px-7">{TABS.map(({ id, label }) => <button key={id} aria-current={tab === id ? "page" : undefined} onClick={() => setTab(id)} className={cn("flex cursor-pointer items-center gap-2 border-b-2 py-3 text-sm whitespace-nowrap", tab === id ? "border-brand font-semibold text-brand" : "border-transparent text-subtle")}>{label}{id === "policies" ? ` (${selected.persona.policies.length})` : ""}</button>)}</nav>
          <div className={cn("min-h-0 flex-1", tab === "messages" ? "overflow-hidden" : "thin-scroll overflow-y-auto")} key={`${selected.id}:${tab}`}>
            {tab === "overview" && <RunOverview claim={selected} onOpenDocument={openDocument} />}
            {tab === "situation" && <SituationView claim={selected} />}
            {tab === "messages" && <CaseMessages claim={selected} />}
            {tab === "timeline" && <div className="p-7"><h2 className="text-lg font-semibold">Investigation timeline</h2><p className="mb-5 mt-1 text-sm text-subtle">Live tool calls, retrieved evidence, verifier checks, reviewer actions, and delivery.</p>{run?.caseId ? <CaseTimeline caseId={run.caseId} onOpenDocument={openDocument} onRun={followRun} /> : <div className="rounded-xl border border-line bg-soft p-6 text-sm">{selected.silent ? "This household has not replied. Review the outreach in Messages and arrange a welfare follow-up." : "The timeline appears when this case is submitted to the agent."}</div>}</div>}
            {tab === "policies" && <CasePolicies claim={selected} onOpenDocument={openDocument} />}
          </div>
        </> : <p className="p-8 text-subtle">No cases match your search.</p>}
      </main>
    </div>
    {target && <PolicyOverlay target={target} onClose={() => setTarget(null)} />}
  </div>;
}
