"use client";

import { useCallback, useEffect, useState } from "react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CaseEvent, CaseView } from "@/types/agent";

const ACTOR_STYLE: Record<string, string> = {
  customer: "bg-white/10 text-slate-200",
  agent: "bg-cyan-500/15 text-cyan-300",
  tool: "bg-indigo-500/15 text-indigo-300",
  verifier: "bg-fuchsia-500/15 text-fuchsia-300",
  guard: "bg-emerald-500/15 text-emerald-300",
  reviewer: "bg-amber-500/15 text-amber-300",
  delivery: "bg-sky-500/15 text-sky-300",
  system: "bg-slate-500/15 text-slate-300",
};

const FAILURE = /failed|rejected|cancelled|held|unavailable|flagged|stopped|superseded/;
const TERMINAL = new Set(["completed", "failed", "superseded"]);

interface Passage { chunk_id: string; form?: string; section: string; page: number | null; text: string; score?: number }

export function openDocument(onOpen: (docId: string, page: number | null) => void, chunkId: string, page: number | null) {
  onOpen(chunkId.slice(0, chunkId.lastIndexOf("#")), page);
}

function Passages({ passages, onOpen }: { passages: Passage[]; onOpen: (docId: string, page: number | null) => void }) {
  return <ul className="mt-2 space-y-2">
    {passages.map((p) => <li key={p.chunk_id} className="rounded-lg border border-white/10 bg-black/20 p-3 text-xs">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-slate-300">{p.section}</span>
        <button className="cursor-pointer text-cyan-300 hover:underline" onClick={() => openDocument(onOpen, p.chunk_id, p.page)}>{p.form ?? p.chunk_id}{p.page ? ` · p.${p.page}` : ""} ↗</button>
        {p.score !== undefined && <span>score {p.score}</span>}
      </div>
      <p className="leading-relaxed text-slate-300">{p.text}</p>
    </li>)}
  </ul>;
}

function EventDetail({ event, onOpen }: { event: CaseEvent; onOpen: (docId: string, page: number | null) => void }) {
  const [full, setFull] = useState<unknown>(null);
  const detail = event.detail as Record<string, unknown>;
  const output = (full ?? detail?.output) as { results?: Passage[]; passages?: Passage[] } | undefined;
  const passages = output?.results ?? output?.passages;
  const purpose = typeof detail?.purpose === "string" ? detail.purpose : null;
  return <div className="mt-2 space-y-2 pl-1">
    {purpose && <p className="text-xs text-slate-300"><span className="text-muted-foreground">Purpose: </span>{purpose}</p>}
    {typeof detail?.text === "string" && <p className="whitespace-pre-wrap text-xs text-slate-300">{detail.text}</p>}
    {typeof detail?.explanation === "string" && <p className="text-xs text-slate-300">{detail.explanation}</p>}
    {typeof detail?.error === "string" && <p className="break-words font-mono text-[11px] text-rose-200">{detail.error}</p>}
    {Array.isArray(detail?.issues) && <ul className="list-disc space-y-1 pl-5 text-xs text-amber-200">{(detail.issues as string[]).map((i) => <li key={i}>{i}</li>)}</ul>}
    {passages && <Passages passages={passages} onOpen={onOpen} />}
    {event.artifactId && !full && <button className="cursor-pointer text-xs text-cyan-300 hover:underline" onClick={async () => {
      const res = await fetch(`/api/artifacts/${event.artifactId}`);
      if (res.ok) setFull((await res.json()).body);
    }}>Load full tool output</button>}
    <details className="text-[11px] text-muted-foreground"><summary className="cursor-pointer">Raw event</summary>
      <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-black/30 p-3">{JSON.stringify(full ? { ...detail, output: full } : detail, null, 2)}</pre>
    </details>
  </div>;
}

