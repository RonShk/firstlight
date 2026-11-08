// Run agent workers as a separate process (set AGENT_WORKERS=external for the web server so it only
// accepts messages). Scale out by starting more of these against the same database.
// Usage: npm run agent:worker [-- --concurrency 8]
import { existsSync } from "node:fs";
import { startWorkers } from "../src/workers/agent-worker";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");
const i = process.argv.indexOf("--concurrency");
const pool = startWorkers({ concurrency: i > 0 ? Number(process.argv[i + 1]) : undefined });
if (!pool) process.exit(1);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { pool.stop(); setTimeout(() => process.exit(0), 200); });
