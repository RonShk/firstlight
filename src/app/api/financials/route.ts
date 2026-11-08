import { connection } from "next/server";
import { ops } from "@/cases/db";
import { nessieConfigured } from "@/lib/finance/nessie";
import { reconcileSettlements, settlements } from "@/cases/settlements";
export async function GET() {
  await connection();
  if (!nessieConfigured())
    return Response.json({
      configured: false,
      transactions: [],
      settlements: settlements(ops()),
    });
  try {
    return Response.json({
      configured: true,
      ...(await reconcileSettlements(ops())),
    });
  } catch {
    return Response.json(
      {
        configured: true,
        error:
          "Could not load Nessie financial records. Your claim records are saved.",
        transactions: [],
        settlements: settlements(ops()),
      },
      { status: 502 },
    );
  }
}
// Settlements are paid only through an approval: POST /api/claim-files/:id/decision.
