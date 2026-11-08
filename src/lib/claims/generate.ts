/**
 * One open claim per policyholder. Households in the tornado's path bring their simulated texts (or
 * their silence); everyone else gets an everyday claim that fits the policies they hold.
 */
import type { Persona, WorldTruth } from "../../types/sim";
import type { Claim, ClaimMessage, Peril } from "../../types/claims";
import { AGENTS } from "../sim/data";
import { simulateCatastrophe } from "../sim/impact";
import { getPersonas } from "../sim/personas";
import { createRng, hash, int, pick, type Rng } from "../sim/random";
import { TORNADO } from "../sim/scenarios";
import { ageLabel } from "./format";
import { quickRead, silentRead } from "./quick-read";

/** Minutes after touchdown the queue is shown at, when every reply has arrived. */
export const SNAPSHOT_MINUTE = 200;

interface HistoryTurn {
  from: "policyholder" | "state_farm" | "adjuster";
  text: string;
  /** How long before the latest message. */
  hoursBefore: number;
}

interface Template {
  needs: "auto" | "home" | null;
  subject: string;
  peril: Peril;
  text: string;
  history?: HistoryTurn[];
}

const TEMPLATES: Template[] = [
  { needs: "auto", subject: "Vehicle is not drivable", peril: "Collision", text: "Hi, I was hit at an intersection this morning while driving to work. My {car} is blocking part of the road and the front wheel looks damaged, so I don't think it can be driven. The police are here now, but I'm not sure what I should do next. Can someone please call me as soon as possible?" },
  { needs: "auto", subject: "Other passenger injured", peril: "Liability", text: "I ran a red light and hit another car near {city}. Their passenger is hurt and an ambulance is on the way. I'm okay but shaking. My {car} is smashed up front. Please call me." },
  { needs: "auto", subject: "Rear-ended at a light", peril: "Collision", text: "Someone rear-ended me at a light on {street}. The bumper is cracked and the trunk won't close, but I can still drive it. How do I get my {car} looked at?" },
  { needs: "auto", subject: "Backed into a parked car", peril: "Liability", text: "I backed into a parked car in {city} and crushed its door. I left a note and the owner just called asking for my insurance. Does my policy cover their car and my {car}?" },
  { needs: "auto", subject: "Deer strike", peril: "Comprehensive", text: "Hit a deer last night near {city}. The hood is crumpled and the radiator is shot, so the {car} can't be driven. Can I get it towed somewhere?" },
  { needs: "auto", subject: "Cracked windshield", peril: "Comprehensive", text: "A rock cracked my windshield on I-35 yesterday and the crack keeps getting longer. Does my policy cover replacing it on my {car}?" },
  {
    needs: "auto", subject: "Rental car extension", peril: "Rental",
    text: "The shop says my {car} needs another week for parts and my rental is due back Friday. Can you extend it?",
    history: [
      { from: "policyholder", text: "Dropped my {car} at the shop today. Who do I talk to about a rental?", hoursBefore: 96 },
      { from: "adjuster", text: "Your rental is approved through Friday. The confirmation is in your email.", hoursBefore: 92 },
    ],
  },
  {
    needs: "auto", subject: "Follow-up on estimate", peril: "Collision",
    text: "I sent the body shop estimate for my {car} on Monday and haven't heard anything. The shop needs approval before they can order parts. Can someone look at it?",
    history: [{ from: "adjuster", text: "Please upload the body shop estimate when you have it and we'll review it.", hoursBefore: 72 }],
  },
  {
    needs: "auto", subject: "Claim status request", peril: "Collision",
    text: "Just checking on the status of my claim for the {car}. Is there anything else you need from me?",
    history: [{ from: "state_farm", text: "Your repair claim is open and assigned to the claims team.", hoursBefore: 48 }],
  },
  { needs: "home", subject: "Water damage spreading", peril: "Water", text: "A pipe burst under the upstairs bathroom and water is spreading into the hallway ceiling. I shut off the main but the drywall is soaked. Can someone come out today?" },
  { needs: "home", subject: "Tree came through the roof", peril: "Wind", text: "High winds last night and a tree came through the roof over the garage. It's tarped for now, but more rain is coming. Who do I call?" },
  { needs: "home", subject: "Hail damage to roof", peril: "Hail", text: "Hail came through {city} yesterday and I've got missing shingles and dents on the gutters. Want to get someone out to look at the roof." },
  { needs: "home", subject: "Break-in at home", peril: "Theft", text: "Someone broke in through the back door while we were out. They took my laptop, a TV and some jewelry. The police report is filed. What do I need to send you?" },
  { needs: "home", subject: "Kitchen fire cleanup", peril: "Fire", text: "We had a grease fire on the stove last night. The fire department put it out, but the cabinets are burned and the kitchen is a mess. How do I start a claim?" },
  {
    needs: "home", subject: "Upload additional receipts", peril: "Fire",
    text: "I have the hotel receipts you requested for the nights we stayed out of the house. Where should I send them? I have six receipts and photos of the kitchen damage as well.",
    history: [
      { from: "policyholder", text: "We had a kitchen fire and can't stay in the house while it's being cleaned.", hoursBefore: 120 },
      { from: "adjuster", text: "I'm sorry to hear that. Is everyone safe?", hoursBefore: 119 },
      { from: "policyholder", text: "Yes, everyone's fine. We're at a hotel near {city}.", hoursBefore: 118 },
      { from: "adjuster", text: "Good. Please keep your hotel receipts so we can review your living expenses.", hoursBefore: 117 },
      { from: "policyholder", text: "Will do. The contractor comes on Thursday.", hoursBefore: 70 },
      { from: "adjuster", text: "Thanks. Please send photos of the kitchen when you can.", hoursBefore: 69 },
      { from: "policyholder", text: "I'll take some this weekend.", hoursBefore: 26 },
    ],
  },
  { needs: "home", subject: "Neighbor's fence damaged", peril: "Liability", text: "A big limb from our oak came down on our neighbor's fence and smashed it. They're asking us to pay for it. Is that something my home policy handles?" },
  { needs: "home", subject: "Guest injury letter", peril: "Liability", text: "A delivery driver slipped on our front steps last month and we just got a letter from their lawyer asking us to pay the medical bills. What should I do?" },
  { needs: null, subject: "Coverage question", peril: "General", text: "I think I may need to file something, but I'm not sure what coverage I have on file. Can someone tell me where I stand?" },
];

