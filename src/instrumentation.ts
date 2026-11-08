// Starts in-process agent workers when the Next.js server boots (unless AGENT_WORKERS=external, in
// which case `npm run agent:worker` processes run them).
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.AGENT_WORKERS === "external") return;
  const { startWorkers } = await import("./workers/agent-worker");
  startWorkers();
}
