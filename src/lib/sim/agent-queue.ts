import type { RunSummary } from "../../types/agent";
import type { AgentRun, Turn } from "./triage";

const POLL_MS = 1_500;
const SETTLED_REPLY = new Set(["sent", "failed", "cancelled", "held"]);

/**
 * Client-side tracker for agent runs. Each conversation is POSTed once to /api/messages (the server
 * persists it and queues a run); progress is read back in batches from /api/runs. The server decides
 * concurrency; this class only submits and observes. Lives outside React state so the sim clock and
 * the real-time agent run independently.
 */
export class AgentQueue {
  private runs = new Map<string, AgentRun[]>();
  private listeners = new Set<() => void>();
  private epoch = 0;
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private now: () => number = () => 0;

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

  /** Restore persisted work after a refresh without creating another model run. */
  restore(personaId: string, conversation: Turn[], result: RunSummary, replace = false) {
    if (!replace && this.runs.has(personaId)) return;
    const terminal = ["completed", "failed", "superseded"].includes(result.status);
    const settled = !result.reply || SETTLED_REPLY.has(result.reply.status);
    this.runs.set(personaId, [{ key: conversation.map((t) => `${t.from[0]}:${t.text}`).join("␞"),
      conversation, caseId: result.caseId, runId: result.id, result,
      status: terminal && settled ? result.status === "completed" ? "done" : "error" : "running",
      finishedAt: terminal && settled ? this.now() : undefined }]);
    this.changed();
    if (!terminal || !settled) this.schedule();
  }

  /** Submit this conversation unless it was already sent. */
  ensure(personaId: string, key: string, conversation: Turn[]) {
    const list = this.runs.get(personaId) ?? [];
    if (list.at(-1)?.key === key) return;
    this.runs.set(personaId, [...list, { key, conversation, status: "queued" }]);
    this.changed();
    void this.submit(personaId, key, conversation);
  }

  retry(personaId: string) {
    const last = this.runs.get(personaId)?.at(-1);
    if (!last || last.status !== "error") return;
    this.update(personaId, last.key, { status: "queued", error: undefined });
    void this.submit(personaId, last.key, last.conversation);
  }

  /**
   * Start a fresh server-side run for this household's current conversation (after a failure, or to get a
   * second opinion). The previous run and its history stay on the server.
   */
  async rerun(personaId: string): Promise<void> {
    const last = this.runs.get(personaId)?.at(-1);
    if (!last?.caseId) throw new Error("This household has no agent run to repeat yet");
    const res = await fetch(`/api/cases/${last.caseId}/rerun`, { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    this.update(personaId, last.key, { status: "running", runId: data.runId, result: undefined, error: undefined, finishedAt: undefined });
    this.schedule();
  }

  reset() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.epoch++;
    this.runs.clear();
    this.changed();
  }

  private changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private update(personaId: string, key: string, patch: Partial<AgentRun>) {
    const list = this.runs.get(personaId);
    if (!list) return;
    this.runs.set(personaId, list.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    this.changed();
  }

  private async submit(personaId: string, key: string, conversation: Turn[]) {
    const epoch = this.epoch;
    try {
      const res = await fetch("/api/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel: "simulation", personaId, conversation }),
      });
      const data = await res.json();
      if (epoch !== this.epoch) return;
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      if (!data.runId) throw new Error("No customer message to process");
      this.update(personaId, key, { status: "running", runId: data.runId, caseId: data.caseId });
      this.schedule();
    } catch (err) {
      if (epoch === this.epoch) this.update(personaId, key, { status: "error", error: (err as Error).message });
    }
  }

  private schedule() {
    if (!this.timer) this.timer = setTimeout(() => void this.poll(), POLL_MS);
  }

  private async poll() {
    this.timer = null;
    const epoch = this.epoch;
    const active = [...this.runs.entries()].flatMap(([personaId, list]) =>
      list.filter((r) => r.status === "running" && r.runId).map((r) => ({ personaId, run: r })));
    if (!active.length) return;
    try {
      const res = await fetch(`/api/runs?ids=${active.map((a) => a.run.runId).join(",")}`);
      const { runs } = (await res.json()) as { runs: RunSummary[] };
      if (epoch !== this.epoch) return;
      const byId = new Map(runs.map((r) => [r.id, r]));
      for (const { personaId, run } of active) {
        if (this.runs.get(personaId)?.at(-1)?.runId !== run.runId) continue;
        const s = byId.get(run.runId!);
        if (!s) continue;
        const replySettled = !!s.reply && SETTLED_REPLY.has(s.reply.status);
        if (s.status === "completed" && replySettled) this.update(personaId, run.key, { status: "done", result: s, finishedAt: this.now() });
        else if (s.status === "failed" && (replySettled || !s.reply)) this.update(personaId, run.key, { status: "error", result: s, error: s.failure?.summary ?? s.error ?? "Agent run failed", finishedAt: this.now() });
        else if (s.status === "superseded") this.update(personaId, run.key, { status: "error", result: s, error: "Superseded by newer information" });
        else if (s.progress.label !== run.result?.progress.label || s.activity !== run.result?.activity) this.update(personaId, run.key, { result: s });
      }
    } catch {
      // Network blip: try again next tick.
    }
    if (epoch === this.epoch) this.schedule();
  }
}