function claimNumber(id: string): string {
  const rng = createRng(hash(`claim-number:${id}`));
  return `35-${int(rng, 10, 19)}${pick(rng, [..."JKPTV"])}${int(rng, 1, 9)}-${String(int(rng, 0, 999)).padStart(3, "0")}`;
}

function fill(text: string, p: Persona): string {
  const vehicle = p.policies.find((x) => x.auto)?.auto?.vehicles[0];
  const vars: Record<string, string> = { car: vehicle ? `${vehicle.make} ${vehicle.model}` : "car", city: p.address.city, street: p.address.street.replace(/^\d+\s+/, "") };
  return text.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "");
}

function everydayClaim(p: Persona, rng: Rng): Claim {
  const held = p.policies.map((x) => x.line);
  const fits = TEMPLATES.filter((t) => (t.needs === null ? !held.includes("auto") && !held.includes("home") : held.includes(t.needs)));
  const template = pick(rng, fits);
  const minutesAgo = int(rng, 3, 420);
  const text = fill(template.text, p);
  const thread: ClaimMessage[] = [
    { id: "opened", from: "note", text: `Claim opened in the State Farm mobile app ${ageLabel(minutesAgo + (template.history?.[0]?.hoursBefore ?? 0) * 60)} ago`, minutesAgo: minutesAgo + (template.history?.[0]?.hoursBefore ?? 0) * 60 },
    ...(template.history ?? []).map((h, i) => ({ id: `h${i}`, from: h.from, text: fill(h.text, p), minutesAgo: minutesAgo + h.hoursBefore * 60 })),
    { id: "latest", from: "policyholder", text, minutesAgo },
  ];
  return {
    id: p.id,
    number: claimNumber(p.id),
    persona: p,
    subject: template.subject,
    peril: template.peril,
    body: [text],
    minutesAgo,
    thread,
    silent: false,
    quick: quickRead([text], p, minutesAgo),
  };
}

