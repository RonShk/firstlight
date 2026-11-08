"use client";

import { useEffect, useRef } from "react";
import { DOCUMENT_FORMS, UMBRELLA_OVERVIEW } from "@/lib/claims/policy-documents";
import { PdfReader } from "./pdf-reader";

export function PolicyOverlay({ target, onClose }: { target: { docId: string; page: number | null }; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = DOCUMENT_FORMS[target.docId];
  useEffect(() => {
    const el = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    el.showModal();
    return () => { el.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="policy-viewer-title" onCancel={onClose} className="fixed inset-0 m-0 h-dvh max-h-none w-screen max-w-none border-0 bg-white p-0 text-ink">
    <h2 id="policy-viewer-title" className="sr-only">{form?.name ?? target.docId}</h2>
    {form?.hasPdf ? <PdfReader key={`${target.docId}:${target.page ?? 1}`} docId={target.docId} initialPage={target.page ?? 1} onClose={onClose} /> : <>
      <div className="fixed top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-md border border-line bg-white px-3 py-1.5 text-xs shadow-sm"><span>Page 1 / 1</span><button autoFocus onClick={onClose} aria-label="Close policy" className="cursor-pointer px-1 text-lg">×</button></div>
      {form ? <article className="mx-auto h-full max-w-3xl space-y-4 overflow-auto px-8 pt-16 pb-8 text-base leading-relaxed"><p>{UMBRELLA_OVERVIEW.intro}</p>{UMBRELLA_OVERVIEW.provides.map((p) => <p key={p}>{p}</p>)}<p className="text-sm text-subtle">{UMBRELLA_OVERVIEW.disclosure}</p></article> : <p className="p-16">This policy document is unavailable.</p>}
    </>}
  </dialog>;
}
