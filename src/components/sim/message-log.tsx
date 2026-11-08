"use client";

import { useMemo } from "react";
import { Bot, HeartPulse } from "lucide-react";
import { cn } from "@/lib/utils";
import { AGENTS } from "@/lib/sim/data";
import { HOUSEHOLD_LABELS } from "@/lib/sim/personas";
import { ROUTE_META, STATUS_META, clockLabel, money } from "@/lib/sim/status";
import { TORNADO } from "@/lib/sim/scenarios";
import { ESCALATE_AFTER, reasonOf, replyOf, routeOf, scoreAgent, severityOf, statusFromSeverity, type TriageEntry } from "@/lib/sim/triage";
import { useSim } from "./sim-provider";
import { PersonCard } from "./person-card";

const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a]));
const TRIAGE_LABEL = { 1: "Green", 2: "Yellow", 3: "Red" } as const;

interface Row {
  id: string;
  at: number;
  entry: TriageEntry;
  kind: "message" | "silence";
}

function Assessment({ entry }: { entry: TriageEntry }) {
  const { agent } = useSim();
  const run = entry.run;
  const current = run && run.key === entry.conversationKey;
  const r = current && run.status === "done" ? run.result : undefined;
  if (r && r.result.status === "agent_unavailable") {
    return (
      <span className="text-[11px] text-rose-300" title={r.result.error}>
        Agent unavailable · flagged for a specialist
      </span>
    );
  }
  if (r) {
    const a = r.result;
    const severity = severityOf(r)!;
    const route = routeOf(r);
    const meta = STATUS_META[statusFromSeverity(severity)];
    const label = a.status === "emergency" ? "911" : a.status === "complete" ? TRIAGE_LABEL[a.triage] : "—";
    return (
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className={cn("rounded px-1.5 py-0.5 font-mono text-[11px] font-semibold ring-1", meta.chip)}>{label}</span>
          <span className={cn("rounded px-1.5 py-0.5 text-[10px] ring-1", ROUTE_META[route].chip)}>{ROUTE_META[route].label}</span>
        </div>
        <p className="line-clamp-2 text-[11px] text-muted-foreground" title={reasonOf(r)}>
          {reasonOf(r)}
        </p>
        {a.status === "complete" && (a.claim_amount_usd || a.approved_amount_usd) ? (
          <p className="text-[11px] tabular-nums">
            {a.claim_amount_usd ? `${money(a.claim_amount_usd)} est.` : ""}
            {a.claim_amount_usd && a.approved_amount_usd ? " · " : ""}
            {a.approved_amount_usd ? `${money(a.approved_amount_usd)} advanced` : ""}
          </p>
        ) : null}
      </div>
    );
  }
  if (!agent?.configured) return <span className="text-[11px] text-amber-200/80">Agent offline</span>;
  if (current && run.status === "error") return <span className="text-[11px] text-rose-300" title={run.error}>Agent error</span>;
  return (
    <span className="flex items-center gap-1.5 text-[11px] text-cyan-300">
      <Bot className="size-3.5 animate-pulse" />
      Reading…
    </span>
  );
}

function Reply({ entry }: { entry: TriageEntry }) {
  const run = entry.run;
  if (run && run.key === entry.conversationKey && run.status === "done" && run.result && run.finishedAt !== undefined) {
    return (
      <div>
        <p className="text-xs leading-snug">{replyOf(run.result)}</p>
        <p className="mt-1 text-[10px] text-muted-foreground">Sent {clockLabel(TORNADO.touchdown, entry.thread.filter((m) => m.from === "persona").at(-1)!.at + 2)}</p>
      </div>
    );
  }
  return <span className="text-[11px] text-muted-foreground">—</span>;
}

