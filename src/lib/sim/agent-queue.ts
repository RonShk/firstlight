import type { AgentResult } from "../agent/types";
import type { AgentRun, Turn } from "./triage";

const CONCURRENCY = 4;

/**
 * Client-side queue of calls to /api/agent. Lives outside React state so the
 * sim clock and the (slower, real-time) agent run independently.
 */
export class AgentQueue {
  private runs = new Map<string, AgentRun[]>();
  private listeners = new Set<() => void>();
  private inFlight = 0;
  private epoch = 0;
  private version = 0;

  private now: () => number = () => 0;

  /** Where the sim clock is read from, to timestamp the agent's reply on the phone. */
  setClock(now: () => number) {
    this.now = now;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getVersion = () => this.version;

  runsFor(personaId: string): AgentRun[] {
    return this.runs.get(personaId) ?? [];
  }

  /** Queue an agent pass unless this exact conversation was already sent. */
  ensure(personaId: string, key: string, conversation: Turn[]) {
    const list = this.runs.get(personaId) ?? [];
    if (list.at(-1)?.key === key) return;
    this.runs.set(personaId, [...list, { key, conversation, status: "queued" }]);
    this.changed();
    this.pump();
  }

  retry(personaId: string) {
    const list = this.runs.get(personaId);
    const last = list?.at(-1);
    if (!list || !last || last.status !== "error") return;
    this.runs.set(personaId, [...list.slice(0, -1), { ...last, status: "queued", error: undefined }]);
    this.changed();
    this.pump();
  }

  reset() {
    this.epoch++;
    this.runs.clear();
    this.inFlight = 0;
    this.changed();
  }

  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private update(personaId: string, key: string, patch: Partial<AgentRun>) {
    const list = this.runs.get(personaId);
    if (!list) return;
    this.runs.set(
      personaId,
      list.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );
    this.changed();
  }

  private pump() {
    while (this.inFlight < CONCURRENCY) {
      const next = [...this.runs.entries()].find(([, list]) => list.at(-1)?.status === "queued");
      if (!next) return;
      const [personaId, list] = next;
      void this.execute(personaId, list.at(-1)!);
    }
  }

  private async execute(personaId: string, run: AgentRun) {
    const epoch = this.epoch;
    this.inFlight++;
    this.update(personaId, run.key, { status: "running" });
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ personaId, conversation: run.conversation }),
      });
      const data = await res.json();
      if (epoch !== this.epoch) return;
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      this.update(personaId, run.key, { status: "done", result: data as AgentResult, finishedAt: this.now() });
    } catch (err) {
      if (epoch === this.epoch) this.update(personaId, run.key, { status: "error", error: (err as Error).message });
    } finally {
      if (epoch === this.epoch) {
        this.inFlight--;
        this.pump();
      }
    }
  }
}
