// Capital One Nessie payouts: stubbed until it is wired in. Nothing calls this yet, and the app runs
// without NESSIE_API_KEY. When implemented, each approved provisional advance becomes one transfer
// from the company account (plain fetch to NESSIE_BASE_URL), keyed by payout_id so it never pays twice.

export interface PayoutRequest {
  payout_id: string; // unique per approved item; repeat requests with the same id must not pay again
  amount_usd: number;
  description: string;
}

export type PayoutResult =
  | { status: "not_configured" }
  | { status: "paid"; payout_id: string; transfer_id: string };

export function nessieConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return Boolean(env.NESSIE_API_KEY);
}

export async function requestPayout(request: PayoutRequest): Promise<PayoutResult> {
  void request;
  return { status: "not_configured" };
}
