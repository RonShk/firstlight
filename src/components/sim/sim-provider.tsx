"use client";

import { createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { Persona, WorldTruth } from "@/types/sim";
import type { AgentStatus } from "@/types/agent";
import { getPersonas } from "@/lib/sim/personas";
import { simulateCatastrophe } from "@/lib/sim/impact";
import { TORNADO } from "@/lib/sim/scenarios";
import { triageAt, type TriageEntry } from "@/lib/sim/triage";
import { AgentQueue } from "@/lib/sim/agent-queue";

/** The page shows a fixed snapshot this many minutes after touchdown, when every reply has arrived. */
export const SNAPSHOT_MINUTE = 200;

interface SimContextValue {
  personas: Persona[];
  truths: WorldTruth[];
  /** Every household in the tornado's path, as of the snapshot. */
  entries: TriageEntry[];
  agent: AgentStatus | null;
  queue: AgentQueue;
}

const SimContext = createContext<SimContextValue | null>(null);

export function SimProvider({ children }: { children: React.ReactNode }) {
  const personas = useMemo(() => getPersonas(), []);
  const personaById = useMemo(() => new Map(personas.map((p) => [p.id, p])), [personas]);
  const truths = useMemo(() => simulateCatastrophe(personas, TORNADO), [personas]);

  const [agent, setAgent] = useState<AgentStatus | null>(null);

  const [queue] = useState(() => new AgentQueue());
  const queueVersion = useSyncExternalStore(queue.subscribe, queue.getVersion, () => 0);

  // Agent replies are stamped a few minutes after the message they answer.
  useEffect(() => queue.setClock(() => SNAPSHOT_MINUTE), [queue]);

  useEffect(() => {
    // Refreshed every few seconds so the header can show queue depth and the time to drain it.
    const load = () => fetch("/api/status")
      .then((r) => r.json())
      .then(setAgent)
      .catch(() => setAgent({ configured: false, model: null, services: { embeddings: null, reranker: null, guard: null, verifier: false }, knowledge: null, queue: null }));
    void load();
    const timer = setInterval(load, 5_000);
    return () => clearInterval(timer);
  }, []);

  const online = !!agent?.configured;
  const entries = useMemo(() => {
    void queueVersion;
    return truths.map((truth) => triageAt(personaById.get(truth.personaId)!, truth, SNAPSHOT_MINUTE, [], queue.runsFor(truth.personaId), online));
  }, [truths, personaById, queue, queueVersion, online]);

  // Every conversation that's ready goes to the agent. The queue skips ones it has already seen.
  useEffect(() => {
    if (!online) return;
    for (const e of entries) if (e.conversation && e.conversationKey) queue.ensure(e.persona.id, e.conversationKey, e.conversation);
  }, [entries, online, queue]);

  return <SimContext.Provider value={{ personas, truths, entries, agent, queue }}>{children}</SimContext.Provider>;
}

export function useSim(): SimContextValue {
  const ctx = useContext(SimContext);
  if (!ctx) throw new Error("useSim must be used inside <SimProvider>");
  return ctx;
}
