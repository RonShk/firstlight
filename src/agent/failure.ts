// Turns a raw run error into a plain-language reason for the dashboard. The raw error is always kept
// alongside it for debugging.

export interface FailureExplanation {
  /** One short sentence for the run list and timeline. */
  summary: string;
  /** What it means and what to do. */
  explanation: string;
  /** Whether simply re-running is likely to help. */
  retryable: boolean;
  /** The original error text. */
  raw: string;
}

const RULES: [RegExp, Omit<FailureExplanation, "raw">][] = [
  [/not set|not configured/i, { summary: "Nemotron is not configured", explanation: "NEMOTRON_API_KEY or NEMOTRON_MODEL is missing on the server. Fix the env file, restart, then re-run.", retryable: false }],
  [/Knowledge base not built/i, { summary: "Policy knowledge base is missing", explanation: "Run `npm run knowledge:ingest` on the server, then re-run.", retryable: false }],
  [/no tokens for/i, { summary: "Nemotron stopped responding", explanation: "The model produced no output for a minute, repeatedly. The Brev server may be overloaded or restarting. Re-running usually works once it recovers.", retryable: true }],
  [/Connection error|ECONN|fetch failed|socket hang up|terminated/i, { summary: "Could not reach the Nemotron server", explanation: "The connection to the Brev endpoint kept dropping, even after automatic retries. Check that the Brev instance is running, then re-run.", retryable: true }],
  [/timed out|timeout/i, { summary: "Nemotron request timed out", explanation: "A model call took too long, repeatedly. Re-running usually works when the GPU is less busy.", retryable: true }],
  [/HTTP 5\d\d|status code 5\d\d|50[0-9] /i, { summary: "Nemotron server error", explanation: "The model server returned an error. Re-run once it is healthy.", retryable: true }],
  [/never matched the schema/i, { summary: "Agent's final decision was malformed", explanation: "Nemotron could not produce a decision in the required format after several attempts. A re-run usually succeeds.", retryable: true }],
  [/Turn budget exhausted/i, { summary: "Agent ran out of steps", explanation: "The agent kept investigating without reaching a decision that passed the grounding checks. Re-run, or request investigation with a note that narrows the question.", retryable: true }],
  [/stopped calling tools/i, { summary: "Agent stopped using its tools", explanation: "Nemotron answered in plain text instead of investigating. A re-run usually succeeds.", retryable: true }],
  [/token limit/i, { summary: "Model output kept getting cut off", explanation: "The model exceeded the output budget, including its concise final attempt. A safe acknowledgement was prepared and human review queued.", retryable: true }],
  [/safety limit/i, { summary: "Run hit the time safety limit", explanation: "The run took longer than the wall-clock safety limit. Re-run when the GPU is less busy.", retryable: true }],
  [/Exceeded retry attempts/i, { summary: "Worker crashed repeatedly on this run", explanation: "The worker processing this run stopped several times. Check the server logs, then re-run.", retryable: true }],
];

export function explainFailure(error: string | null | undefined): FailureExplanation | null {
  if (!error) return null;
  const rule = RULES.find(([pattern]) => pattern.test(error));
  const retries = /after (\d+) automatic retr/i.exec(error)?.[1];
  const base = rule?.[1] ?? { summary: "Unexpected error in the agent", explanation: "Something failed outside the expected cases. The raw error below has the details; re-running may help.", retryable: true };
  return { ...base, summary: retries ? `${base.summary} (after ${retries} automatic retries)` : base.summary, raw: error };
}

/** Expected investigation limits are a handoff reason, rather than infrastructure trouble. */
export const isInvestigationLimit = (error: string | null | undefined): boolean =>
  /Turn budget exhausted|token limit|safety limit/i.test(error ?? "");
