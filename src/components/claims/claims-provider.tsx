"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { AgentStatus } from "@/types/agent";
import type { ClaimMessage, ClaimView } from "@/types/claims";
import { buildClaims, SNAPSHOT_MINUTE } from "@/lib/claims/generate";
import { sortClaims, toView } from "@/lib/claims/review";
import { AgentQueue } from "@/lib/sim/agent-queue";
import { conversationKey, type Turn } from "@/lib/sim/triage";

export const ADJUSTER = "Jake Stone";

interface ClaimsContextValue {
  claims: ClaimView[];
  agent: AgentStatus | null;
  isRead: (id: string) => boolean;
  markRead: (id: string) => void;
  isAssigned: (id: string) => boolean;
  toggleAssigned: (id: string) => void;
  threadFor: (claim: ClaimView) => ClaimMessage[];
  sendReply: (id: string, text: string) => void;
  requestReview: (claim: ClaimView) => void;
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
  const [replies, setReplies] = useState<Record<string, ClaimMessage[]>>({});

  const [queue] = useState(() => new AgentQueue());
  const queueVersion = useSyncExternalStore(queue.subscribe, queue.getVersion, () => 0);
  useEffect(() => queue.setClock(() => SNAPSHOT_MINUTE), [queue]);

  useEffect(() => {
    fetch("/api/status")
      .then((r) => r.json())
      .then(setAgent)
      .catch(() => setAgent({ configured: false, model: null, services: { embeddings: null, reranker: null, guard: null, verifier: false }, knowledge: null, queue: null }));
  }, []);

  const online = agent ? agent.configured : null;
  const claims = useMemo(() => {
    void queueVersion;
    return sortClaims(base.map((c) => toView(c, queue.runsFor(c.id).at(-1), online)));
  }, [base, queue, queueVersion, online]);

  const requestReview = useCallback(
    (claim: ClaimView) => {
      if (!online || claim.silent) return;
      const turns: Turn[] = claim.body.map((text) => ({ from: "policyholder", text }));
      queue.ensure(claim.id, conversationKey(turns), turns);
    },
    [online, queue],
  );

  const value: ClaimsContextValue = {
    claims,
    agent,
    isRead: (id) => read.has(id),
    markRead: (id) => setRead((s) => (s.has(id) ? s : new Set(s).add(id))),
    isAssigned: (id) => assigned.has(id),
    toggleAssigned: (id) => setAssigned((s) => toggled(s, id)),
    threadFor: (claim) => [
      ...claim.thread,
      ...(claim.review.reply ? [{ id: "automated", from: "state_farm" as const, text: claim.review.reply, minutesAgo: 1 }] : []),
      ...(replies[claim.id] ?? []),
    ],
    sendReply: (id, text) =>
      setReplies((r) => ({ ...r, [id]: [...(r[id] ?? []), { id: `reply-${r[id]?.length ?? 0}`, from: "adjuster", text, minutesAgo: 0 }] })),
    requestReview,
  };

  return <ClaimsContext.Provider value={value}>{children}</ClaimsContext.Provider>;
}

export function useClaims(): ClaimsContextValue {
  const ctx = useContext(ClaimsContext);
  if (!ctx) throw new Error("useClaims must be used inside <ClaimsProvider>");
  return ctx;
}
