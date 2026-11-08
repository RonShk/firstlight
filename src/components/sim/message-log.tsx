"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronRight, ShieldCheck, Siren, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { FORMS_BY_ID } from "@/lib/sim/data";
import { HOUSEHOLD_LABELS } from "@/lib/sim/personas";
import { STATUS_META, clockLabel, money } from "@/lib/sim/status";
import { TORNADO } from "@/lib/sim/scenarios";
import { decisionOf, type TriageEntry } from "@/lib/sim/triage";
import type { StoredDecision } from "@/types/agent";
import { CaseTimeline } from "./case-timeline";
import { useSim } from "./sim-provider";

function currentRun(entry: TriageEntry) {
  return entry.run?.key === entry.conversationKey ? entry.run : undefined;
}

const NEXT_ACTION = { reply: "Reply sent", ask_customer: "Asked the customer for details", human_review: "Handed to the claims team" } as const;

function action(entry: TriageEntry, configured: boolean) {
  const run = currentRun(entry);
  if (entry.status === "silent") return "Escalated for welfare check";
  const d = decisionOf(run);
  if (run?.status === "done" && d) {
    const reply = run.result?.reply?.status;
    if (reply === "held") return `${NEXT_ACTION[d.next_action]} · reply held for approval`;
    if (reply === "cancelled") return "Reply cancelled · newer message arrived";
    return NEXT_ACTION[d.next_action];
  }
  if (run?.result?.humanInterventionNeeded) return `Human intervention needed · queued for claims review${run.result.reply?.status === "sent" ? " · acknowledgement sent" : ""}`;
  if (run?.status === "error") return `Agent failed: ${run.result?.failure?.summary ?? run.error ?? "unknown error"}${run.result?.reply ? " · fallback reply sent" : ""} · open to re-run`;
  if (!configured) return "Agent not configured";
  if (run?.status === "running") {
    const p = run.result?.progress;
    if (!p) return "Submitting to the agent queue…";
    return p.phase === "queued" ? p.label : `${p.label} · ${run.result?.activity ?? ""}`;
  }
  if (run?.status === "queued") return "Submitting to the agent queue…";
  return "Waiting for a reply";
}

function Severity({ entry }: { entry: TriageEntry }) {
  const meta = STATUS_META[entry.status];
  const d = decisionOf(currentRun(entry));
  return <span className={cn("inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-xs ring-1", meta.chip)}>
    <span className={cn("size-1.5 rounded-full", meta.dot)} />
    {d ? `${d.severity} · ` : ""}{meta.label}
  </span>;
}

const STATUS_CHIP: Record<string, string> = {
  likely_covered: "bg-emerald-500/15 text-emerald-300",
  likely_excluded: "bg-rose-500/15 text-rose-300",
  unclear: "bg-amber-500/15 text-amber-300",
  no_policy: "bg-slate-500/20 text-slate-300",
};

type Cite = { finding: number; chunk_id: string; doc_id: string; form_number: string; section: string; page: number | null; quote: string };

