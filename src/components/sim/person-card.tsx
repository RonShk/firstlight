"use client";

import { Dialog } from "@base-ui/react/dialog";
import { Car, HeartPulse, Home, Phone, Shield, Umbrella, User, X } from "lucide-react";
import type { Persona, Policy } from "@/types/sim";
import { Button } from "@/components/ui/button";
import { AGENTS, FORMS_BY_ID } from "@/lib/sim/data";
import { HOUSEHOLD_LABELS, totalInsuredValue } from "@/lib/sim/personas";
import { money } from "@/lib/sim/status";

const AGENT_BY_ID = Object.fromEntries(AGENTS.map((a) => [a.id, a]));

const RELATION_LABEL = { self: "Policyholder", spouse: "Spouse", child: "Child", parent: "Parent" } as const;
const LINE_ICON = { home: Home, auto: Car, umbrella: Umbrella } as const;
const LINE_LABEL = { home: "Home", auto: "Auto", umbrella: "Umbrella" } as const;

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-[10px] font-medium tracking-wider text-muted-foreground uppercase">{title}</h3>
      {children}
    </section>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] text-muted-foreground">{label}</dt>
      <dd className="truncate text-xs">{value}</dd>
    </div>
  );
}

function PolicyBlock({ policy }: { policy: Policy }) {
  const Icon = LINE_ICON[policy.line];
  const form = FORMS_BY_ID[policy.formId];
  return (
    <div className="rounded-lg bg-white/[0.03] p-3 ring-1 ring-white/[0.06]">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <Icon className="size-3.5 text-muted-foreground" />
          {LINE_LABEL[policy.line]} · <span className="font-mono text-[11px] text-muted-foreground">{policy.id}</span>
        </span>
        <span className="text-[11px] text-muted-foreground tabular-nums">{money(policy.premiumAnnual)}/yr</span>
      </div>
      <p className="mb-2 text-[11px] text-muted-foreground">
        {form ? `${form.name} (${form.formNumber}, ${form.state})` : policy.formId}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
        {policy.home ? (
          <>
            <Field label="Dwelling" value={money(policy.home.dwelling)} />
            <Field label="Personal property" value={money(policy.home.personalProperty)} />
            <Field label="Loss of use" value={money(policy.home.lossOfUse)} />
            <Field label="Deductible" value={money(policy.home.deductible)} />
            <Field label="Wind/hail deductible" value={money(policy.home.windHailDeductible)} />
          </>
        ) : null}
        {policy.auto ? (
          <>
            <Field label="Liability" value={policy.auto.liability} />
            <Field label="Collision deductible" value={money(policy.auto.collisionDeductible)} />
            <Field label="Comprehensive deductible" value={money(policy.auto.comprehensiveDeductible)} />
          </>
        ) : null}
        {policy.umbrellaLimit ? <Field label="Umbrella limit" value={money(policy.umbrellaLimit)} /> : null}
      </dl>
      {policy.auto?.vehicles.length ? (
        <ul className="mt-2 space-y-0.5 text-[11px]">
          {policy.auto.vehicles.map((v, i) => (
            <li key={i} className="flex justify-between gap-2">
              <span>
                {v.year} {v.make} {v.model}
              </span>
              <span className="text-muted-foreground tabular-nums">{money(v.value)}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** The policyholder's name; clicking it opens everything on file for them. */
export function PersonCard({ persona: p }: { persona: Persona }) {
  const agent = AGENT_BY_ID[p.agentId];
  return (
    <Dialog.Root>
      <Dialog.Trigger className="block max-w-full cursor-pointer truncate rounded-sm text-left font-medium underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/50">
        {p.name}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/60 backdrop-blur-sm transition-opacity data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup className="fixed top-1/2 left-1/2 z-50 flex max-h-[85vh] w-[calc(100vw-32px)] max-w-xl -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-2xl bg-card text-card-foreground shadow-2xl ring-1 ring-white/10 transition-all data-[ending-style]:scale-95 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[starting-style]:opacity-0">
          <div className="flex items-start justify-between gap-3 border-b border-white/5 px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-base font-semibold tracking-tight">{p.name}</Dialog.Title>
              <Dialog.Description className="text-xs text-muted-foreground">
                {HOUSEHOLD_LABELS[p.householdType]} · {p.members.length} {p.members.length === 1 ? "person" : "people"} · {p.housing === "own" ? "Owns" : "Rents"} · <span className="font-mono">{p.id}</span>
              </Dialog.Description>
            </div>
            <Dialog.Close render={<Button variant="ghost" size="icon-sm" aria-label="Close" />}>
              <X />
            </Dialog.Close>
          </div>

          <div className="thin-scroll space-y-5 overflow-y-auto px-5 py-4">
            {p.vulnerabilities.length ? (
              <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-200 ring-1 ring-amber-500/20">
                <HeartPulse className="mt-0.5 size-3.5 shrink-0" />
                <span>{p.vulnerabilities.join(" · ")}</span>
              </div>
            ) : null}

            <Section title="Contact">
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                <Field label="Phone" value={p.phone} />
                <Field label="Occupation" value={`${p.occupation}${p.selfEmployed ? " (self-employed)" : ""}`} />
                <Field label="Address" value={`${p.address.street}, ${p.address.city}, ${p.address.state} ${p.address.zip}`} />
                <Field label="Home value" value={p.homeValue ? money(p.homeValue) : "—"} />
                <Field label="Total insured value" value={money(totalInsuredValue(p))} />
                <Field label="Likely to reply" value={`${Math.round(p.responsiveness * 100)}%`} />
              </dl>
            </Section>

            <Section title="Household">
              <ul className="divide-y divide-white/5 rounded-lg ring-1 ring-white/[0.06]">
                {p.members.map((m, i) => (
                  <li key={i} className="flex items-start justify-between gap-3 px-3 py-2 text-xs">
                    <span className="flex min-w-0 items-start gap-2">
                      <User className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">
                        <span className="font-medium">{m.name}</span>
                        <span className="text-muted-foreground"> · {RELATION_LABEL[m.relation]}, {m.age}</span>
                        {m.medicalNeeds || m.limitedMobility ? (
                          <span className="block text-[11px] text-amber-300/90">
                            {[m.medicalNeeds, m.limitedMobility ? "Limited mobility" : null].filter(Boolean).join(" · ")}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>

            <Section title={`Policies (${p.policies.length})`}>
              {p.policies.length ? (
                <div className="space-y-2">
                  {p.policies.map((policy) => (
                    <PolicyBlock key={policy.id} policy={policy} />
                  ))}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">No policies on file.</p>
              )}
            </Section>

            {agent ? (
              <Section title="Local agent">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="flex items-center gap-2">
                    <Shield className="size-3.5 text-muted-foreground" />
                    {agent.name} · {agent.city}
                  </span>
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Phone className="size-3" />
                    {agent.phone}
                  </span>
                </div>
              </Section>
            ) : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
