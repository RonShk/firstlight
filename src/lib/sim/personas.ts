import type { Agent, HouseholdType, Member, Persona, Policy, StateCode, Vehicle } from "../../types/sim";
import {
  AGENTS,
  CITIES,
  HOME_FORM_WEIGHTS,
  LAST_NAMES,
  MEDICAL_NEEDS,
  NAMES,
  OCCUPATIONS,
  STREET_TYPES,
  STREETS,
  VEHICLE_MODELS,
  type City,
} from "./data";
import { chance, createRng, gaussian, int, pick, roundTo, weighted, type Rng } from "./random";

export const PERSONA_SEED = 20261107;
export const SIM_YEAR = 2026;

export const HOUSEHOLD_LABELS: Record<HouseholdType, string> = {
  single_young: "Single, young adult",
  single_adult: "Single adult",
  single_senior: "Senior living alone",
  couple_young: "Young couple",
  couple_senior: "Senior couple",
  family_young_kids: "Family, young kids",
  family_teens: "Family, teens",
  single_parent: "Single parent",
  multigen: "Multigenerational",
};

const HOUSEHOLD_WEIGHTS: [HouseholdType, number][] = [
  ["single_young", 14],
  ["single_adult", 12],
  ["single_senior", 10],
  ["couple_young", 10],
  ["couple_senior", 13],
  ["family_young_kids", 17],
  ["family_teens", 11],
  ["single_parent", 8],
  ["multigen", 5],
];

const OWN_RATE: Record<HouseholdType, number> = {
  single_young: 0.25,
  single_adult: 0.6,
  single_senior: 0.75,
  couple_young: 0.5,
  couple_senior: 0.9,
  family_young_kids: 0.75,
  family_teens: 0.88,
  single_parent: 0.45,
  multigen: 0.85,
};

type Sex = "m" | "f";

function firstName(rng: Rng, age: number, sex: Sex): string {
  const era = age < 18 ? "child" : age < 36 ? "young" : age < 62 ? "adult" : "senior";
  return pick(rng, NAMES[era][sex]);
}

function person(rng: Rng, last: string, age: number, sex: Sex, relation: Member["relation"]): Member {
  return { name: `${firstName(rng, age, sex)} ${last}`, age, relation };
}

function kids(rng: Rng, last: string, count: number, minAge: number, maxAge: number): Member[] {
  return Array.from({ length: count }, () =>
    person(rng, last, int(rng, minAge, maxAge), chance(rng, 0.5) ? "m" : "f", "child"),
  ).sort((a, b) => b.age - a.age);
}

function buildMembers(rng: Rng, type: HouseholdType): Member[] {
  const last = pick(rng, LAST_NAMES);
  const sex: Sex = chance(rng, 0.5) ? "m" : "f";
  const other: Sex = chance(rng, 0.92) ? (sex === "m" ? "f" : "m") : sex;
  const spouseLast = chance(rng, 0.85) ? last : pick(rng, LAST_NAMES);
  const self = (min: number, max: number) => person(rng, last, int(rng, min, max), sex, "self");
  const spouse = (age: number, spread: number) =>
    person(rng, spouseLast, Math.max(18, age + int(rng, -spread, spread)), other, "spouse");

  switch (type) {
    case "single_young":
      return [self(19, 29)];
    case "single_adult":
      return [self(30, 59)];
    case "single_senior":
      return [self(66, 93)];
    case "couple_young": {
      const s = self(22, 34);
      return [s, spouse(s.age, 3)];
    }
    case "couple_senior": {
      const s = self(62, 88);
      return [s, spouse(s.age, 4)];
    }
    case "family_young_kids": {
      const s = self(26, 42);
      const n = weighted(rng, [[1, 30], [2, 40], [3, 22], [4, 8]] as const);
      return [s, spouse(s.age, 3), ...kids(rng, last, n, 0, Math.min(11, s.age - 20))];
    }
    case "family_teens": {
      const s = self(38, 55);
      const n = weighted(rng, [[1, 35], [2, 45], [3, 20]] as const);
      const children = kids(rng, last, n, 10, 19);
      if (!children.some((c) => c.age >= 13)) children[0].age = int(rng, 13, 18);
      return [s, spouse(s.age, 4), ...children.sort((a, b) => b.age - a.age)];
    }
    case "single_parent": {
      const s = self(24, 48);
      const n = weighted(rng, [[1, 45], [2, 40], [3, 15]] as const);
      return [s, ...kids(rng, last, n, 0, Math.min(17, s.age - 18))];
    }
    case "multigen": {
      const s = self(30, 50);
      const n = weighted(rng, [[1, 35], [2, 45], [3, 20]] as const);
      const grandparent = person(rng, last, int(rng, 68, 90), chance(rng, 0.65) ? "f" : "m", "parent");
      return [s, spouse(s.age, 3), ...kids(rng, last, n, 0, 16), grandparent];
    }
  }
}

