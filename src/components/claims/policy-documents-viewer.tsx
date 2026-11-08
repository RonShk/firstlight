"use client";

import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import type { Persona, PolicyLine } from "@/types/sim";
import type { SelectedDocument } from "@/types/claims";
import { cn } from "@/lib/utils";
import { UMBRELLA_OVERVIEW } from "@/lib/claims/policy-documents";

const TITLE: Record<PolicyLine, string> = { auto: "Auto Insurance Policy", home: "Homeowners Insurance Policy", umbrella: "Personal Liability Umbrella Policy" };
const NAV_LABEL: Record<PolicyLine, string> = { auto: "Auto policy", home: "Homeowners policy", umbrella: "Umbrella policy" };

const pagesLabel = (n: number) => `${n} ${n === 1 ? "page" : "pages"}`;

function FormText() {
  return (
    <div className="space-y-4 text-[15.5px] leading-[24px] text-ink">
      <p>{UMBRELLA_OVERVIEW.intro}</p>
      <h3 className="pt-2 text-[16px] font-semibold">What a Personal Liability Umbrella Policy Provides</h3>
      <ul className="list-disc space-y-1.5 pl-5">{UMBRELLA_OVERVIEW.provides.map((t) => <li key={t}>{t}</li>)}</ul>
      <h3 className="pt-2 text-[16px] font-semibold">How a Personal Liability Umbrella Policy Can Help</h3>
      {UMBRELLA_OVERVIEW.examples.map(([label, text]) => <p key={label}><span className="font-semibold">{label}.</span> {text}</p>)}
      <p className="pt-2 text-[13.5px] leading-[20px] text-subtle">{UMBRELLA_OVERVIEW.disclosure}</p>
    </div>
  );
}

interface ViewerProps {
  persona: Persona;
  documents: SelectedDocument[];
  target: { docId?: string; page?: number | null } | null;
  onClose: () => void;
}

function ViewerBody({ persona, documents, target, onClose }: ViewerProps & { target: NonNullable<ViewerProps["target"]> }) {
  const [activeId, setActiveId] = useState(target.docId ?? documents[0].form.id);
  const doc = documents.find((d) => d.form.id === activeId) ?? documents[0];
  const page = doc.form.id === target.docId ? target.page : null;
  const src = `/api/policy-documents/${doc.form.id}`;

  return (
    <>
      <div className="flex h-[58px] shrink-0 items-center justify-between border-b border-line px-[22px]">
        <div className="min-w-0">
          <Dialog.Title className="truncate text-[17px] leading-tight font-semibold text-ink">{TITLE[doc.line]}</Dialog.Title>
          <Dialog.Description className="truncate text-[14px] text-subtle">{persona.name} · Policy {doc.policy.id} · {pagesLabel(doc.form.pages)}</Dialog.Description>
        </div>
        <div className="flex shrink-0 items-center gap-6">
          {doc.form.hasPdf ? <a href={`${src}?download=1`} className="text-[15.5px] font-semibold text-ink hover:underline">Download PDF</a> : null}
          <button type="button" onClick={onClose} aria-label="Close" className="cursor-pointer text-ink-2 hover:text-ink"><X className="size-5" strokeWidth={1.5} /></button>
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav className="thin-scroll w-[300px] shrink-0 overflow-y-auto border-r border-line pt-[22px]">
          <p className="mb-2 px-[22px] text-[14px] font-semibold text-subtle">Applies to this claim</p>
          {documents.map((d) => (
            <button key={d.form.id} type="button" onClick={() => setActiveId(d.form.id)} aria-current={d === doc || undefined} className={cn("block w-full cursor-pointer px-[22px] py-[14px] text-left", d === doc ? "bg-soft" : "hover:bg-[#fafafa]")}>
              <span className="block text-[15.5px] font-semibold text-ink">{NAV_LABEL[d.line]}</span>
              <span className="block text-[14px] text-subtle">Policy {d.policy.id} · {pagesLabel(d.form.pages)}</span>
              <span className="mt-0.5 block text-[13.5px] text-subtle">{d.form.name} · Best fit: {d.why}</span>
            </button>
          ))}
        </nav>

        {doc.form.hasPdf ? (
          <iframe key={`${doc.form.id}:${page ?? 1}`} src={`${src}#page=${page ?? 1}&navpanes=0`} title={doc.form.name} className="h-full min-w-0 flex-1 bg-canvas" />
        ) : (
          <div className="thin-scroll min-w-0 flex-1 overflow-y-auto bg-canvas px-8 py-[30px]">
            <article className="mx-auto max-w-[737px] bg-white px-[57px] py-[42px] shadow-sm">
              <h1 className="mb-5 text-[24px] leading-tight font-bold text-ink">{doc.form.name}</h1>
              <FormText />
            </article>
          </div>
        )}
      </div>
    </>
  );
}

export function PolicyDocumentsViewer(props: ViewerProps) {
  const { target, documents, onClose } = props;
  return (
    <Dialog.Root open={!!target && documents.length > 0} onOpenChange={(open) => { if (!open) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Popup className="fixed inset-0 z-50 flex flex-col bg-white outline-none">
          {target && documents.length ? <ViewerBody {...props} target={target} /> : null}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
