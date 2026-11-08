// Ramp test for the Nemotron vLLM server: run N realistic agent turns in parallel at increasing N and
// measure per-stream speed, aggregate throughput and vLLM queueing/KV usage. Finds the concurrency
// where adding work stops adding throughput.
// Usage: npm run gpu:bench [-- --levels 1,4,8,16,24,32,48 --run <run_id with a checkpoint>]
import { existsSync } from "node:fs";
import OpenAI from "openai";
import { DatabaseSync } from "node:sqlite";
import { config } from "../src/config";
import { readVllmMetrics } from "../src/agent/capacity";
import { toolSpecs } from "../src/tools/registry";

async function main() {
  if (existsSync(".env.local")) process.loadEnvFile(".env.local");
  const c = config();
  const arg = (n: string) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : undefined; };
  const levels = (arg("levels") ?? "1,4,8,16,24,32,48").split(",").map(Number);
  const db = new DatabaseSync(c.opsDbPath);
  const row = (arg("run")
    ? db.prepare("SELECT checkpoint FROM runs WHERE id=?").get(arg("run")!)
    : db.prepare("SELECT checkpoint FROM runs WHERE status='completed' AND checkpoint IS NOT NULL ORDER BY length(checkpoint) DESC LIMIT 1").get()) as { checkpoint: string } | undefined;
  if (!row) throw new Error("No completed run with a checkpoint to use as the benchmark prompt");
  const msgs = (JSON.parse(row.checkpoint).messages as OpenAI.Chat.ChatCompletionMessageParam[]);
  // Stop before the final decision so the model has real work: the context up to the 4th assistant turn.
  let cut = 0, seen = 0;
  msgs.forEach((m, i) => { if (m.role === "assistant" && ++seen === 4) cut = i; });
  const prompt = msgs.slice(0, cut || msgs.length - 1);
  const client = new OpenAI({ apiKey: c.chat.apiKey, baseURL: c.chat.baseUrl, timeout: 600_000, maxRetries: 0 });
  console.log(`prompt: ${prompt.length} messages, ${JSON.stringify(prompt).length} chars`);
  console.log("level | ok/err | p50 ttft s | p50 stream tok/s | p50 total s | max total s | aggregate tok/s | vLLM peak running/waiting | peak KV %");

  for (const n of levels) {
    let peakRunning = 0, peakWaiting = 0, peakKv = 0;
    const sampler = setInterval(async () => {
      const m = await readVllmMetrics(c).catch(() => null);
      if (m) { peakRunning = Math.max(peakRunning, m.running); peakWaiting = Math.max(peakWaiting, m.waiting); peakKv = Math.max(peakKv, m.kvUsage); }
    }, 1_000);
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: n }, async () => {
      const start = Date.now();
      let first = 0, tokens = 0;
      try {
        const stream = await client.chat.completions.create({ model: c.chat.model, messages: prompt, tools: toolSpecs(), tool_choice: "auto",
          temperature: 0.2, max_tokens: 1024, stream: true, stream_options: { include_usage: true } });
        for await (const chunk of stream) {
          if (!first && chunk.choices?.length) first = Date.now();
          if (chunk.usage) tokens = chunk.usage.completion_tokens;
        }
        const total = (Date.now() - start) / 1000;
        return { ok: true, ttft: ((first || Date.now()) - start) / 1000, total, tokens, rate: tokens / Math.max(0.001, (Date.now() - (first || start)) / 1000) };
      } catch (e) {
        return { ok: false, ttft: 0, total: (Date.now() - start) / 1000, tokens: 0, rate: 0, error: (e as Error).message };
      }
    }));
    clearInterval(sampler);
    const wall = (Date.now() - t0) / 1000;
    const ok = results.filter((r) => r.ok);
    const p50 = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const agg = ok.reduce((s, r) => s + r.tokens, 0) / wall;
    console.log([n, `${ok.length}/${results.length - ok.length}`, p50(ok.map((r) => r.ttft)).toFixed(1), p50(ok.map((r) => r.rate)).toFixed(1),
      p50(ok.map((r) => r.total)).toFixed(1), Math.max(...results.map((r) => r.total)).toFixed(1), agg.toFixed(0), `${peakRunning}/${peakWaiting}`, (peakKv * 100).toFixed(1)].join(" | "));
    const errors = results.filter((r) => !r.ok).map((r) => (r as { error?: string }).error);
    if (errors.length) console.log("   errors:", [...new Set(errors)].join("; "));
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
