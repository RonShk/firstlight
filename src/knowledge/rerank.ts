// NVIDIA Nemotron reranker: a cross-encoder that scores (query, passage) pairs jointly. It re-orders
// the fused lexical + dense candidates, which is where most precision comes from on policy text.
import { config, type Config } from "../config";
import { postNvidia } from "./embeddings";

export interface Reranker {
  model: string;
  rerank(query: string, passages: string[], signal?: AbortSignal): Promise<number[]>;
}

export function nvidiaReranker(c: Config = config()): Reranker | null {
  if (!c.rerank) return null;
  const { url, model } = c.rerank;
  return {
    model,
    async rerank(query, passages, signal) {
      const out = (await postNvidia(url, c.nvidiaKey, {
        model, query: { text: query }, passages: passages.map((text) => ({ text })), truncate: "END",
      }, signal, 2)) as { rankings?: { index: number; logit: number }[] };
      if (!Array.isArray(out.rankings)) throw new Error("Rerank response had no rankings");
      const scores = new Array<number>(passages.length).fill(-Infinity);
      for (const r of out.rankings) scores[r.index] = r.logit;
      return scores;
    },
  };
}
