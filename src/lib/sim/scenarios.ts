import type { Scenario } from "../../types/sim";

/** The one demo catastrophe: an EF4 tornado tracking SW → NE through Moore. */
export const TORNADO: Scenario = {
  id: "tornado-moore",
  kind: "tornado",
  title: "EF4 Tornado — Moore, OK",
  headline: "Tornado Emergency",
  detail: "Large, destructive tornado confirmed on the ground. 19-mile path from Newcastle through Moore toward Del City.",
  state: "OK",
  start: [35.285, -97.66],
  end: [35.385, -97.37],
  touchdown: "19:42",
  radiusKm: 0.8,
  outerKm: 2.6,
  ferocity: 0.95,
  trackMinutes: 22,
};

const KM_PER_DEG_LAT = 110.574;

function toKm(origin: [number, number], point: [number, number]): [number, number] {
  const kmPerDegLon = 111.32 * Math.cos((origin[0] * Math.PI) / 180);
  return [(point[1] - origin[1]) * kmPerDegLon, (point[0] - origin[0]) * KM_PER_DEG_LAT];
}

/** Where a point projects onto the path (0 = touchdown, 1 = lift) and how far from it, in km. */
export function pathPosition(scenario: Scenario, lat: number, lon: number): { progress: number; distanceKm: number } {
  const p = toKm(scenario.start, [lat, lon]);
  const e = toKm(scenario.start, scenario.end);
  const len2 = e[0] ** 2 + e[1] ** 2;
  const progress = Math.max(0, Math.min(1, (p[0] * e[0] + p[1] * e[1]) / len2));
  return { progress, distanceKm: Math.hypot(p[0] - progress * e[0], p[1] - progress * e[1]) };
}

export function distanceKm(scenario: Scenario, lat: number, lon: number): number {
  return pathPosition(scenario, lat, lon).distanceKm;
}

/** 0..1 hazard at a location: 1 in the core, fading to 0 at outerKm. */
export function intensityAt(scenario: Scenario, lat: number, lon: number): number {
  const d = distanceKm(scenario, lat, lon);
  if (d <= scenario.radiusKm) return 1 - 0.3 * (d / scenario.radiusKm);
  if (d >= scenario.outerKm) return 0;
  const f = 1 - (d - scenario.radiusKm) / (scenario.outerKm - scenario.radiusKm);
  return 0.7 * Math.pow(f, 1.4);
}

export const KM_PER_MILE = 1.609344;

/** Miles from a location to the scenario's path; used to estimate urgency for households that never replied. */
export function milesFromPath(scenario: Scenario, lat: number, lon: number): number {
  return distanceKm(scenario, lat, lon) / KM_PER_MILE;
}
