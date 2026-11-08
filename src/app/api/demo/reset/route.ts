// POST /api/demo/reset: clear every case, run, event and claim so the tornado can be replayed live.
// Available in demo mode (`npm run demo`, its own database) and in development. Outside demo mode a full
// copy of the database is saved to .cache/backups first, so the reset can be undone. Never in production.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { config } from "@/config";
import { ops } from "@/cases/db";
import { bus } from "@/cases/events";

const TABLES = ["claim_settlements", "filed_claims", "outbox", "review_requests", "claim_drafts", "tool_effects", "artifacts", "events", "runs", "case_messages", "cases"];

const replayAvailable = () => process.env.DEMO_MODE === "1" || process.env.NODE_ENV !== "production";

export async function POST() {
  if (!replayAvailable()) return Response.json({ error: "Replaying the tornado is disabled in production." }, { status: 403 });
  const db = ops();
  let backup: string | null = null;
  if (process.env.DEMO_MODE !== "1") {
    const dir = path.join(".cache", "backups");
    mkdirSync(dir, { recursive: true });
    backup = path.join(dir, `${path.basename(config().opsDbPath, ".db")}-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
    db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  }
  db.tx(() => { for (const t of TABLES) db.run(`DELETE FROM ${t}`); });
  bus.emit("work");
  return Response.json({ ok: true, backup });
}
