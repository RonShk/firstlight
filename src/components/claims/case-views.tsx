"use client";

import { useEffect, useRef, useState } from "react";
import type { CaseView } from "@/types/agent";
import type { ClaimView } from "@/types/claims";
import { plainCaseText, findingTitle } from "@/lib/claims/presentation";
import { money } from "@/lib/sim/status";
import { DOCUMENT_FORMS, LINE_LABEL, UMBRELLA_OVERVIEW } from "@/lib/claims/policy-documents";
import { useClaims } from "./claims-provider";
import { PdfReader } from "./pdf-reader";

export function RunOverview({ claim, onOpenDocument }: { claim: ClaimView; onOpenDocument: (id: string, page: number | null) => void }) {
  const { runFor, queue, agent } = useClaims();
  const run = runFor(claim.id);
  const s = run?.result;
  const d = s?.decision?.decision;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const needsReview = s?.humanInterventionNeeded || d?.next_action === "human_review";
  const action = d?.immediate_danger ? "Urgent human follow-up needed" : needsReview ? "Claims specialist review needed" : run?.status === "running" || run?.status === "queued" ? "Review in progress" : run?.status === "error" ? "Human review needed" : d?.next_action === "ask_customer" ? "Ask the customer for more details" : d ? "Review complete" : "Waiting for review";
  const facts = d?.reported_facts.length ? d.reported_facts.slice(0, 3) : (d?.summary ?? claim.review.summary).split(/(?<=[.!?])\s+(?=[A-Z])/).slice(0, 2);
  const coverageStatus = { likely_covered: "May be covered", likely_excluded: "May be excluded", unclear: "Needs confirmation", no_policy: "No policy on file" };
  return <section className="mx-auto max-w-5xl space-y-8 p-7 lg:p-9">
    <div className={`rounded-xl border p-6 ${needsReview || d?.immediate_danger ? "border-high/30 bg-high-soft/50" : "border-line bg-soft/50"}`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-subtle">Next action</p>
      <h2 className="mt-2 text-3xl font-semibold leading-tight tracking-tight">{action}</h2>
      {needsReview && <p className="mt-2 text-sm text-ink-2">This case is in the claims team’s review queue.</p>}
      {run?.caseId && <button disabled={busy || run.status === "running" || !agent?.configured} onClick={async () => { setBusy(true); setError(null); try { await queue.rerun(claim.id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }} className="mt-4 cursor-pointer text-sm font-semibold text-brand disabled:opacity-40">{busy ? "Starting…" : "Run another review →"}</button>}
    </div>
    {error && <p role="alert" className="text-sm text-critical-ink">{error}</p>}
    <div><h3 className="text-2xl font-semibold">What happened</h3><ul className="mt-4 space-y-3">{facts.map((fact, i) => <li key={i} className="flex gap-3 text-base leading-relaxed"><span className="mt-2.5 size-1.5 shrink-0 rounded-full bg-brand" /><span>{plainCaseText(fact)}</span></li>)}</ul>{d && <details className="mt-4 text-sm text-subtle"><summary className="cursor-pointer">More case details</summary><p className="mt-3 leading-relaxed">{plainCaseText(d.summary)}</p></details>}</div>
    {d && <div className="space-y-4"><h3 className="text-2xl font-semibold">What the policy may cover</h3>{d.findings.map((f, i) => <article key={i} className="rounded-xl border border-line p-6"><div className="flex flex-wrap items-start justify-between gap-3"><h4 className="max-w-2xl text-xl font-semibold leading-snug">{findingTitle(f.item)}</h4><span className="rounded-full bg-soft px-3 py-1 text-xs font-medium">{coverageStatus[f.status]}</span></div><p className="mt-3 text-base leading-relaxed text-ink-2">{plainCaseText(f.explanation)}</p><div className="mt-4 flex flex-wrap gap-x-5 gap-y-2">{claim.review.citations.filter((c) => f.citations.some((x) => x.chunk_id === c.chunk_id || x.quote === c.quote)).map((c, j) => <button key={j} onClick={() => onOpenDocument(c.doc_id, c.page)} title={`${c.form_number} · ${c.section}`} className="cursor-pointer text-sm font-semibold text-brand underline decoration-brand/30 underline-offset-4">View policy{c.page ? ` · page ${c.page}` : ""} ↗</button>)}</div></article>)}</div>}
    {d && d.unknowns.length > 0 && <div><h3 className="text-xl font-semibold">What still needs checking</h3><ul className="mt-3 list-disc space-y-2 pl-5 text-base text-ink-2">{d.unknowns.map((u, i) => <li key={i}>{plainCaseText(u)}</li>)}</ul></div>}
  </section>;
}

export function CaseMessages({ claim }: { claim: ClaimView }) {
  const { runFor, threadFor, simulateMessage, agent } = useClaims();
  const run = runFor(claim.id);
  const [view, setView] = useState<CaseView | null>(null);
  const [draft, setDraft] = useState("");
  const [mode, setMode] = useState<"customer" | "note">("customer");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!run?.caseId) return;
    let disposed = false;
    const load = async () => { try { const r = await fetch(`/api/cases/${run.caseId}`); if (!r.ok) throw new Error("Could not load case messages"); const data = await r.json(); if (!disposed) { setView(data); setError(null); } } catch (e) { if (!disposed) setError((e as Error).message); } };
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => { disposed = true; clearInterval(timer); };
  }, [run?.caseId, version]);
  const messages = view ? view.messages.map((m) => ({ id: `server-${m.seq}`, text: m.text, when: new Date(m.at).toLocaleString(), from: m.role === "customer" ? "policyholder" : m.role === "reviewer" ? "note" : "state_farm" })) : threadFor(claim).map((m) => ({ ...m, when: `${m.minutesAgo} minutes ago` }));
  return <section className="mx-auto flex h-full min-h-0 w-full max-w-5xl flex-col"><div className="shrink-0 border-b border-line px-7 py-4"><h2 className="text-lg font-semibold">Messages</h2><p className="mt-1 text-sm text-subtle">Customer outreach, inbound messages, delivered agent replies, and internal reviewer notes.</p></div>
    <div aria-label="Conversation" className="thin-scroll min-h-0 flex-1 space-y-5 overflow-y-auto px-7 py-5">{messages.map((m) => <article key={m.id} className={m.from === "policyholder" ? "mr-12" : m.from === "note" ? "mx-6" : "ml-12"}><p className="mb-1 text-xs text-subtle">{m.from === "policyholder" ? claim.persona.name : m.from === "note" ? "Internal note" : "State Farm"} · {m.when}</p><p className={`rounded-xl border border-line p-4 text-sm leading-relaxed whitespace-pre-wrap ${m.from === "policyholder" ? "bg-soft" : "bg-critical-soft/30"}`}>{m.text}</p></article>)}{view?.events.filter((e) => e.type === "reviewer.note").map((e) => <article key={`note-${e.id}`} className="mx-6 rounded-lg bg-soft p-4 text-sm"><p className="mb-1 text-xs text-subtle">Internal note</p>{String((e.detail as { note: string }).note)}</article>)}</div>
    <div data-testid="message-composer" className="shrink-0 border-t border-line bg-white px-7 py-4"><div className="mb-3 flex gap-4 text-sm"><button onClick={() => setMode("customer")} className={mode === "customer" ? "font-semibold text-brand" : "text-subtle"}>Customer message</button><button onClick={() => setMode("note")} className={mode === "note" ? "font-semibold text-brand" : "text-subtle"}>Reviewer note</button></div><label className="text-xs text-subtle" htmlFor="case-message">{mode === "customer" ? "Add an incoming customer message to this case." : "Saved to the case audit history. Internal notes are not sent to the customer."}</label><textarea id="case-message" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={mode === "customer" ? 4000 : 1000} rows={2} className="mt-2 max-h-32 w-full resize-none overflow-y-auto rounded-lg border border-line p-3 text-sm" placeholder={mode === "customer" ? "Tell the agent what happened next…" : "Add a note for the claims team…"} /><div className="mt-3 flex justify-end"><button disabled={busy || !draft.trim() || (mode === "customer" ? !agent?.configured : !run?.caseId)} onClick={async () => { setBusy(true); setError(null); try { if (mode === "customer") await simulateMessage(claim, draft.trim()); else { const r = await fetch(`/api/cases/${run!.caseId}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "note", note: draft.trim() }) }); if (!r.ok) throw new Error("Could not save reviewer note"); } setDraft(""); setVersion((v) => v + 1); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }} className="cursor-pointer rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? "Saving…" : mode === "customer" ? "Add customer message" : "Save note"}</button></div>{error && <p role="alert" className="mt-2 text-sm text-critical-ink">{error}</p>}</div>
  </section>;
}

export function CasePolicies({ claim, target }: { claim: ClaimView; target: { docId: string; page: number | null } | null }) {
  const policies = claim.persona.policies;
  const [selected, setSelected] = useState<string | null>(target?.docId ?? null);
  const active = target?.docId === selected ? target : null;
  const form = selected ? DOCUMENT_FORMS[selected] : null;
  const documentView = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selected) documentView.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [selected]);
  return <section className="space-y-5 p-7"><div><h2 className="text-lg font-semibold">Policies & documents</h2><p className="mt-1 text-sm text-subtle">All policies held by this household, their declarations, and the exact forms used by retrieval.</p></div><div className="grid gap-4 2xl:grid-cols-2">{policies.map((p) => <article key={p.id} className="rounded-xl border border-line p-5"><div className="flex justify-between gap-2"><h3 className="font-semibold">{LINE_LABEL[p.line]} policy</h3><span className="text-xs text-subtle">{p.id}</span></div><p className="mt-1 text-xs text-subtle">{DOCUMENT_FORMS[p.formId]?.name} · {DOCUMENT_FORMS[p.formId]?.formNumber}</p><dl className="mt-4 space-y-2 text-sm">{Object.entries(p.home ? { Dwelling: p.home.dwelling, "Personal property": p.home.personalProperty, "Loss of use": p.home.lossOfUse, Deductible: p.home.deductible, "Wind / hail deductible": p.home.windHailDeductible } : p.auto ? { "Comprehensive deductible": p.auto.comprehensiveDeductible, "Collision deductible": p.auto.collisionDeductible } : { "Umbrella liability limit": p.umbrellaLimit ?? 0 }).map(([key, n]) => <div key={key} className="flex justify-between gap-3"><dt className="text-subtle">{key}</dt><dd>{money(n)}</dd></div>)}{p.auto && <><div className="flex justify-between"><dt className="text-subtle">Liability</dt><dd>{p.auto.liability}</dd></div>{p.auto.vehicles.map((v, i) => <p key={`${p.id}:vehicle:${i}`} className="text-xs">{v.year} {v.make} {v.model} · {money(v.value)}</p>)}</>}</dl><button onClick={() => setSelected(p.formId)} className="mt-4 cursor-pointer text-sm font-semibold text-brand">Read policy document →</button></article>)}</div>
    {form && <div ref={documentView}><div className="mb-3 flex justify-between"><h3 className="font-semibold">{form.name} · {form.formNumber}</h3><button onClick={() => setSelected(null)} className="text-sm text-subtle">Close document</button></div>{form.hasPdf ? <PdfReader key={`${selected}:${active?.page ?? 1}`} docId={form.id} initialPage={active?.page ?? 1} /> : <article className="space-y-3 rounded-xl border border-line p-5 text-sm"><p>{UMBRELLA_OVERVIEW.intro}</p>{UMBRELLA_OVERVIEW.provides.map((p) => <p key={p}>{p}</p>)}<p className="text-xs text-subtle">{UMBRELLA_OVERVIEW.disclosure}</p></article>}</div>}
    {!policies.length && <p className="rounded-xl bg-soft p-5 text-sm">No policies on file. Coverage requires a claims specialist to review.</p>}
  </section>;
}