function Row({ event, handoff = false, onOpen }: { event: CaseEvent; handoff?: boolean; onOpen: (docId: string, page: number | null) => void }) {
  const [open, setOpen] = useState(false);
  return <li className="border-b border-white/5 py-2.5">
    <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full cursor-pointer items-start gap-3 text-left">
      <ChevronRight className={cn("mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
      <time className="w-16 shrink-0 font-mono text-[11px] text-muted-foreground">{new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>
      <span className={cn("shrink-0 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider", ACTOR_STYLE[event.actor] ?? ACTOR_STYLE.system)}>{event.actor}</span>
      <span className={cn("min-w-0 flex-1 text-sm", FAILURE.test(event.type) ? "text-amber-200" : "text-slate-200")}>{handoff ? "Human intervention needed · queued for claims review" : event.title}</span>
      {event.ms != null && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{event.ms} ms</span>}
    </button>
    {open && <div className="ml-[6.5rem]"><EventDetail event={event} onOpen={onOpen} /></div>}
  </li>;
}

function ReviewPanel({ view, reload }: { view: CaseView; reload: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [finding, setFinding] = useState(0);
  const [status, setStatus] = useState("unclear");
  const latest = [...view.runs].reverse().find((r) => r.decision);
  const findings = latest?.decision?.decision.findings ?? [];
  const held = [...view.runs].reverse().find((r) => r.reply?.status === "held")?.reply;
  const act = async (body: object, done: string) => {
    setBusy(true); setMessage(null);
    const res = await fetch(`/api/cases/${view.case.id}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    setBusy(false);
    setMessage(res.ok ? done : data.error ?? `HTTP ${res.status}`);
    if (res.ok) { setNote(""); reload(); }
  };
  return <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.04] p-4">
    <h3 className="text-xs font-medium tracking-wider text-amber-200 uppercase">Reviewer actions</h3>
    <p className="mt-1 text-xs text-muted-foreground">Each action is recorded as a new event. Nothing in the history is overwritten.</p>
    <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder="Note or instruction for the agent, e.g. 'Check whether the detached garage is covered'"
      className="mt-3 w-full rounded-lg border border-white/10 bg-black/30 p-2 text-sm outline-none focus-visible:border-cyan-400" />
    <div className="mt-2 flex flex-wrap gap-2">
      <button disabled={busy || note.trim().length < 3} onClick={() => act({ action: "request_investigation", note }, "New agent run queued.")}
        className="cursor-pointer rounded-lg bg-cyan-500/20 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/30 disabled:cursor-not-allowed disabled:opacity-40">Request further investigation</button>
      <button disabled={busy || !note.trim()} onClick={() => act({ action: "note", note }, "Note recorded.")}
        className="cursor-pointer rounded-lg bg-white/10 px-3 py-1.5 text-xs hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40">Add note</button>
      {held && <button disabled={busy} onClick={() => act({ action: "approve_reply", outbox_id: held.id }, "Held reply released for delivery.")}
        className="cursor-pointer rounded-lg bg-emerald-500/20 px-3 py-1.5 text-xs text-emerald-200 hover:bg-emerald-500/30">Approve held reply</button>}
    </div>
    {latest && findings.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Correct finding</span>
      <select value={finding} onChange={(e) => setFinding(Number(e.target.value))} className="rounded border border-white/10 bg-black/40 px-2 py-1">
        {findings.map((f, i) => <option key={i} value={i}>{i + 1}. {f.item.slice(0, 40)}</option>)}
      </select>
      <select value={status} onChange={(e) => setStatus(e.target.value)} className="rounded border border-white/10 bg-black/40 px-2 py-1">
        {["likely_covered", "likely_excluded", "unclear", "no_policy"].map((s) => <option key={s} value={s}>{s.replace("_", " ")}</option>)}
      </select>
      <button disabled={busy || note.trim().length < 3} onClick={() => act({ action: "correct_finding", run_id: latest.id, finding_index: finding, status, note }, "Correction recorded.")}
        className="cursor-pointer rounded-lg bg-white/10 px-3 py-1.5 hover:bg-white/15 disabled:cursor-not-allowed disabled:opacity-40">Record correction (uses note)</button>
    </div>}
    {message && <p className="mt-2 text-xs text-slate-300" role="status">{message}</p>}
  </div>;
}

/** One ordered audit timeline for a case, live-streamed while a run is in progress. */
export function CaseTimeline({ caseId, onOpenDocument }: { caseId: string; onOpenDocument: (docId: string, page: number | null) => void }) {
  const [view, setView] = useState<CaseView | null>(null);
  const [events, setEvents] = useState<CaseEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [version, setVersion] = useState(0);
  const load = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/cases/${caseId}`)
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) { setError(`Could not load case (${res.status})`); return; }
        const data = (await res.json()) as CaseView;
        if (cancelled) return;
        setView(data);
        setEvents(data.events);
      })
      .catch((e: Error) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [caseId, version]);

  const active = view?.runs.findLast((r) => !TERMINAL.has(r.status) || (r.status === "completed" && r.reply?.status === "pending"));
  const lastSeq = events.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (!active) return;
    const source = new EventSource(`/api/runs/${active.id}/events?after=${lastSeq}`);
    source.onmessage = (m) => {
      const e = JSON.parse(m.data) as CaseEvent;
      setEvents((prev) => (prev.some((p) => p.seq === e.seq) ? prev : [...prev, e].sort((a, b) => a.seq - b.seq)));
    };
    source.addEventListener("end", () => { source.close(); load(); });
    return () => source.close();
    // Reconnect only when the active run changes; lastSeq is the resume point at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active?.id, load]);

  // Queued runs emit no events, so refresh the status line (queue position, ETA) on a timer too.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, [active, load]);

  if (error) return <p className="text-sm text-rose-300">{error}</p>;
  if (!view) return <p className="text-sm text-muted-foreground">Loading timeline…</p>;
  return <div className="space-y-5">
    <ReviewPanel view={view} reload={load} />
    {active && <p className="flex items-center gap-2 text-xs text-cyan-300"><span className="size-1.5 animate-pulse rounded-full bg-cyan-400" />{active.progress.label} · streaming live</p>}
    <ol>{events.map((e) => <Row key={e.seq} event={e} handoff={e.type === "run.failed" && view.runs.some((r) => r.id === e.runId && r.humanInterventionNeeded)} onOpen={onOpenDocument} />)}</ol>
  </div>;
}
