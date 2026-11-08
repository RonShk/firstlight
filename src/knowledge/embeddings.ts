// NVIDIA hosted Nemotron embeddings. Queries and passages use different encoders (input_type), and
// the hosted endpoint intermittently returns 500/429, so requests are retried with backoff.
import { config, type Config } from "../config";

export interface Embedder {
  model: string;
  embed(texts: string[], kind: "query" | "passage", signal?: AbortSignal): Promise<Float32Array[]>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function postNvidia(url: string, key: string, body: unknown, signal?: AbortSignal, attempts = 4): Promise<unknown> {
  let last = "";
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(Math.min(8_000, 400 * 2 ** attempt));
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      });
      if (res.ok) return await res.json();
      last = `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (e) {
      if (signal?.aborted) throw e;
      last = `${(e as Error).name}: ${(e as Error).message}`;
    }
  }
  throw new Error(`NVIDIA API request failed: ${last}`);
}

export function nvidiaEmbedder(c: Config = config()): Embedder | null {
  if (!c.nvidiaKey) return null;
  return {
    model: c.embed.model,
    async embed(texts, kind, signal) {
      const out = (await postNvidia(`${c.embed.baseUrl}/embeddings`, c.nvidiaKey, {
        model: c.embed.model, input: texts, input_type: kind, encoding_format: "float", truncate: "END",
      }, signal)) as { data?: { index: number; embedding: number[] }[] };
      if (!Array.isArray(out.data) || out.data.length !== texts.length) throw new Error("Embedding response did not contain one vector per input");
      return out.data.sort((a, b) => a.index - b.index).map((d) => Float32Array.from(d.embedding));
    },
  };
}
