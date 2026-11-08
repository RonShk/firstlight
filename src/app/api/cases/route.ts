// Restore the demo workspace from persisted cases, including runs started by another browser.
import { connection } from "next/server";
import { ops } from "@/cases/db";
import { getCase, messages } from "@/cases/repository";
import { caseRuns } from "@/cases/runs";
import { runSummary } from "@/cases/views";
import { queueStats } from "@/cases/progress";

export async function GET() {
  await connection();
  const db = ops();
  const stats = queueStats(db);
  const cases = db.all<{ id: string }>("SELECT id FROM cases WHERE channel='simulation' ORDER BY updated_at DESC LIMIT 500").map(({ id }) => {
    const record = getCase(db, id)!;
    const run = caseRuns(db, id).at(-1);
    return { customerId: record.customerId, caseId: id, messages: messages(db, id), run: run ? runSummary(db, run, stats) : null };
  });
  return Response.json({ cases });
}
