// Reads load from the vLLM server's Prometheus /metrics endpoint so the worker pool can size itself
// by how busy the GPU actually is rather than by a fixed number of instances.
import { config, type Config } from "../config";

export interface VllmMetrics {
  running: number;
  waiting: number;
  /** Fraction of KV cache in use, 0-1. */
  kvUsage: number;
  preemptions: number;
  /** Cumulative generated tokens and the time they took, for recent per-token latency. */
  tpotSum: number;
  tpotCount: number;
}

export async function readVllmMetrics(c: Config = config(), signal?: AbortSignal): Promise<VllmMetrics | null> {
  const base = c.chat.baseUrl.replace(/\/v1\/?$/, "");
  const res = await fetch(`${base}/metrics`, { headers: { Authorization: `Bearer ${c.chat.apiKey}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000) });
  if (!res.ok) return null;
  const text = await res.text();
  const read = (name: string) => {
    let total = 0, found = false;
    for (const line of text.split("\n")) {
      if (!line.startsWith(`${name}{`) && !line.startsWith(`${name} `)) continue;
      const v = Number(line.slice(line.lastIndexOf(" ") + 1));
      if (Number.isFinite(v)) { total += v; found = true; }
    }
    return found ? total : null;
  };
  const running = read("vllm:num_requests_running");
  if (running === null) return null;
  return {
    running, waiting: read("vllm:num_requests_waiting") ?? 0,
    kvUsage: read("vllm:kv_cache_usage_perc") ?? read("vllm:gpu_cache_usage_perc") ?? 0,
    preemptions: read("vllm:num_preemptions_total") ?? 0,
    tpotSum: read("vllm:time_per_output_token_seconds_sum") ?? read("vllm:inter_token_latency_seconds_sum") ?? 0,
    tpotCount: read("vllm:time_per_output_token_seconds_count") ?? read("vllm:inter_token_latency_seconds_count") ?? 0,
  };
}
