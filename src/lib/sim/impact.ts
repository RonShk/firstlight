/**
 * The simulated world's side of the wall. For each household the tornado hits,
 * decides the hidden truth (damage, injuries, who never replies) and writes the
 * texts that person sends. The agent only ever sees the texts.
 */
import type { ClaimRoute, DamageLevel, Persona, Scenario, WorldTruth } from "../../types/sim";
import { chance, createRng, gaussian, hash, int, pick, type Rng } from "./random";
import { intensityAt, pathPosition } from "./scenarios";

const CRITICAL_MEDICAL = ["Home oxygen", "Dialysis", "Insulin", "Type 1 diabetes", "Newborn", "Pregnant", "Heart condition"];

function damageFrom(score: number): DamageLevel {
  if (score > 0.82) return "destroyed";
  if (score > 0.6) return "severe";
  if (score > 0.4) return "moderate";
  if (score > 0.2) return "minor";
  return "none";
}

const first = (name: string) => name.split(" ")[0];

// ── Message fragments ────────────────────────────────────────────────

const OPENERS: Record<DamageLevel, string[]> = {
  none: ["We're okay, no damage here.", "All good here, thanks for checking.", "Fine here, just lost power for a bit.", "We're safe. Some branches down but the house is fine.", "we good 👍"],
  minor: ["Everyone's okay.", "We're fine, just shaken up.", "No one's hurt thank god."],
  moderate: ["We're okay but the house took a hit.", "Kids are fine but it's bad.", "We're safe but there's real damage."],
  severe: ["We can't stay here tonight.", "The house is wrecked.", "We're out of the house."],
  destroyed: ["The house is gone.", "Everything is gone.", "There's nothing left of our place."],
};

/** Openers that hide how bad it is, so the agent has to read the whole message. */
const DOWNPLAYING = ["We're mostly ok I think.", "Don't want to bother anyone but", "It's not that bad, mostly."];

const HOME_LINES: Record<Exclude<DamageLevel, "none">, string[]> = {
  minor: ["Lost a bunch of shingles and the fence is down.", "Hail cracked a couple windows and dented the gutters.", "Part of the fence and the trampoline are in the street."],
  moderate: ["A tree came through the roof over the garage and it's leaking.", "Windows blown out on the west side, water getting in.", "Roof is peeled back in a couple spots."],
  severe: ["Half the roof is gone and the back of the house is open.", "Exterior walls on one side collapsed.", "Roof is gone over the bedrooms and everything is soaked."],
  destroyed: ["Only the slab and a closet are left.", "The whole house is flattened.", "It took the house down to the foundation."],
};

const RENTER_LINES: Record<Exclude<DamageLevel, "none">, string[]> = {
  minor: ["Our apartment window got smashed and there's glass everywhere."],
  moderate: ["The apartment flooded through the ceiling, my laptop and furniture are ruined."],
  severe: ["Our unit is torn open, all our stuff is soaked or gone."],
  destroyed: ["The whole apartment building is gone. Everything we owned."],
};

const CAR_LINES = ["The {car} got thrown into the neighbor's yard.", "The {car} is totaled, a tree is on it.", "Every window in the {car} is blown out.", "The {car} has a big dent in the roof from debris."];

const INJURY_LINES = {
  self: ["I got cut up bad from the glass, I'm at the ER.", "I think my leg is broken and the ambulances are backed up.", "I hit my head and I keep throwing up."],
  other: ["{name} got cut up bad from glass, we're at the ER.", "{name}'s leg might be broken, ambulance is backed up.", "{name} hit their head and keeps throwing up.", "{name} got hurt pulling us out, they're getting stitches."],
};

