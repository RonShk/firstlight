// Nessie settlements: not wired into the claims flow for now (kept for a later payment step).
import type { Sqlite } from "../db/sqlite";
import { getClaim } from "./claim-files";
import {
  createSettlementWithdrawal,
  financialSnapshot,
} from "../lib/finance/nessie";
export interface Settlement {
  claim_id: string;
  amount_cents: number;
  status: string;
  transaction_id: string | null;
  created_at: string;
}
export function settlements(db: Sqlite) {
  return db.all<Settlement>(
    "SELECT * FROM claim_settlements ORDER BY created_at DESC",
  );
}
export async function recordSettlement(
  db: Sqlite,
  claimId: string,
  amount: number,
  send = createSettlementWithdrawal,
) {
  settlements(db);
  const cents = Math.round(amount * 100);
  if (
    !Number.isFinite(amount) ||
    cents <= 0 ||
    cents > 100000000 ||
    Math.abs(amount * 100 - cents) > 0.0001
  )
    throw new Error(
      "Enter an amount from $0.01 to $1,000,000 with at most two decimal places.",
    );
  const inserted = db.tx(() => {
    const claim = getClaim(db, claimId);
    if (!claim) throw new Error("File the claim before recording a settlement.");
    if (claim.status !== "confirmed") throw new Error("Confirm the claim before paying a settlement.");
    const existing = db.get<Settlement>(
      "SELECT * FROM claim_settlements WHERE claim_id=?",
      claimId,
    );
    if (existing) {
      if (existing.amount_cents !== cents)
        throw new Error("A different settlement amount is already recorded.");
      return false;
    }
    db.run(
      "INSERT INTO claim_settlements VALUES (?,?,?,NULL,?)",
      claimId,
      cents,
      "submitting",
      new Date().toISOString(),
    );
    return true;
  });
  if (inserted) {
    try {
      await send(claimId, cents / 100);
      db.run(
        "UPDATE claim_settlements SET status='submitted' WHERE claim_id=?",
        claimId,
      );
    } catch {
      db.run(
        "UPDATE claim_settlements SET status='needs_reconciliation' WHERE claim_id=?",
        claimId,
      );
    }
  }
  return db.get<Settlement>(
    "SELECT * FROM claim_settlements WHERE claim_id=?",
    claimId,
  )!;
}
export async function reconcileSettlements(db: Sqlite) {
  const snapshot = await financialSnapshot();
  for (const s of settlements(db)) {
    const matches = snapshot.transactions.filter(
      (t) =>
        t.type === "withdrawal" &&
        t.description === `Nightwatch settlement ${s.claim_id}` &&
        Math.round(t.amount * 100) === s.amount_cents,
    );
    if (matches.length === 1)
      db.run(
        "UPDATE claim_settlements SET status=?,transaction_id=? WHERE claim_id=?",
        matches[0].status,
        matches[0]._id,
        s.claim_id,
      );
  }
  return { ...snapshot, settlements: settlements(db) };
}