function Assessment({ stored, onOpen }: { stored: StoredDecision; onOpen: (docId: string, page: number | null) => void }) {
  const d = stored.decision;
  const cites = stored.citations as Cite[];
  return <div className="space-y-5">
    {d.immediate_danger && <div className="flex items-start gap-3 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-100"><Siren className="mt-0.5 size-4 shrink-0" />Present danger reported. The customer was told to call 911 and an urgent review was queued.</div>}
    <div>
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Summary</h3>
      <p className="mt-2 text-sm leading-relaxed">{d.summary}</p>
      <p className="mt-2 text-xs text-muted-foreground">Severity {d.severity}: {d.severity_reason}</p>
    </div>
    <div>
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Decision</h3>
      <p className="mt-2 text-sm"><span className="font-medium">{NEXT_ACTION[d.next_action]}.</span> <span className="text-muted-foreground">{d.decision_reason}</span></p>
      <p className={cn("mt-2 inline-flex items-center gap-1.5 text-xs", stored.verified ? "text-emerald-300" : "text-amber-300")}><ShieldCheck className="size-3.5" />{stored.verified ? "Citations verified in code and approved by the verifier agent" : "Not approved by the verifier agent; see the timeline"}</p>
    </div>
    {d.findings.length > 0 && <div>
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Coverage findings</h3>
      <ul className="mt-2 space-y-3">{d.findings.map((f, i) => <li key={i} className="rounded-xl border border-white/10 p-4">
        <div className="flex flex-wrap items-center gap-2"><span className="text-sm font-medium">{f.item}</span><span className={cn("rounded px-1.5 py-0.5 text-[11px]", STATUS_CHIP[f.status])}>{f.status.replace("_", " ")}</span><span className="text-xs text-muted-foreground">{f.coverage}{f.policy_id ? ` · ${f.policy_id}` : ""}</span></div>
        <p className="mt-2 text-sm leading-relaxed text-slate-300">{f.explanation}</p>
        {cites.filter((c) => c.finding === i).map((c, j) => <blockquote key={j} className="mt-3 border-l-2 border-cyan-500/40 pl-3 text-xs leading-relaxed text-slate-300">
          “{c.quote}”
          <button className="mt-1 block cursor-pointer text-cyan-300 hover:underline" onClick={() => onOpen(c.doc_id, c.page)}>{c.form_number} · {c.section}{c.page ? ` · page ${c.page}` : ""} ↗</button>
        </blockquote>)}
      </li>)}</ul>
    </div>}
    {d.unknowns.length > 0 && <div>
      <h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">Still unknown</h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-slate-300">{d.unknowns.map((u) => <li key={u}>{u}</li>)}</ul>
    </div>}
  </div>;
}

const tabs = ["Overview", "Timeline", "Messages", "Policies"] as const;
function RerunButton({ personaId, label = "Re-run agent" }: { personaId: string; label?: string }) {
  const { queue } = useSim();
  const [state, setState] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  return <span className="inline-flex flex-col gap-1">
    <button disabled={state.busy} onClick={async () => {
      setState({ busy: true, error: null });
      try { await queue.rerun(personaId); setState({ busy: false, error: null }); } catch (e) { setState({ busy: false, error: (e as Error).message }); }
    }} className="cursor-pointer rounded-lg bg-cyan-500/20 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/30 disabled:cursor-wait disabled:opacity-50">{state.busy ? "Starting…" : label}</button>
    {state.error && <span className="text-xs text-rose-300" role="alert">{state.error}</span>}
  </span>;
}

function FailurePanel({ entry }: { entry: TriageEntry }) {
  const run = currentRun(entry);
  const failure = run?.result?.failure;
  if (run?.status !== "error") return null;
  const handoff = run.result?.humanInterventionNeeded;
  return <div className={cn("rounded-xl border p-4", handoff ? "border-amber-500/30 bg-amber-500/[0.06]" : "border-rose-500/30 bg-rose-500/[0.06]")}>
    <h3 className={cn("text-sm font-medium", handoff ? "text-amber-200" : "text-rose-200")}>{handoff ? "Human intervention needed" : `Agent failed: ${failure?.summary ?? run.error ?? "unknown error"}`}</h3>
    {handoff ? <p className="mt-2 text-sm leading-relaxed text-slate-300">The agent reached its investigation limit before it could verify a final answer. This case is queued for a claims specialist to review.</p> : failure && <p className="mt-2 text-sm leading-relaxed text-slate-300">{failure.explanation}</p>}
    {run.result?.reply?.status === "sent" && <p className="mt-2 text-xs text-muted-foreground">An acknowledgement was delivered to the customer.</p>}
    <div className="mt-3"><RerunButton personaId={entry.persona.id} /></div>
    {(failure?.raw ?? run.error) && <details className="mt-3 text-[11px] text-muted-foreground"><summary className="cursor-pointer">{handoff ? "Investigation details" : "Technical error"}</summary>
      <pre className="mt-1 whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3">{failure?.raw ?? run.error}</pre></details>}
  </div>;
}

