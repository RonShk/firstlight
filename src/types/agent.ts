// Client-facing agent types. Type-only re-exports: no server code reaches the browser bundle.
export type { RunSummary, RunView, CaseView } from "@/cases/views";
export type { CaseEvent } from "@/cases/events";
export type { Decision, Finding } from "@/agent/schemas";
export type { StoredDecision } from "@/workers/agent-worker";
export type { AgentStatus } from "@/app/api/status/route";
export type { QueueStats, RunProgress } from "@/cases/progress";
export type { FailureExplanation } from "@/agent/failure";