const TORNADO_SUBJECTS: [RegExp, string][] = [
  [/oxygen/, "Oxygen supply running out"],
  [/dialysis/, "Dialysis access needed"],
  [/insulin/, "Insulin lost after tornado"],
  [/chest pains/, "Chest pains after tornado"],
  [/contractions/, "Pregnancy emergency"],
  [/newborn/, "Newborn without supplies"],
  [/\ber\b|ambulance|broken|hit (my|their) head|throwing up|stitches/, "Injury after tornado"],
  [/gone|nothing left|flattened|foundation/, "Home destroyed by tornado"],
  [/cant stay|wrecked|out of the house|collapsed|torn open/, "Home not livable"],
  [/tree came|roof is peeled|leaking|water getting|flooded/, "Storm damage letting water in"],
  [/totaled|thrown|every window in/, "Vehicle damaged by tornado"],
  [/shingles|fence|hail|window|trampoline/, "Minor storm damage"],
  [/its bad|need help|messed up|got hit/, "Needs help, details unclear"],
];

function tornadoSubject(messages: string[]): string {
  const text = messages.join(" ").toLowerCase().replace(/['’]/g, "");
  return TORNADO_SUBJECTS.find(([re]) => re.test(text))?.[1] ?? "Safe after tornado";
}

function tornadoClaim(p: Persona, truth: WorldTruth): Claim {
  const checkInAgo = Math.round(SNAPSHOT_MINUTE - truth.impactAt - 1);
  const checkIn: ClaimMessage = { id: "check-in", from: "note", text: `Tornado check-in texted to ${p.phone} ${ageLabel(checkInAgo)} ago`, minutesAgo: checkInAgo };

  if (!truth.replyTimes.length) {
    const agent = AGENTS.find((a) => a.id === p.agentId);
    return {
      id: p.id,
      number: claimNumber(p.id),
      persona: p,
      subject: "No reply to tornado check-in",
      peril: "Tornado",
      body: [],
      minutesAgo: checkInAgo,
      thread: [
        checkIn,
        { id: "second", from: "note", text: `Second check-in sent ${ageLabel(checkInAgo - 29)} ago`, minutesAgo: checkInAgo - 29 },
        { id: "welfare", from: "note", text: `Escalated to ${agent?.name ?? "the local agent"} for a welfare call ${ageLabel(checkInAgo - 59)} ago`, minutesAgo: checkInAgo - 59 },
      ],
      silent: true,
      quick: silentRead(p, truth.intensity, checkInAgo, ageLabel(checkInAgo)),
    };
  }

  const messages = truth.messages.map((text, i) => ({ text, minutesAgo: Math.max(1, Math.round(SNAPSHOT_MINUTE - truth.replyTimes[i])) }));
  const minutesAgo = messages.at(-1)!.minutesAgo;
  const body = messages.map((m) => m.text);
  const homeFirst = p.policies.some((x) => x.line === "home") || p.housing === "rent";
  return {
    id: p.id,
    number: claimNumber(p.id),
    persona: p,
    subject: tornadoSubject(body),
    peril: "Tornado",
    body,
    minutesAgo,
    thread: [checkIn, ...messages.map((m, i) => ({ id: `m${i}`, from: "policyholder" as const, text: m.text, minutesAgo: m.minutesAgo }))],
    silent: false,
    quick: quickRead(body, p, minutesAgo, homeFirst ? ["home"] : ["auto"]),
  };
}

export function buildClaims(personas: Persona[] = getPersonas()): Claim[] {
  const truths = new Map(simulateCatastrophe(personas, TORNADO).map((t) => [t.personaId, t]));
  return personas.map((p) => {
    const truth = truths.get(p.id);
    return truth ? tornadoClaim(p, truth) : everydayClaim(p, createRng(hash(`everyday:${p.id}`)));
  });
}
