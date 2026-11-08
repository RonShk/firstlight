import assert from "node:assert/strict";
import { it } from "node:test";
import { buildClaims } from "../generate";
import { demoSchedule } from "../demo";

it("replays only tornado households within the window, severe cases first and silent ones late", () => {
  const claims = buildClaims();
  const s = demoSchedule(claims, 60, 3);
  const byId = new Map(claims.map((c) => [c.id, c]));
  const order = [...s.arrivals.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => byId.get(id)!);
  assert.ok(order.length > 10);
  assert.ok(order.every((c) => c.peril === "Tornado"));
  assert.ok(order.slice(0, 3).every((c) => c.quick.severity === "critical"), "spotlight cases arrive first");
  assert.ok(s.totalMs <= 60_000);
  const firstSilent = order.findIndex((c) => c.silent);
  assert.ok(firstSilent > order.length / 2, "silent households appear late");
});
