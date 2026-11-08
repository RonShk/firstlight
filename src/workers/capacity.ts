// Adaptive concurrency: how many agent runs may be active is decided by how loaded the GPU actually is,
// not by a fixed instance count. Every few seconds the controller reads vLLM's metrics and
//   - adds capacity (additive increase) while generation stays fast, KV cache has room, and vLLM is not
//     queueing or preempting, and the current allowance is actually in use;
//   - cuts capacity (multiplicative decrease) as soon as any of those degrade.
// Runs already in progress are never interrupted; only new starts are gated.
// Benchmarks on our Brev L-class GPU (scripts/gpu-benchmark.ts): per-stream speed 87 tok/s at 1, 47 at 16,
// 34 at 32, 26 at 48 with no errors; aggregate throughput flattens past ~32.
import type { Config } from "../config";
import { readVllmMetrics, type VllmMetrics } from "../agent/capacity";

export interface CapacityState {
  target: number;
  min: number;
  max: number;
  active: number;
  /** Why the target is what it is (last decision). */
  reason: string;
  gpu: { running: number; waiting: number; kvUsagePercent: number; tokensPerSecondPerStream: number | null } | null;
  updatedAt: string;
}

export interface CapacityOptions {
  min: number;
  max: number;
  initial: number;
  /** Below this per-stream generation speed the GPU counts as saturated. */
  minStreamTps: number;
  maxKvUsage: number;
  intervalMs: number;
}

export function capacityOptions(c: Config, env: Record<string, string | undefined> = process.env): CapacityOptions {
  const n = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) ? Number(v) : d);
  const max = n(env.AGENT_MAX_CONCURRENCY, 40);
  return { min: n(env.AGENT_MIN_CONCURRENCY, 2), max, initial: Math.min(max, c.workers.concurrency),
    minStreamTps: n(env.AGENT_MIN_STREAM_TPS, 30), maxKvUsage: n(env.AGENT_MAX_KV_USAGE, 0.85), intervalMs: 5_000 };
}

export class CapacityController {
  private target: number;
  private active = 0;
  private reason = "starting";
  private last: VllmMetrics | null = null;
  private gpu: CapacityState["gpu"] = null;
  private updatedAt = new Date().toISOString();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(readonly options: CapacityOptions, private readonly read: () => Promise<VllmMetrics | null>) {
    this.target = options.initial;
  }

  start() {
    this.timer ??= setInterval(() => void this.sample(), this.options.intervalMs);
    void this.sample();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tryAcquire(): boolean {
    if (this.active >= this.target) return false;
    this.active++;
    return true;
  }

  release() {
    this.active = Math.max(0, this.active - 1);
  }

  state(): CapacityState {
    const { min, max } = this.options;
    return { target: this.target, min, max, active: this.active, reason: this.reason, gpu: this.gpu, updatedAt: this.updatedAt };
  }

  /** One control step. Exposed for tests. */
  async sample(): Promise<void> {
    const m = await this.read().catch(() => null);
    const { min, max, initial, minStreamTps, maxKvUsage } = this.options;
    this.updatedAt = new Date().toISOString();
    if (!m) {
      this.target = initial;
      this.reason = "GPU metrics unavailable; using the configured concurrency";
      this.gpu = null;
      return;
    }
    const prev = this.last;
    this.last = m;
    const dCount = prev ? m.tpotCount - prev.tpotCount : 0;
    const tps = prev && dCount > 50 ? dCount / Math.max(1e-6, m.tpotSum - prev.tpotSum) : null;
    this.gpu = { running: m.running, waiting: m.waiting, kvUsagePercent: Math.round(m.kvUsage * 1000) / 10, tokensPerSecondPerStream: tps === null ? null : Math.round(tps) };

    const pressure =
      m.kvUsage > maxKvUsage ? `KV cache ${Math.round(m.kvUsage * 100)}% full`
      : prev && m.preemptions > prev.preemptions ? "vLLM is preempting requests"
      : tps !== null && tps < minStreamTps && m.running >= 2 ? `generation slowed to ${Math.round(tps)} tok/s per stream`
      : m.waiting > Math.max(4, m.running) ? `vLLM queueing ${m.waiting} requests`
      : null;
    if (pressure) {
      const next = Math.max(min, Math.floor(Math.min(this.target, Math.max(this.active, min)) * 0.75));
      this.reason = `Backing off: ${pressure}`;
      this.target = next;
    } else if (this.active >= this.target - 1 && this.target < max) {
      this.target = Math.min(max, this.target + 2);
      this.reason = `GPU healthy${tps !== null ? ` (${Math.round(tps)} tok/s per stream)` : ""}; adding capacity`;
    } else {
      this.reason = this.target >= max ? "At the configured maximum" : "GPU healthy; capacity not fully used";
    }
  }
}

const g = globalThis as unknown as { __nightwatchCapacity?: CapacityController };
export const capacity = (): CapacityController | null => g.__nightwatchCapacity ?? null;
export function startCapacity(c: Config): CapacityController {
  g.__nightwatchCapacity ??= new CapacityController(capacityOptions(c), () => readVllmMetrics(c));
  g.__nightwatchCapacity.start();
  return g.__nightwatchCapacity;
}
export function stopCapacity() {
  g.__nightwatchCapacity?.stop();
  g.__nightwatchCapacity = undefined;
}
