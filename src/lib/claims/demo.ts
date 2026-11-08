/**
 * Demo replay: the tornado's households arrive over a short window instead of all at once, so the
 * dashboard visibly fills, sorts and resolves while the presenters talk. Real arrival order comes from
 * the simulator's reply times; a few of the most severe cases are pulled to the front so their reviews
 * finish early in the recording. Households that never reply appear late, as "no reply" welfare checks.
 */
import type { Claim } from "../../types/claims";
import { SNAPSHOT_MINUTE } from "./generate";
import { SEVERITIES } from "./quick-read";

export interface DemoSchedule {
  /** Milliseconds after start at which each claim appears. */
  arrivals: Map<string, number>;
  /** Simulated minutes represented by one real second (for the "T+ minutes" clock). */
  simMinutesPerSecond: number;
  totalMs: number;
}

export function demoSchedule(claims: Claim[], seconds = 60, spotlight = 3): DemoSchedule {
  const tornado = claims.filter((c) => c.peril === "Tornado");
  const replied = tornado.filter((c) => !c.silent);
  const firstText = (c: Claim) => SNAPSHOT_MINUTE - Math.max(...c.thread.filter((m) => m.from === "policyholder").map((m) => m.minutesAgo));
  const rank = (c: Claim) => SEVERITIES.indexOf(c.quick.severity) * 1000 - c.quick.score;
  const featured = [...replied].sort((a, b) => rank(a) - rank(b)).slice(0, spotlight);
  const rest = replied.filter((c) => !featured.includes(c)).sort((a, b) => firstText(a) - firstText(b));
  const arrivals = new Map<string, number>();
  featured.forEach((c, i) => arrivals.set(c.id, 2_000 + i * 3_000));
  const start = 2_000 + spotlight * 3_000;
  const span = seconds * 1000 - start;
  const lo = rest.length ? firstText(rest[0]) : 0;
  const hi = rest.length ? firstText(rest.at(-1)!) : 1;
  rest.forEach((c) => arrivals.set(c.id, start + Math.round(((firstText(c) - lo) / Math.max(1, hi - lo)) * span)));
  tornado.filter((c) => c.silent).forEach((c, i) => arrivals.set(c.id, Math.round(seconds * 750) + i * 400));
  const totalMs = Math.max(...arrivals.values(), 0);
  return { arrivals, simMinutesPerSecond: Math.max(1, (hi - lo) / Math.max(1, seconds - start / 1000)), totalMs };
}
