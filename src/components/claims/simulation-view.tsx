"use client";

import { useEffect, useMemo, useState } from "react";
import { Pause, Play, RotateCcw, Users } from "lucide-react";
import { simulateCatastrophe } from "@/lib/sim/impact";
import { TORNADO } from "@/lib/sim/scenarios";
import { triageAt, scoreAgent } from "@/lib/sim/triage";
import { STATUS_META, clockLabel } from "@/lib/sim/status";
import { HOUSEHOLD_LABELS } from "@/lib/sim/personas";
import { useClaims } from "./claims-provider";

export function SimulationView({ onOpen }: { onOpen: (id: string) => void }) {
  const { claims, queue, agent, ready } = useClaims();
  const [minute, setMinute] = useState(200);
  const [playing, setPlaying] = useState(false);
  const [batchMessage, setBatchMessage] = useState<string | null>(null);
  const personas = useMemo(() => claims.map((c) => c.persona).sort((a, b) => a.id.localeCompare(b.id)), [claims]);
  const truths = useMemo(() => simulateCatastrophe(personas, TORNADO), [personas]);
  const byId = new Map(personas.map((p) => [p.id, p]));
  const entries = truths.map((t) => triageAt(byId.get(t.personaId)!, t, minute, [], queue.runsFor(t.personaId), !!agent?.configured)).sort((a, b) => b.priority - a.priority);
  const accuracy = scoreAgent(entries);
  useEffect(() => { queue.setClock(() => minute); return () => queue.setClock(() => 200); }, [queue, minute]);
  useEffect(() => {
    if (!playing || minute >= 200) return;
    const timer = setInterval(() => setMinute((m) => Math.min(200, m + 2)), 500);
    return () => clearInterval(timer);
  }, [playing, minute]);
  const responding = entries.filter((e) => e.conversation?.length);
  const silent = entries.filter((e) => e.status === "silent");
  return <section className="thin-scroll min-h-0 flex-1 overflow-y-auto bg-soft/60 p-7">
    <div className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs font-semibold uppercase tracking-widest text-brand">Catastrophe response · simulated data</p><h1 className="mt-2 text-2xl font-semibold">{TORNADO.title}</h1><p className="mt-2 max-w-2xl text-sm text-subtle">{TORNADO.detail} Watch outreach, household responses, and investigations unfold. Model runs use the same persisted backend as the case workspace.</p></div><span className="rounded-full border border-line bg-white px-4 py-2 text-xs">{clockLabel(TORNADO.touchdown, minute)} · +{minute} minutes</span></div>
    <div className="mt-6 grid grid-cols-2 gap-4 xl:grid-cols-4">{[["Households in portfolio", personas.length], ["In tornado path", truths.length], ["Responding households", responding.length], ["Need welfare follow-up", silent.length]].map(([label, n]) => <div key={label} className="rounded-xl border border-line bg-white p-5"><p className="text-xs text-subtle">{label}</p><p className="mt-2 text-3xl font-semibold">{n}</p></div>)}</div>
    <div className="mt-5 flex flex-wrap items-center gap-4 rounded-xl border border-line bg-white p-5"><button onClick={() => setPlaying((p) => !p)} disabled={minute === 200} className="flex cursor-pointer items-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm text-white disabled:opacity-40">{playing && minute < 200 ? <Pause className="size-4" /> : <Play className="size-4" />}{playing && minute < 200 ? "Pause" : "Play"}</button><button onClick={() => { setPlaying(false); setMinute(0); setBatchMessage(null); }} className="flex cursor-pointer items-center gap-2 text-sm"><RotateCcw className="size-4" />Replay</button><input aria-label="Simulation minute" type="range" min={0} max={200} value={minute} onChange={(e) => { setPlaying(false); setMinute(Number(e.target.value)); }} className="min-w-32 flex-1 accent-brand" /><button onClick={() => { setPlaying(false); setMinute(200); }} className="cursor-pointer text-sm">Latest snapshot</button></div>
    <div className="mt-5 flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-white p-5"><div><h2 className="font-semibold">Run the disaster response</h2><p className="mt-1 text-xs text-subtle">Submit the messages available at this time. The server queues investigations and controls GPU concurrency. No real SMS is sent.</p>{batchMessage && <p role="status" className="mt-2 text-sm text-brand">{batchMessage}</p>}</div><button disabled={!ready || !agent?.configured || !responding.length} onClick={() => { for (const e of responding) queue.ensure(e.persona.id, e.conversationKey!, e.conversation!); setBatchMessage(`${responding.length} responding households submitted. Open a case to follow its agent timeline.`); }} className="flex cursor-pointer items-center gap-2 rounded-lg border border-brand px-4 py-2 text-sm font-semibold text-brand disabled:opacity-40"><Users className="size-4" />Investigate responding households</button></div>
    <div className="mt-6 overflow-x-auto rounded-xl border border-line bg-white"><table className="w-full text-left text-sm"><thead className="border-b border-line bg-soft/50 text-xs text-subtle"><tr>{["Household", "Outreach status", "Latest message / action", ""].map((h, i) => <th key={i} className="px-5 py-3 font-medium">{h}</th>)}</tr></thead><tbody>{entries.map((e) => <tr key={e.persona.id} className="border-b border-line last:border-0"><td className="px-5 py-4"><p className="font-semibold">{e.persona.name}</p><p className="mt-1 text-xs text-subtle">{HOUSEHOLD_LABELS[e.persona.householdType]} · {e.persona.address.city}</p>{e.persona.vulnerabilities.length > 0 && <p className="mt-1 text-xs text-high-ink">{e.persona.vulnerabilities.join(" · ")}</p>}</td><td className="px-5 py-4"><span className="flex items-center gap-2 whitespace-nowrap"><span className={`size-2 rounded-full ${STATUS_META[e.status].dot}`} />{STATUS_META[e.status].label}</span></td><td className="max-w-md px-5 py-4"><p className="line-clamp-2">{e.thread.filter((m) => m.from === "persona").at(-1)?.text ?? e.priorityReason}</p><p className="mt-1 text-xs text-subtle">{(queue.runsFor(e.persona.id).at(-1)?.result?.humanInterventionNeeded ? "Human intervention needed" : queue.runsFor(e.persona.id).at(-1)?.result?.progress.label) ?? `${e.thread.length} simulated messages`}</p></td><td className="px-5 py-4"><button onClick={() => onOpen(e.persona.id)} className="cursor-pointer whitespace-nowrap font-semibold text-brand">Open case →</button></td></tr>)}</tbody></table></div>
    <details className="mt-5 rounded-xl border border-line bg-white p-5 text-sm"><summary className="cursor-pointer font-semibold">Simulation evaluation · hidden answer key</summary><p className="mt-3 text-xs text-subtle">Ground truth is used here to evaluate results. It is never included in model requests.</p><p className="mt-3">{accuracy.scored} cases scored · {accuracy.severityWithin10} within 10 severity points · {accuracy.criticalMissed} critical handoffs missed</p><p className="mt-2 text-xs text-subtle">Replay changes the simulation clock. It preserves saved investigations and case history. The case workspace shows the complete scenario snapshot.</p></details>
  </section>;
}
