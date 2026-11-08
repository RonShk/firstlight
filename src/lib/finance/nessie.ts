// Server-only credentials; Nessie is a banking sandbox, never a production payout rail.
export function nessieConfigured(
  env: Record<string, string | undefined> = process.env,
) {
  return Boolean(env.NESSIE_API_KEY && env.NESSIE_ACCOUNT_ID);
}
export async function nessieRequest<T>(
  path: string,
  body?: object,
): Promise<T> {
  if (!nessieConfigured()) throw new Error("Nessie account is not configured");
  const base =
    process.env.NESSIE_BASE_URL || "https://prod-api.nessieisreal.com";
  const response = await fetch(
    `${base}${path}?key=${encodeURIComponent(process.env.NESSIE_API_KEY!)}`,
    {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw new Error(`Nessie request failed (${response.status}): ${path}`);
  return response.json() as Promise<T>;
}
export interface BankTransaction {
  _id: string;
  amount: number;
  description?: string;
  status: string;
  type?: string;
}
export const accountPath = () =>
  `/accounts/${encodeURIComponent(process.env.NESSIE_ACCOUNT_ID!)}`;
export async function financialSnapshot() {
  const [account, deposits, withdrawals] = await Promise.all([
    nessieRequest<{ balance: number; nickname: string }>(accountPath()),
    nessieRequest<BankTransaction[]>(`${accountPath()}/deposits`),
    nessieRequest<BankTransaction[]>(`${accountPath()}/withdrawals`),
  ]);
  return {
    account,
    transactions: [
      ...deposits.map((t) => ({ ...t, type: "deposit" })),
      ...withdrawals.map((t) => ({ ...t, type: "withdrawal" })),
    ],
  };
}
export async function createSettlementWithdrawal(
  claimId: string,
  amount: number,
) {
  // `status` is required: Nessie accepts a withdrawal without it, but then every later
  // GET of the account's withdrawals fails validation, breaking reconciliation permanently.
  return nessieRequest(`${accountPath()}/withdrawals`, {
    medium: "balance",
    status: "pending",
    transaction_date: new Date().toISOString().slice(0, 10),
    amount,
    description: `Nightwatch settlement ${claimId}`,
  });
}
