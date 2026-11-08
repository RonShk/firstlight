"use client";

import Image from "next/image";
import { useState } from "react";
import { ADJUSTER, useClaims } from "./claims-provider";

/** Demo mode only: start the live tornado replay, then show its clock. */
function DemoControl() {
  const { demo, agent } = useClaims();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!demo.available) return null;
  if (!demo.started) return <span className="flex items-center gap-3">
    {error && <span role="alert" className="text-xs text-critical-ink">{error}</span>}
    <button disabled={busy || !agent?.configured} title="Clear this workspace and replay the Moore tornado live"
      onClick={async () => {
        if (!demo.dedicated && !window.confirm("Simulate the tornado? This clears every case and claim in this workspace (a backup of the database is saved first) and replays the Moore tornado live.")) return;
        setBusy(true); setError(null);
        try { await demo.start(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}
      className="rounded-full bg-brand px-4 py-1.5 text-sm font-semibold text-white hover:bg-brand/90 disabled:opacity-40">{busy ? "Resetting…" : "▶ Simulate tornado"}</button>
  </span>;
  return <span className="flex items-center gap-3 rounded-full bg-critical-soft px-4 py-1.5 text-sm text-critical-ink">
    <span className="size-2 animate-pulse rounded-full bg-brand" />
    <strong>EF4 tornado · Moore, OK</strong>
    <span>T+{demo.simMinutes} min</span>
    <span className="text-xs">{demo.arrived}/{demo.total} households</span>
  </span>;
}

export function AppHeader() {
  return <header className="flex h-[62px] shrink-0 items-center justify-between border-b border-line bg-white px-6">
    <div className="flex items-center gap-4"><Image src="/state-farm-logo.png" alt="State Farm" width={160} height={28} priority /><span className="h-6 w-px bg-line" /><span className="text-sm text-subtle">Catastrophe response</span></div>
    <div className="flex items-center gap-5"><DemoControl /><span className="flex items-center gap-2"><span className="grid size-8 place-items-center rounded-full bg-soft text-xs font-semibold">JS</span><span className="text-sm">{ADJUSTER}</span></span></div>
  </header>;
}