function addMedicalNeeds(rng: Rng, members: Member[]) {
  for (const m of members) {
    if (m.age >= 62) {
      if (chance(rng, 0.33)) m.medicalNeeds = pick(rng, MEDICAL_NEEDS.senior);
      if (m.age >= 78 && chance(rng, 0.35)) m.limitedMobility = true;
      if (m.medicalNeeds === "Uses a walker") m.limitedMobility = true;
    } else if (m.age >= 18) {
      if (chance(rng, 0.05)) m.medicalNeeds = pick(rng, MEDICAL_NEEDS.adult);
    } else if (m.age === 0) {
      m.medicalNeeds = "Newborn";
    } else if (chance(rng, 0.08)) {
      m.medicalNeeds = pick(rng, MEDICAL_NEEDS.child.filter((n) => n !== "Newborn"));
    }
  }
}

function occupationFor(rng: Rng, age: number, rural: boolean): { occupation: string; selfEmployed: boolean } {
  if (age >= 67 || (age >= 62 && chance(rng, 0.6))) return { occupation: pick(rng, OCCUPATIONS.retired), selfEmployed: false };
  if (age <= 22 && chance(rng, 0.55)) return { occupation: pick(rng, OCCUPATIONS.student), selfEmployed: false };
  if (age >= 25 && chance(rng, rural ? 0.25 : 0.11)) {
    const options = rural ? OCCUPATIONS.selfEmployed : OCCUPATIONS.selfEmployed.filter((o) => o !== "Rancher");
    return { occupation: pick(rng, options), selfEmployed: true };
  }
  return { occupation: pick(rng, age < 27 ? OCCUPATIONS.young : OCCUPATIONS.adult), selfEmployed: false };
}

function vehicle(rng: Rng, tags: string[]): Vehicle {
  const pool = VEHICLE_MODELS.filter((v) => v.tags.some((t) => tags.includes(t)));
  const model = pick(rng, pool.length ? pool : VEHICLE_MODELS);
  const year = int(rng, 2009, SIM_YEAR);
  const msrp = int(rng, model.msrp[0], model.msrp[1]);
  const value = roundTo(msrp * Math.pow(0.86, SIM_YEAR - year), 100);
  return { year, make: model.make, model: model.model, value: Math.max(2_500, value) };
}

function vehiclesFor(rng: Rng, type: HouseholdType, members: Member[], wealthy: boolean, rural: boolean): Vehicle[] {
  const primaryTags = wealthy && chance(rng, 0.5) ? ["luxury"] : rural ? ["truck", "awd"] : ["economy", "family", "truck", "ev"];
  const list: Vehicle[] = [];
  const adults = members.filter((m) => m.age >= 18 && m.relation !== "child");
  const drivingAdults = adults.filter((m) => m.age < 90).length;
  if (drivingAdults === 0) return list;
  list.push(vehicle(rng, type.startsWith("family") || type === "multigen" ? ["family", ...primaryTags] : primaryTags));
  if (drivingAdults >= 2 && chance(rng, type === "couple_senior" ? 0.55 : 0.8)) list.push(vehicle(rng, rural ? ["truck"] : ["economy", "family", "truck"]));
  const teenDrivers = members.filter((m) => m.relation === "child" && m.age >= 16).length;
  for (let i = 0; i < teenDrivers; i++) if (chance(rng, 0.7)) list.push(vehicle(rng, ["economy"]));
  return list;
}

function policyNumber(rng: Rng, prefix: string, state: StateCode): string {
  return `${prefix}-${state}-${String(int(rng, 0, 9_999_999)).padStart(7, "0")}`;
}

function nearestAgent(lat: number, lon: number): Agent {
  let best = AGENTS[0];
  let bestDist = Infinity;
  for (const agent of AGENTS) {
    const d = (agent.lat - lat) ** 2 + (agent.lon - lon) ** 2;
    if (d < bestDist) {
      best = agent;
      bestDist = d;
    }
  }
  return best;
}

function vulnerabilitiesOf(members: Member[], type: HouseholdType): string[] {
  const flags: string[] = [];
  const oldest = Math.max(...members.map((m) => m.age));
  if (oldest >= 75) flags.push(`Age ${oldest} in household`);
  if (type === "single_senior") flags.push("Lives alone");
  for (const m of members) {
    if (m.medicalNeeds) flags.push(`${m.name.split(" ")[0]}: ${m.medicalNeeds}`);
    if (m.limitedMobility && !m.medicalNeeds?.includes("walker")) flags.push(`${m.name.split(" ")[0]}: limited mobility`);
  }
  const toddlers = members.filter((m) => m.relation === "child" && m.age <= 4 && m.medicalNeeds !== "Newborn").length;
  if (toddlers) flags.push(toddlers === 1 ? "Toddler in home" : `${toddlers} children under 5`);
  return flags;
}

