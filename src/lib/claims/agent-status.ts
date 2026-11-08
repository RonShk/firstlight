import type { AgentRun } from "../sim/triage";

export function agentStatus(run?: AgentRun): { label: string; tone: "neutral" | "running" | "done" | "review" | "failed" } {
  if (!run) return { label: "Not started", tone: "neutral" };
  if (run.status === "queued" || run.result?.status === "queued") return { label: "Queued", tone: "running" };
  if (run.status === "running") return { label: "Running", tone: "running" };
  if (run.result?.humanInterventionNeeded || run.result?.decision?.decision.next_action === "human_review") return { label: "Human review needed", tone: "review" };
  if (run.status === "error") return { label: "Failed", tone: "failed" };
  return { label: "Done", tone: "done" };
}