function Details({ entry, configured, onClose }: { entry: TriageEntry; configured: boolean; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<(typeof tabs)[number]>("Overview");
  const [doc, setDoc] = useState<{ id: string; page: number | null } | null>(null);
  const p = entry.persona;
  const person = p.members.find((m) => m.relation === "self");
  const run = currentRun(entry);
  const summary = run?.result;
  const caseId = run?.caseId ?? entry.run?.caseId;
  const openDocument = (id: string, page: number | null) => { setDoc({ id, page }); setTab("Policies"); };
  const docUrl = doc ? `/api/policies?form=${encodeURIComponent(doc.id)}${doc.page ? `#page=${doc.page}` : ""}` : "";
  useEffect(() => {
    const element = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    return () => { element.close(); document.body.style.overflow = overflow; previous?.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="person-title" onCancel={(event) => { if (doc && tab === "Policies") { event.preventDefault(); setDoc(null); } else onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    className={cn("fixed inset-y-0 right-0 left-auto m-0 h-dvh max-h-none w-full border-l border-white/10 bg-background p-0 text-foreground shadow-2xl backdrop:bg-black/60 backdrop:backdrop-blur-sm", doc && tab === "Policies" ? "max-w-none" : "max-w-2xl")}>
    <div className="flex h-full flex-col">
      <header className="border-b border-white/10 p-6">
        <div className="mb-4 flex items-center justify-between"><span className="text-xs tracking-widest text-muted-foreground uppercase">Policyholder · {p.id}{caseId ? ` · ${caseId}` : ""}</span><button autoFocus onClick={onClose} aria-label="Close policyholder details" className="cursor-pointer rounded-lg p-2 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-cyan-400"><X className="size-5" /></button></div>
        <h2 id="person-title" className="text-2xl font-semibold tracking-tight">{p.name}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{person ? `${person.age} years old · ` : ""}{p.occupation}</p>
        <p className="mt-2 text-xs text-muted-foreground">{HOUSEHOLD_LABELS[p.householdType]} · {p.address.city}, {p.address.state}</p>
      </header>
      <div role="tablist" aria-label="Policyholder details" className="flex gap-1 border-b border-white/10 px-6 pt-2">
        {tabs.map((name, index) => <button key={name} role="tab" id={`tab-${name}`} aria-controls={`panel-${name}`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1}
          onKeyDown={(event) => {
            if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length;
            setTab(tabs[next]); document.getElementById(`tab-${tabs[next]}`)?.focus();
          }} onClick={() => setTab(name)} className={cn("cursor-pointer border-b-2 px-4 py-3 text-sm transition-colors", tab === name ? "border-cyan-400 text-cyan-300" : "border-transparent text-muted-foreground hover:text-foreground")}>{name}{name === "Messages" ? ` (${entry.thread.length})` : name === "Policies" ? ` (${p.policies.length})` : ""}</button>)}
      </div>
      <section role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0} className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        {tab === "Overview" && <>
          <div className="rounded-xl border border-white/10 bg-white/[0.025] p-4"><Severity entry={entry} /><p className="mt-4 text-sm font-medium">{action(entry, configured)}</p>
            {!summary?.decision && <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{entry.priorityReason}</p>}

            {summary?.usage && <p className="mt-3 text-[11px] text-muted-foreground">{summary.usage.turns} model turns · {summary.usage.toolCalls} tool calls · {summary.usage.revisions} revisions · {(summary.usage.promptTokens + summary.usage.completionTokens).toLocaleString()} tokens · {summary.model}</p>}
          </div>
          <FailurePanel entry={entry} />
          {run?.status === "done" && <div className="flex items-center gap-3 text-xs text-muted-foreground"><RerunButton personaId={p.id} label="Run the agent again" /><span>Starts a fresh run on this conversation; this one stays in the history.</span></div>}
          {summary?.decision && <Assessment stored={summary.decision} onOpen={openDocument} />}
          {summary?.reply && <div><h3 className="text-xs font-medium tracking-wider text-muted-foreground uppercase">{summary.reply.kind === "fallback" ? "Fallback reply (agent did not finish)" : "Agent reply"} · {summary.reply.status === "sent" ? "shown on the simulated phone, no real SMS" : summary.reply.status}</h3><p className="mt-2 whitespace-pre-wrap rounded-xl border border-cyan-500/15 bg-cyan-500/5 p-4 text-sm leading-relaxed">{summary.reply.body}</p></div>}
        </>}
        {tab === "Timeline" && (caseId ? <><FailurePanel entry={entry} /><CaseTimeline key={run?.runId ?? caseId} caseId={caseId} onOpenDocument={openDocument} /></> : <p className="text-sm text-muted-foreground">No agent activity yet for this household.</p>)}
        {tab === "Messages" && <><p className="text-xs text-muted-foreground">Simulated phone. Agent replies appear once the delivery worker has delivered them.</p>{entry.thread.length === 0 && <p className="text-sm text-muted-foreground">No messages yet.</p>}{entry.thread.map((message, index) => <div key={index} className={cn("max-w-[92%] rounded-2xl border p-4", message.from === "persona" ? "border-white/10 bg-white/5" : "ml-auto border-cyan-500/15 bg-cyan-500/5")}><div className="mb-2 flex justify-between gap-3 text-[11px] text-muted-foreground"><span>{message.from === "persona" ? p.name : message.from === "agent" ? "Nemotron agent · delivered" : "State Farm · check-in"}</span><time>{clockLabel(TORNADO.touchdown, message.at)}</time></div><p className="whitespace-pre-wrap text-sm leading-relaxed">{message.from === "persona" ? message.text : message.text.replace(/^State Farm:\s*/i, "")}</p></div>)}<p className="text-xs text-muted-foreground">{action(entry, configured)}</p></>}
        {tab === "Policies" && doc && <div className="fixed inset-0 z-50 flex h-dvh w-screen flex-col gap-3 bg-background p-5"><div className="flex items-center justify-between gap-3"><button className="cursor-pointer text-sm text-cyan-300 hover:underline" onClick={() => setDoc(null)}>← All policies</button><span className="text-xs text-muted-foreground">{FORMS_BY_ID[doc.id]?.name ?? doc.id}{doc.page ? ` · page ${doc.page}` : ""}</span><a className="text-xs text-cyan-300 hover:underline" href={docUrl} target="_blank" rel="noreferrer">Open PDF in new tab ↗</a></div><iframe key={docUrl} title={`${FORMS_BY_ID[doc.id]?.name ?? doc.id} policy PDF`} src={docUrl} className="min-h-0 w-full flex-1 rounded-lg border border-white/10 bg-white" /></div>}
        {tab === "Policies" && !doc && <>{p.policies.length === 0 && <p className="text-sm text-muted-foreground">No policies on file.</p>}{p.policies.map((policy) => <article key={policy.id} className="rounded-xl border border-white/10 p-4"><p className="text-xs tracking-wider text-cyan-300 uppercase">{policy.line}</p><h3 className="mt-2 text-sm font-semibold">{policy.formId === "SF-UMB-WEB" ? <a href={FORMS_BY_ID[policy.formId].url} target="_blank" rel="noreferrer" className="text-cyan-300 hover:underline">{FORMS_BY_ID[policy.formId].name} ↗</a> : <button className="cursor-pointer text-left text-cyan-300 hover:underline" onClick={() => setDoc({ id: policy.formId, page: null })}>{FORMS_BY_ID[policy.formId]?.name ?? policy.formId} · View PDF ↗</button>}</h3>{policy.formId === "SF-UMB-WEB" && <p className="mt-2 text-xs text-muted-foreground">This form has an online overview; no policy PDF is on file.</p>}<p className="mt-1 text-xs text-muted-foreground">{policy.id} · {FORMS_BY_ID[policy.formId]?.formNumber}</p><dl className="mt-4 space-y-3 text-sm">{(policy.home ? [["Dwelling", policy.home.dwelling], ["Personal property", policy.home.personalProperty], ["Loss of use", policy.home.lossOfUse], ["Deductible", policy.home.deductible], ["Wind / hail deductible", policy.home.windHailDeductible]] : policy.auto ? [["Comprehensive deductible", policy.auto.comprehensiveDeductible], ["Collision deductible", policy.auto.collisionDeductible]] : [["Umbrella limit", policy.umbrellaLimit ?? 0]]).map(([label, value]) => <div key={label} className="flex justify-between gap-3"><dt className="text-muted-foreground">{label}</dt><dd>{money(Number(value))}</dd></div>)}</dl>{policy.auto && <div className="mt-4 border-t border-white/10 pt-3 text-sm"><p className="text-muted-foreground">Liability · {policy.auto.liability}</p>{policy.auto.vehicles.map((v, i) => <p key={i} className="mt-2">{v.year} {v.make} {v.model}</p>)}</div>}</article>)}</>}
      </section>
    </div>
  </dialog>;
}

export function MessageLog() {
  const { entries, agent } = useSim();
  const [selected, setSelected] = useState<string | null>(null);
  const rows = entries.filter((e) => e.thread.some((m) => m.from === "persona") || e.status === "silent").sort((a, b) => b.priority - a.priority);
  const selectedEntry = entries.find((e) => e.persona.id === selected);
  const completed = rows.filter((e) => currentRun(e)?.status === "done").length;
  const inFlight = rows.map((e) => currentRun(e)?.result?.progress).filter(Boolean);
  const running = inFlight.filter((p) => p!.phase !== "queued").length;
  const waiting = inFlight.filter((p) => p!.phase === "queued").length;
  return <div className="mx-auto w-full max-w-7xl p-5">
    <div className="mb-6"><h1 className="text-xl font-semibold tracking-tight">Policyholder activity</h1><p className="mt-1 text-sm text-muted-foreground">{rows.length} households · {completed} assessed{running ? ` · ${running} running` : ""}{waiting ? ` · ${waiting} waiting in queue` : ""}{agent?.queue?.drainSeconds ? ` · all done in ~${Math.max(1, Math.round(agent.queue.drainSeconds / 60))} min` : ""} · Select a household to view its evidence and audit timeline</p></div>
    <div className="panel overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><thead className="border-b border-white/10 text-xs text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Policyholder</th><th className="px-5 py-3 font-medium">Severity</th><th className="px-5 py-3 font-medium">Latest action</th><th className="w-10"><span className="sr-only">Open details</span></th></tr></thead><tbody>{rows.map((entry) => <tr key={entry.persona.id} onClick={() => setSelected(entry.persona.id)} className="cursor-pointer border-b border-white/5 transition-colors hover:bg-white/[0.04] focus-within:bg-white/[0.04]"><td className="px-5 py-4"><button onClick={() => setSelected(entry.persona.id)} aria-haspopup="dialog" className="cursor-pointer text-left font-medium focus-visible:outline-2 focus-visible:outline-cyan-400">{entry.persona.name}</button><p className="mt-1 text-xs text-muted-foreground">{entry.persona.members.find((m) => m.relation === "self")?.age} · {HOUSEHOLD_LABELS[entry.persona.householdType]} · {entry.persona.address.city}</p></td><td className="px-5 py-4"><Severity entry={entry} /></td><td className={cn("max-w-md truncate px-5 py-4 text-xs", currentRun(entry)?.result?.humanInterventionNeeded ? "text-amber-300" : currentRun(entry)?.status === "error" ? "text-rose-300" : currentRun(entry)?.status === "running" ? "text-cyan-300" : "text-muted-foreground")}>{action(entry, !!agent?.configured)}</td><td className="pr-4 text-muted-foreground"><ChevronRight className="size-4" /></td></tr>)}</tbody></table>{!rows.length && <p className="p-8 text-center text-sm text-muted-foreground">No household activity yet.</p>}</div>
    {selectedEntry && <Details key={selectedEntry.persona.id} entry={selectedEntry} configured={!!agent?.configured} onClose={() => setSelected(null)} />}
  </div>;
}