function generatePersona(rng: Rng, index: number, city: City, usedPhones: Set<string>): Persona {
  const type = weighted(rng, HOUSEHOLD_WEIGHTS);
  const members = buildMembers(rng, type);
  addMedicalNeeds(rng, members);
  const head = members[0];
  const rural = chance(rng, city.rural);
  const spread = rural ? city.spread * 2.4 : city.spread;
  const lat = city.lat + gaussian(rng) * spread;
  const lon = city.lon + gaussian(rng) * spread * 1.2;

  const housing = chance(rng, OWN_RATE[type]) ? "own" : "rent";
  const [lo, hi] = city.homeValue;
  const homeValue = housing === "own" ? roundTo(lo + (hi - lo) * Math.pow(rng(), 1.6), 5_000) : null;
  const wealthy = homeValue !== null && homeValue > lo + (hi - lo) * 0.7;
  const { occupation, selfEmployed } = occupationFor(rng, head.age, rural);

  let phone: string;
  do phone = `(${city.areaCode}) 555-${String(int(rng, 100, 9999)).padStart(4, "0")}`;
  while (usedPhones.has(phone));
  usedPhones.add(phone);

  const policies: Policy[] = [];
  if (homeValue !== null) {
    const dwelling = roundTo(homeValue * (0.85 + rng() * 0.25), 1_000);
    const deductible = pick(rng, [1_000, 1_000, 2_500, 5_000]);
    policies.push({
      id: policyNumber(rng, "HO", city.state),
      line: "home",
      formId: weighted(rng, HOME_FORM_WEIGHTS),
      premiumAnnual: roundTo(dwelling * (0.009 + rng() * 0.004), 10),
      home: {
        dwelling,
        personalProperty: roundTo(dwelling * (0.5 + rng() * 0.25), 1_000),
        lossOfUse: roundTo(dwelling * 0.2, 1_000),
        deductible,
        windHailDeductible: roundTo(dwelling * pick(rng, [0.01, 0.01, 0.02]), 100),
      },
    });
  }

  const vehicles = vehiclesFor(rng, type, members, wealthy, rural);
  if (vehicles.length) {
    const formId = selfEmployed ? "SF-BIZAUTO-OH" : head.age >= 62 || rural ? "SF-AUTO-MT" : "SF-AUTO-TX";
    policies.push({
      id: policyNumber(rng, "AU", city.state),
      line: "auto",
      formId,
      premiumAnnual: roundTo(vehicles.length * (1_100 + rng() * 1_300), 10),
      auto: {
        vehicles,
        liability: pick(rng, ["50/100/50", "100/300/100", "100/300/100", "250/500/250"]),
        collisionDeductible: pick(rng, [500, 500, 1_000]),
        comprehensiveDeductible: pick(rng, [250, 500, 500, 1_000]),
      },
    });
  }

  const teenDriver = members.some((m) => m.relation === "child" && m.age >= 16);
  const umbrellaOdds = wealthy ? 0.6 : teenDriver ? 0.5 : type === "couple_senior" && homeValue ? 0.25 : 0.07;
  if (policies.length && chance(rng, umbrellaOdds)) {
    policies.push({
      id: policyNumber(rng, "UM", city.state),
      line: "umbrella",
      formId: "SF-UMB-WEB",
      premiumAnnual: roundTo(250 + rng() * 250, 10),
      umbrellaLimit: homeValue && homeValue > 900_000 ? 2_000_000 : 1_000_000,
    });
  }

  let responsiveness = head.age < 30 ? 0.93 : head.age < 65 ? 0.9 : head.age < 80 ? 0.78 : 0.6;
  if (members.some((m) => m.limitedMobility)) responsiveness -= 0.08;
  if (type === "single_senior") responsiveness -= 0.07;

  return {
    id: `PH-${String(index + 1).padStart(4, "0")}`,
    name: head.name,
    phone,
    householdType: type,
    members,
    address: {
      street: `${int(rng, 100, 9_899)} ${pick(rng, STREETS)} ${pick(rng, STREET_TYPES)}`,
      city: city.name,
      state: city.state,
      zip: pick(rng, city.zips),
      lat,
      lon,
    },
    housing,
    homeValue,
    occupation,
    selfEmployed,
    agentId: nearestAgent(lat, lon).id,
    policies,
    responsiveness: Math.max(0.35, Math.min(0.97, responsiveness)),
    vulnerabilities: vulnerabilitiesOf(members, type),
  };
}

/** Deterministic: the same seed always yields the same 2,000 policyholders. */
export function generatePersonas(seed = PERSONA_SEED): Persona[] {
  const rng = createRng(seed);
  const usedPhones = new Set<string>();
  const personas: Persona[] = [];
  for (const city of CITIES) {
    for (let i = 0; i < city.count; i++) personas.push(generatePersona(rng, personas.length, city, usedPhones));
  }
  return personas;
}

let cache: Persona[] | null = null;
export function getPersonas(): Persona[] {
  cache ??= generatePersonas();
  return cache;
}

export function getPersona(id: string): Persona | undefined {
  return getPersonas().find((p) => p.id === id);
}

export function totalInsuredValue(p: Persona): number {
  let total = 0;
  for (const policy of p.policies) {
    if (policy.home) total += policy.home.dwelling + policy.home.personalProperty;
    if (policy.auto) total += policy.auto.vehicles.reduce((s, v) => s + v.value, 0);
  }
  return total;
}