/** [texter has the need, someone else in the household does] */
const MEDICAL_LINES: Record<string, [string, string]> = {
  "Home oxygen": ["My oxygen machine has no power. Maybe a few hours of tank left.", "{name}'s oxygen machine has no power. Maybe a few hours of tank left."],
  "Dialysis 3×/week": ["I have dialysis tomorrow morning and no way to get there.", "{name} has dialysis tomorrow morning and we have no way to get there."],
  "Insulin-dependent diabetes": ["My insulin was in the fridge and the power's out.", "{name}'s insulin was in the fridge and the power's out."],
  "Type 1 diabetes": ["My insulin supplies were in the house.", "{name}'s insulin pump supplies were in the house."],
  Newborn: ["We have a newborn with us and no formula or diapers.", "We have a newborn with us and no formula or diapers."],
  "Pregnant (third trimester)": ["I'm 8 months pregnant and having contractions from the stress.", "{name} is 8 months pregnant and having contractions."],
  "Heart condition": ["I'm having chest pains.", "{name} is having chest pains."],
};

const SHELTER_ASKS = ["Need a hotel for {n} of us.", "Where do we go tonight? There's {n} of us.", "Can you help with a place to stay?", "does insurance pay for a hotel??"];
const CLAIM_ASKS = ["Want to start a claim.", "How do I file?", "What do I do next?", "Is this covered?", "Can someone help us with the claim?"];
const MINOR_ASKS = ["Do I need to file something?", "Is this covered?", "Want to get someone out to look at it.", "prob not worth a claim right?"];
const RENTER_ASKS = ["Can you cover my stuff?", "My insurance covers this right?", "How do I get my stuff replaced?"];
const VAGUE = ["its bad here. what do i do", "need help", "house is messed up. call me", "we got hit. not sure what to do"];

const fill = (text: string, vars: Record<string, string | number>) => text.replace(/\{(\w+)\}/g, (_, k) => String(vars[k] ?? ""));

/** Texting style: some people write in lowercase shorthand with no punctuation. */
function sloppy(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.!]/g, "")
    .replace(/\byou\b/g, "u")
    .replace(/\byour\b/g, "ur")
    .replace(/\bright now\b/g, "rn")
    .replace(/\bplease\b/g, "pls")
    .replace(/'/g, "");
}

// ── Truth ────────────────────────────────────────────────────────────

/** Same rubric the agent is given, applied to the facts only the simulator knows. */
function trueSeverity(p: Persona, damage: DamageLevel, injured: boolean, medicalUrgent: boolean, displaced: boolean): number {
  let s = { none: 5, minor: 22, moderate: 50, severe: 72, destroyed: 82 }[damage];
  if (injured || medicalUrgent) s = Math.max(s + 15, 92);
  else if (displaced && p.vulnerabilities.length) s += 5;
  return Math.min(100, s);
}

function expectedRouteFor(severity: number, damage: DamageLevel, injured: boolean, medicalUrgent: boolean, uninsured: boolean): ClaimRoute {
  if (injured || medicalUrgent || severity >= 70) return "human_review";
  if (damage === "none") return "none";
  if (uninsured) return "human_review";
  return damage === "minor" ? "auto_approve" : "human_review";
}

type Facts = Omit<WorldTruth, "messages" | "replyTimes" | "severity" | "expectedRoute">;

function writeMessages(rng: Rng, p: Persona, t: Facts, injured: { name: string; self: boolean } | null, medical: { need: string; name: string; self: boolean } | null): string[] {
  const { damage } = t;
  if (damage === "none") return [pick(rng, OPENERS.none)];

  // A few people send almost nothing useful. The agent should ask, not guess.
  if (damage !== "minor" && !injured && !medical && chance(rng, 0.1)) return [pick(rng, VAGUE)];

  const vehicle = p.policies.find((x) => x.auto)?.auto?.vehicles[0];
  const car = vehicle ? `${vehicle.make} ${vehicle.model}` : "car";
  const parts: string[] = [];
  const downplay = (injured || medical) && chance(rng, 0.35);
  parts.push(downplay ? pick(rng, DOWNPLAYING) : pick(rng, OPENERS[damage]));
  parts.push(pick(rng, p.housing === "own" ? HOME_LINES[damage] : RENTER_LINES[damage]));
  if (t.vehicleDamaged) parts.push(fill(pick(rng, CAR_LINES), { car }));
  if (injured) parts.push(fill(pick(rng, INJURY_LINES[injured.self ? "self" : "other"]), { name: injured.name }));
  if (medical) parts.push(fill(MEDICAL_LINES[medical.need][medical.self ? 0 : 1], { name: medical.name }));
  if (t.uninsuredLoss) parts.push(pick(rng, RENTER_ASKS));
  else if (t.displaced) parts.push(fill(pick(rng, SHELTER_ASKS), { n: p.members.length }));
  else parts.push(pick(rng, damage === "minor" ? MINOR_ASKS : CLAIM_ASKS));

  if (downplay && parts[0].endsWith("but")) parts[1] = parts[1][0].toLowerCase() + parts[1].slice(1);
  let texts = [parts.join(" ")];
  // Some people send the urgent part as a second text a minute later.
  if (parts.length >= 4 && !downplay && chance(rng, 0.3)) texts = [parts.slice(0, 2).join(" "), parts.slice(2).join(" ")];
  if (chance(rng, p.members[0].age < 35 ? 0.5 : 0.15)) texts = texts.map(sloppy);
  return texts;
}

