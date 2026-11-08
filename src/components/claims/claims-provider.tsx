"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { FiledClaim } from "@/cases/claim-files";
import type { AgentStatus, CaseView, RunSummary } from "@/types/agent";
import type { ClaimMessage, ClaimView } from "@/types/claims";
import { buildClaims, SNAPSHOT_MINUTE } from "@/lib/claims/generate";
import { sortClaims, toView } from "@/lib/claims/review";
import { AgentQueue } from "@/lib/sim/agent-queue";
import { type AgentRun, type Turn } from "@/lib/sim/triage";

export const ADJUSTER = "Jake Stone";

interface ClaimsContextValue {
  claims: ClaimView[];
  queue: AgentQueue;
  runFor: (id: string) => AgentRun | undefined;
  ready: boolean;
  loadError: string | null;
  simulateMessage: (claim: ClaimView, text: string) => Promise<void>;
  agent: AgentStatus | null;
  isRead: (id: string) => boolean;
  markRead: (id: string) => void;
  isAssigned: (id: string) => boolean;
  toggleAssigned: (id: string) => void;
  threadFor: (claim: ClaimView) => ClaimMessage[];
  /** Every drafted/confirmed/denied claim, refreshed every few seconds. */
  filedClaims: FiledClaim[];
  /** The claim for a household, via its case. */
  claimFor: (personaId: string) => FiledClaim | undefined;
  refreshClaims: () => Promise<void>;
}

const ClaimsContext = createContext<ClaimsContextValue | null>(null);

function toggled(set: Set<string>, id: string): Set<string> {
  const next = new Set(set);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function ClaimsProvider({ children }: { children: React.ReactNode }) {
  const base = useMemo(() => buildClaims(), []);
  const [agent, setAgent] = useState<AgentStatus | null>(null);
  const [read, setRead] = useState<Set<string>>(new Set());
  const [assigned, setAssigned] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [stored, setStored] = useState<Record<string, CaseView["messages"]>>({});

  const [filedClaims, setFiledClaims] = useState<FiledClaim[]>([]);
  const refreshClaims = useCallback(async () => {
    const r = await fetch("/api/claim-files");
    if (r.ok) setFiledClaims((await r.json()).claims);
  }, []);
  useEffect(() => {
    let active = true;
    const load = () => fetch("/api/claim-files").then((r) => (r.ok ? r.json() : null)).then((d) => { if (active && d) setFiledClaims(d.claims); }).catch(() => {});
    void load();
    const timer = setInterval(load, 5_000);
    return () => { active = false; clearInterval(timer); };
  }, []);
  const claimsByCase = useMemo(() => new Map(filedClaims.map((c) => [c.caseId, c])), [filedClaims]);

  const [queue] = useState(() => new AgentQueue());
  const queueVersion = useSyncExternalStore(queue.subscribe, queue.getVersion, () => 0);
  useEffect(() => queue.setClock(() => SNAPSHOT_MINUTE), [queue]);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setAgent)
      .catch(() => setAgent({ configured: false, model: null, services: { embeddings: null, reranker: null, guard: null, verifier: false }, knowledge: null, queue: null }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/cases").then(async (res) => {
      if (!res.ok) throw new Error("Could not restore saved cases");
      const data = await res.json() as { cases: { customerId: string; messages: CaseView["messages"]; run: RunSummary | null }[] };
      if (cancelled) return;
      const byId: Record<string, CaseView["messages"]> = {};
      for (const c of data.cases) {
        if (!c.customerId) continue;
        byId[c.customerId] = c.messages;
        const turns: Turn[] = c.messages.filter((m) => m.role !== "reviewer").map((m) => ({ from: m.role === "customer" ? "policyholder" : "state_farm", text: m.text }));
        while (turns.length && turns.at(-1)!.from !== "policyholder") turns.pop();
        if (c.run) queue.restore(c.customerId, turns, c.run);
      }
      setStored(byId);
    }).catch((e: Error) => { if (!cancelled) setLoadError(e.message); })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [queue]);

  const online = agent ? agent.configured : null;
  const claims = useMemo(() => {
    void queueVersion;
    return sortClaims(base.map((c) => {
      const saved = stored[c.id];
      const body = saved?.filter((m) => m.role === "customer").map((m) => m.text);
      const restored = body?.length ? { ...c, body, silent: false,
        thread: saved.map((m) => ({ id: `saved-${m.seq}`, text: m.text, minutesAgo: 0,
          from: m.role === "customer" ? "policyholder" as const : m.role === "reviewer" ? "note" as const : "state_farm" as const })) } : c;
      return toView(restored, queue.runsFor(c.id).at(-1), online);
    }));
  }, [base, queue, queueVersion, online, stored]);

  useEffect(() => {
    if (!ready || loadError) return;
    const incoming = claims.filter((c) => !c.silent && !queue.runsFor(c.id).length).map((c) => {
      const conversation: Turn[] = c.thread.filter((m) => m.from !== "note").map((m) => ({ from: m.from === "policyholder" ? "policyholder" : "state_farm", text: m.text }));
      while (conversation.length && conversation.at(-1)!.from !== "policyholder") conversation.pop();
      return { personaId: c.id, conversation };
    }).filter((i) => i.conversation.length);
    void queue.ensureBatch(incoming);
  }, [claims, queue, ready, loadError]);

  const value: ClaimsContextValue = {
    claims, queue, ready, loadError,
    runFor: (id) => queue.runsFor(id).at(-1),
    simulateMessage: async (claim, text) => {
      const previous = queue.runsFor(claim.id).at(-1)?.conversation ?? claim.thread.filter((m) => m.from !== "note").map((m) => ({ from: m.from === "policyholder" ? "policyholder" as const : "state_farm" as const, text: m.text }));
      const turns: Turn[] = [...previous, { from: "policyholder", text }];
      const response = await fetch("/api/messages", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "simulation", personaId: claim.id, conversation: turns }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error ?? "Could not add customer message");
      const summary = await fetch(`/api/runs/${data.runId}`);
      if (!summary.ok) throw new Error("Message saved, but could not load its run. Reload the workspace.");
      queue.restore(claim.id, turns, await summary.json(), true);
    },
    agent,
    filedClaims,
    claimFor: (id) => { const caseId = queue.runsFor(id).at(-1)?.caseId; return caseId ? claimsByCase.get(caseId) : undefined; },
    refreshClaims,
    isRead: (id) => read.has(id),
    markRead: (id) => setRead((s) => (s.has(id) ? s : new Set(s).add(id))),
    isAssigned: (id) => assigned.has(id),
    toggleAssigned: (id) => setAssigned((s) => toggled(s, id)),
    threadFor: (claim) => [
      ...claim.thread,
      ...(claim.review.reply && !claim.thread.some((m) => m.text === claim.review.reply) ? [{ id: "automated", from: "state_farm" as const, text: claim.review.reply, minutesAgo: 1 }] : []),
    ],
  };

  return <ClaimsContext.Provider value={value}>{children}</ClaimsContext.Provider>;
}

export function useClaims(): ClaimsContextValue {
  const ctx = useContext(ClaimsContext);
  if (!ctx) throw new Error("useClaims must be used inside <ClaimsProvider>");
  return ctx;
}