export function MessageLog() {
  const { entries, agent, truths } = useSim();

  const rows = useMemo(() => {
    const list: Row[] = [];
    for (const e of entries) {
      const said = e.thread.filter((m) => m.from === "persona");
      if (said.length) list.push({ id: `${e.persona.id}:m`, at: said[said.length - 1].at, entry: e, kind: "message" });
      else if (e.status === "silent") list.push({ id: `${e.persona.id}:s`, at: e.truth.impactAt + ESCALATE_AFTER, entry: e, kind: "silence" });
    }
    return list.sort((a, b) => b.at - a.at);
  }, [entries]);

  const received = rows.filter((r) => r.kind === "message").length;
  const replied = rows.filter((r) => r.kind === "message" && r.entry.run?.status === "done" && r.entry.run.key === r.entry.conversationKey).length;
  const escalated = rows.length - received;
  const acc = scoreAgent(entries);

  return (
    <div className="mx-auto w-full max-w-7xl p-5">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Incoming messages</h1>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {truths.length} households in the path were texted at impact · {received} replied · {replied} answered by Nemotron · {escalated} silent, escalated
            {acc.scored ? ` · agent vs truth: ${Math.round((acc.routeCorrect / acc.scored) * 100)}% routing, ${acc.criticalMissed}/${acc.criticalTotal} emergencies missed` : ""}
          </p>
        </div>
      </div>

      {agent && !agent.configured ? (
        <div className="mb-3 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-amber-500/20">
          <span className="font-medium">Nemotron agent offline.</span> No replies are sent until it is configured. Set <code className="font-mono">NEMOTRON_MODEL</code> and{" "}
          <code className="font-mono">NEMOTRON_API_KEY</code> in <code className="font-mono">.env.local</code> and restart.
        </div>
      ) : null}

      <div className="panel overflow-hidden">
        <table className="w-full table-fixed text-left text-xs">
          <thead className="border-b border-white/5 text-[10px] tracking-wider text-muted-foreground uppercase">
            <tr>
              <th className="w-[84px] px-4 py-2.5 font-medium">Time</th>
              <th className="w-[210px] px-2 py-2.5 font-medium">Policyholder</th>
              <th className="px-2 py-2.5 font-medium">Message</th>
              <th className="w-[230px] px-2 py-2.5 font-medium">Nemotron</th>
              <th className="px-4 py-2.5 font-medium">Reply sent</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ id, at, entry, kind }) => {
              const p = entry.persona;
              const agent = AGENT_BY_ID[p.agentId];
              return (
                <tr key={id} className="border-b border-white/[0.04] align-top">
                  <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground tabular-nums">{clockLabel(TORNADO.touchdown, at)}</td>
                  <td className="px-2 py-3">
                    <PersonCard persona={p} />
                    <p className="truncate text-[11px] text-muted-foreground">
                      {HOUSEHOLD_LABELS[p.householdType]} · {p.members.length} · {p.address.city}
                    </p>
                    {p.vulnerabilities.length ? (
                      <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-amber-300/90" title={p.vulnerabilities.join(" · ")}>
                        <HeartPulse className="size-3 shrink-0" />
                        {p.vulnerabilities.join(" · ")}
                      </p>
                    ) : null}
                  </td>
                  {kind === "message" ? (
                    <>
                      <td className="px-2 py-3 leading-snug">
                        {entry.thread
                          .filter((m) => m.from === "persona")
                          .map((m, i) => (
                            <p key={i} className={i ? "mt-1" : undefined}>
                              “{m.text}”
                            </p>
                          ))}
                      </td>
                      <td className="px-2 py-3">
                        <Assessment entry={entry} />
                      </td>
                      <td className="px-4 py-3">
                        <Reply entry={entry} />
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-2 py-3 text-violet-300 italic">No reply to 2 check-ins in an hour</td>
                      <td className="px-2 py-3">
                        <span className={cn("rounded px-1.5 py-0.5 text-[10px] ring-1", STATUS_META.silent.chip)}>Silent</span>
                      </td>
                      <td className="px-4 py-3 text-[11px] text-muted-foreground">Escalated to {agent.name} ({agent.city}) for a phone call and welfare check.</td>
                    </>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
