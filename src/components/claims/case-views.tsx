"use client";

import { useEffect, useRef, useState } from "react";
import type { CaseView } from "@/types/agent";
import type { ClaimView } from "@/types/claims";
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
  return <section className="space-y-5 border-b border-line bg-soft/50 p-7">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold">Agent investigation</h2><p className="mt-1 text-sm text-subtle">{s?.humanInterventionNeeded || d?.next_action === "human_review" ? "Human intervention needed · queued for claims review" : s?.progress.label ?? run?.error ?? (claim.silent ? "No response · welfare follow-up needed" : "Waiting for the agent")}</p></div>{run?.caseId && <button disabled={busy || run.status === "running" || !agent?.configured} onClick={async () => { setBusy(true); setError(null); try { await queue.rerun(claim.id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }} className="cursor-pointer rounded-lg border border-line bg-white px-3 py-2 text-xs font-semibold disabled:opacity-40">{busy ? "Starting…" : "Investigate again"}</button>}</div>
    {error && <p role="alert" className="text-sm text-critical-ink">{error}</p>}
    {s?.activity && run?.status === "running" && <p className="text-sm text-brand">{s.activity}</p>}
    {s?.usage && <p className="text-xs text-subtle">{s.usage.turns} model turns · {s.usage.toolCalls} tool calls · {s.usage.revisions} revisions · {(s.usage.promptTokens + s.usage.completionTokens).toLocaleString()} tokens</p>}
    {d && <><p className="text-sm">{d.decision_reason}</p><p className="text-xs text-subtle">{s?.decision?.verified ? "Verified against retrieved evidence and approved by the verifier" : "Not approved by the verifier · review the timeline"}</p>
      {d.findings.map((f, i) => <article key={i} className="rounded-xl border border-line bg-white p-4"><div className="flex flex-wrap justify-between gap-2"><h3 className="font-semibold">{f.item}</h3><span className="rounded-full bg-soft px-2 py-1 text-xs">{f.status.replaceAll("_", " ")}</span></div><p className="mt-1 text-xs text-subtle">{f.coverage} · {f.policy_id ?? "No policy identified"}</p><p className="mt-2 text-sm leading-relaxed">{f.explanation}</p>{claim.review.citations.filter((c) => f.citations.some((x) => x.chunk_id === c.chunk_id || x.quote === c.quote)).map((c, j) => <blockquote key={j} className="mt-3 border-l-2 border-brand/40 pl-3 text-sm"><p>“{c.quote}”</p><button onClick={() => onOpenDocument(c.doc_id, c.page)} className="mt-1 cursor-pointer text-xs font-semibold text-brand">{c.form_number} · {c.section}{c.page ? ` · page ${c.page}` : ""} ↗</button></blockquote>)}</article>)}
      {d.unknowns.length > 0 && <div><h3 className="text-sm font-semibold">Still unknown</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-subtle">{d.unknowns.map((u) => <li key={u}>{u}</li>)}</ul></div>}
    </>}
    {s?.reply && <div className="rounded-lg border border-line bg-white p-4"><h3 className="text-xs font-semibold text-subtle">Customer acknowledgement · {s.reply.status === "sent" ? "delivered to simulated phone" : s.reply.status}</h3><p className="mt-2 text-sm leading-relaxed">{s.reply.body}</p></div>}
    {s?.failure && <details className="text-xs text-subtle"><summary className="cursor-pointer">Investigation details</summary><p className="mt-2">{s.failure.raw}</p></details>}
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
  const messages = view ? view.messages.map((m) => ({ id: `server-${m.seq}`, text: m.text, when: new Date(m.at).toLocaleString(), from: m.role === "customer" ? "policyholder" : m.role === "reviewer" ? "note" : "state_farm" })) : threadFor(claim).map((m) => ({ ...m, when: `${m.minutesAgo} simulated minutes ago` }));
  return <section className="mx-auto max-w-4xl space-y-5 p-7"><div><h2 className="text-lg font-semibold">Messages</h2><p className="mt-1 text-sm text-subtle">Customer outreach, inbound messages, delivered agent replies, and internal reviewer notes.</p></div>
    <div className="space-y-5">{messages.map((m) => <article key={m.id} className={m.from === "policyholder" ? "mr-12" : m.from === "note" ? "mx-6" : "ml-12"}><p className="mb-1 text-xs text-subtle">{m.from === "policyholder" ? claim.persona.name : m.from === "note" ? "Internal note" : "State Farm · simulated phone"} · {m.when}</p><p className={`rounded-xl border border-line p-4 text-sm leading-relaxed whitespace-pre-wrap ${m.from === "policyholder" ? "bg-soft" : "bg-critical-soft/30"}`}>{m.text}</p></article>)}</div>
    <div className="rounded-xl border border-line p-5"><div className="mb-3 flex gap-4 text-sm"><button onClick={() => setMode("customer")} className={mode === "customer" ? "font-semibold text-brand" : "text-subtle"}>Simulate customer message</button><button onClick={() => setMode("note")} className={mode === "note" ? "font-semibold text-brand" : "text-subtle"}>Reviewer note</button></div><label className="text-xs text-subtle" htmlFor="case-message">{mode === "customer" ? "Adds information to this case and starts a new agent investigation. No real SMS is sent." : "Saved to the case audit history. Internal notes are not sent to the customer."}</label><textarea id="case-message" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={mode === "customer" ? 4000 : 1000} rows={3} className="mt-2 w-full rounded-lg border border-line p-3 text-sm" placeholder={mode === "customer" ? "Tell the agent what happened next…" : "Add a note for the claims team…"} /><div className="mt-3 flex justify-end"><button disabled={busy || !draft.trim() || (mode === "customer" ? !agent?.configured : !run?.caseId)} onClick={async () => { setBusy(true); setError(null); try { if (mode === "customer") await simulateMessage(claim, draft.trim()); else { const r = await fetch(`/api/cases/${run!.caseId}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "note", note: draft.trim() }) }); if (!r.ok) throw new Error("Could not save reviewer note"); } setDraft(""); setVersion((v) => v + 1); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }} className="cursor-pointer rounded-lg bg-brand px-4 py-2 text-sm font-semibold text-white disabled:opacity-40">{busy ? "Saving…" : mode === "customer" ? "Send simulated message" : "Save note"}</button></div>{error && <p role="alert" className="mt-2 text-sm text-critical-ink">{error}</p>}{mode === "note" && view && view.events.filter((e) => e.type === "reviewer.note").map((e) => <p key={e.id} className="mt-3 rounded-lg bg-soft p-3 text-sm">{String((e.detail as { note: string }).note)}</p>)}</div>
  </section>;
}

export function CasePolicies({ claim, target }: { claim: ClaimView; target: { docId: string; page: number | null } | null }) {
  const policies = claim.persona.policies;
  const [selected, setSelected] = useState<string | null>(target?.docId ?? null);
  const active = target?.docId === selected ? target : null;
  const form = selected ? DOCUMENT_FORMS[selected] : null;
  const documentView = useRef<HTMLDivElement>(null);
  useEffect(() => { if (selected) documentView.current?.scrollIntoView({ block: "start", behavior: "smooth" }); }, [selected]);
  return <section className="space-y-5 p-7"><div><h2 className="text-lg font-semibold">Policies & documents</h2><p className="mt-1 text-sm text-subtle">All policies held by this household, their declarations, and the exact forms used by retrieval.</p></div><div className="grid gap-4 2xl:grid-cols-2">{policies.map((p) => <article key={p.id} className="rounded-xl border border-line p-5"><div className="flex justify-between gap-2"><h3 className="font-semibold">{LINE_LABEL[p.line]} policy</h3><span className="text-xs text-subtle">{p.id}</span></div><p className="mt-1 text-xs text-subtle">{DOCUMENT_FORMS[p.formId]?.name} · {DOCUMENT_FORMS[p.formId]?.formNumber}</p><dl className="mt-4 space-y-2 text-sm">{Object.entries(p.home ? { Dwelling: p.home.dwelling, "Personal property": p.home.personalProperty, "Loss of use": p.home.lossOfUse, Deductible: p.home.deductible, "Wind / hail deductible": p.home.windHailDeductible } : p.auto ? { "Comprehensive deductible": p.auto.comprehensiveDeductible, "Collision deductible": p.auto.collisionDeductible } : { "Umbrella liability limit": p.umbrellaLimit ?? 0 }).map(([key, n]) => <div key={key} className="flex justify-between gap-3"><dt className="text-subtle">{key}</dt><dd>{money(n)}</dd></div>)}{p.auto && <><div className="flex justify-between"><dt className="text-subtle">Liability</dt><dd>{p.auto.liability}</dd></div>{p.auto.vehicles.map((v) => <p key={`${v.year}:${v.make}:${v.model}`} className="text-xs">{v.year} {v.make} {v.model} · {money(v.value)}</p>)}</>}</dl><button onClick={() => setSelected(p.formId)} className="mt-4 cursor-pointer text-sm font-semibold text-brand">Read policy document →</button></article>)}</div>
    {form && <div ref={documentView}><div className="mb-3 flex justify-between"><h3 className="font-semibold">{form.name} · {form.formNumber}</h3><button onClick={() => setSelected(null)} className="text-sm text-subtle">Close document</button></div>{form.hasPdf ? <PdfReader key={`${selected}:${active?.page ?? 1}`} docId={form.id} initialPage={active?.page ?? 1} /> : <article className="space-y-3 rounded-xl border border-line p-5 text-sm"><p>{UMBRELLA_OVERVIEW.intro}</p>{UMBRELLA_OVERVIEW.provides.map((p) => <p key={p}>{p}</p>)}<p className="text-xs text-subtle">{UMBRELLA_OVERVIEW.disclosure}</p></article>}</div>}
    {!policies.length && <p className="rounded-xl bg-soft p-5 text-sm">No policies on file. Coverage requires a claims specialist to review.</p>}
  </section>;
}
