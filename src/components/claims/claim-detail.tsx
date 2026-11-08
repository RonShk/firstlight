"use client";

import type { ClaimView } from "@/types/claims";
import { AGENTS } from "@/lib/sim/data";
import { HOUSEHOLD_LABELS } from "@/lib/sim/personas";

export function SituationView({ claim }: { claim: ClaimView }) {
  const p = claim.persona;
  const localAgent = AGENTS.find((a) => a.id === p.agentId);
  const adults = p.members.filter((m) => m.age >= 18).length;
  const children = p.members.length - adults;
  return <section className="space-y-7 p-7">
    <div><h2 className="text-xl font-semibold">Household situation</h2><p className="mt-2 max-w-3xl text-sm leading-relaxed text-subtle">{p.name} is part of a {HOUSEHOLD_LABELS[p.householdType].toLowerCase()} household in {p.address.city}, {p.address.state}. The household has {adults} {adults === 1 ? "adult" : "adults"}{children ? ` and ${children} ${children === 1 ? "child" : "children"}` : ""}. They {p.housing === "own" ? "own their home" : "rent their home"}. {p.selfEmployed ? `${p.name} is self-employed.` : `Occupation: ${p.occupation}.`}</p></div>
    <div className="grid gap-4 lg:grid-cols-3">{[["Household", HOUSEHOLD_LABELS[p.householdType]], ["Housing", p.housing === "own" ? "Homeowner" : "Renter"], ["Occupation", p.occupation]].map(([label, value]) => <article key={label} className="rounded-xl border border-line bg-soft/50 p-5"><h3 className="text-xs text-subtle">{label}</h3><p className="mt-2 font-semibold">{value}</p></article>)}</div>
    <div><h3 className="font-semibold">People in the household</h3><div className="mt-3 grid gap-3 xl:grid-cols-2">{p.members.map((m, i) => <article key={`${p.id}:member:${i}`} className="rounded-xl border border-line p-5"><h4 className="font-semibold">{m.name}</h4><p className="mt-1 text-sm text-subtle">{m.age} years old · {m.relation}</p>{(m.medicalNeeds || m.limitedMobility) && <p className="mt-3 text-sm text-high-ink">{[m.medicalNeeds, m.limitedMobility ? "Limited mobility" : null].filter(Boolean).join(" · ")}</p>}</article>)}</div></div>
    {p.vulnerabilities.length > 0 && <div className="rounded-xl border border-high/30 bg-high-soft/40 p-5"><h3 className="font-semibold">Support considerations</h3><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{p.vulnerabilities.map((v, i) => <li key={`${p.id}:flag:${i}`}>{v}</li>)}</ul></div>}
    <div className="grid gap-4 lg:grid-cols-2"><article className="rounded-xl border border-line p-5"><h3 className="font-semibold">Contact & location</h3><p className="mt-2 text-sm">{p.phone}</p><p className="mt-1 text-sm text-subtle">{p.address.street}<br />{p.address.city}, {p.address.state} {p.address.zip}</p></article><article className="rounded-xl border border-line p-5"><h3 className="font-semibold">Local agent</h3><p className="mt-2 text-sm">{localAgent?.name ?? "Not assigned"}</p><p className="mt-1 text-sm text-subtle">{localAgent?.city}{localAgent ? ` · ${localAgent.phone}` : ""}</p></article></div>
  </section>;
}