export function simulateImpact(p: Persona, scenario: Scenario): WorldTruth | null {
  const intensity = intensityAt(scenario, p.address.lat, p.address.lon);
  if (intensity < 0.04 || p.address.state !== scenario.state) return null;
  const rng = createRng(hash(`${scenario.id}:${p.id}`));

  const damage = damageFrom(intensity * scenario.ferocity + gaussian(rng) * 0.13);
  const vulnerable = p.vulnerabilities.length > 0;
  const injuryOdds = { none: 0, minor: 0.005, moderate: 0.03, severe: 0.12, destroyed: 0.3 }[damage] * (vulnerable ? 1.5 : 1);
  const injuredMember = chance(rng, injuryOdds) ? pick(rng, p.members) : null;
  const medicalMember =
    damage !== "none" && damage !== "minor" ? p.members.find((m) => m.medicalNeeds && CRITICAL_MEDICAL.some((c) => m.medicalNeeds!.startsWith(c)) && MEDICAL_LINES[m.medicalNeeds]) : undefined;
  const displaced = damage === "severe" || damage === "destroyed";
  const vehicleDamaged = p.policies.some((x) => x.auto) && chance(rng, { none: 0, minor: 0.2, moderate: 0.4, severe: 0.6, destroyed: 0.85 }[damage]);
  const uninsuredLoss = damage !== "none" && !p.policies.some((x) => x.home);
  const impactAt = Math.round(pathPosition(scenario, p.address.lat, p.address.lon).progress * scenario.trackMinutes * 10) / 10;

  const facts: Facts = { personaId: p.id, intensity, impactAt, damage, injured: !!injuredMember, medicalUrgent: !!medicalMember, displaced, vehicleDamaged, uninsuredLoss };
  const messages = writeMessages(
    rng,
    p,
    facts,
    injuredMember ? { name: first(injuredMember.name), self: injuredMember.relation === "self" } : null,
    medicalMember ? { need: medicalMember.medicalNeeds!, name: first(medicalMember.name), self: medicalMember.relation === "self" } : null,
  );

  const neverReplies = (injuredMember && damage === "destroyed" && chance(rng, 0.4)) || !chance(rng, p.responsiveness * (damage === "destroyed" ? 0.75 : 1));
  const [lo, hi] = { none: [2, 35], minor: [3, 45], moderate: [5, 60], severe: [8, 85], destroyed: [12, 120] }[damage];
  const firstReply = impactAt + int(rng, lo, hi);
  const replyTimes = neverReplies ? [] : messages.map((_, i) => firstReply + i * int(rng, 1, 2));

  const severity = trueSeverity(p, damage, facts.injured, facts.medicalUrgent, displaced);
  return { ...facts, messages, replyTimes, severity, expectedRoute: expectedRouteFor(severity, damage, facts.injured, facts.medicalUrgent, uninsuredLoss) };
}

export function simulateCatastrophe(personas: Persona[], scenario: Scenario): WorldTruth[] {
  const truths: WorldTruth[] = [];
  for (const p of personas) {
    const t = simulateImpact(p, scenario);
    if (t) truths.push(t);
  }
  return truths;
}
