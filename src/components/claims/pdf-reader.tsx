"use client";

import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";

function PolicyPage({ pdf, number, root, ratio }: { pdf: PDFDocumentProxy; number: number; root: React.RefObject<HTMLDivElement | null>; ratio: number }) {
  const host = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { root: root.current, rootMargin: "900px" });
    observer.observe(host.current!);
    return () => observer.disconnect();
  }, [root]);
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let task: RenderTask | undefined;
    const element = canvas.current!;
    pdf.getPage(number).then(async (p) => {
      if (disposed) return;
      const base = p.getViewport({ scale: 1 });
      host.current!.style.aspectRatio = `${base.width} / ${base.height}`;
      const width = Math.min(1100, Math.max(200, (root.current?.clientWidth ?? 900) - 32));
      const viewport = p.getViewport({ scale: width / base.width * Math.min(window.devicePixelRatio || 1, 2) });
      element.width = viewport.width; element.height = viewport.height;
      task = p.render({ canvas: element, viewport });
      await task.promise;
    }).catch((e: Error) => { if (!disposed) setError(e.message); });
    return () => { disposed = true; task?.cancel(); element.width = 1; element.height = 1; };
  }, [pdf, number, root, visible]);
  return <div ref={host} data-page-number={number} style={{ aspectRatio: ratio }} className="relative mx-auto mb-4 w-full max-w-[1100px] bg-white shadow-sm">
    <canvas ref={canvas} aria-label={`Policy page ${number}`} className="block h-full w-full" />
    {error && <p role="alert" className="absolute inset-0 bg-white p-6 text-sm">Could not render page {number}: {error}</p>}
  </div>;
}

/** Full-screen continuous document with lazy rendering and one small page/close control. */
export function PdfReader({ docId, initialPage = 1, onClose }: { docId: string; initialPage?: number; onClose: () => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(initialPage);
  const [ratio, setRatio] = useState(0.77);
  const [error, setError] = useState<string | null>(null);
  const url = `/api/policy-documents/${encodeURIComponent(docId)}`;
  useEffect(() => {
    let disposed = false;
    let task: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
    import("pdfjs-dist").then(async (lib) => {
      if (disposed) return;
      lib.GlobalWorkerOptions.workerSrc = "/api/pdf-worker";
      task = lib.getDocument({ url });
      const document = await task.promise;
      const first = await document.getPage(1);
      if (disposed) return;
      const viewport = first.getViewport({ scale: 1 });
      setRatio(viewport.width / viewport.height); setPdf(document);
    }).catch((e: Error) => { if (!disposed) setError(e.message); });
    return () => { disposed = true; void task?.destroy(); };
  }, [url]);
  useEffect(() => {
    if (!pdf || !scroll.current) return;
    const target = Math.max(1, Math.min(initialPage, pdf.numPages));
    const el = scroll.current.querySelector<HTMLElement>(`[data-page-number="${target}"]`);
    if (el) scroll.current.scrollTop += el.getBoundingClientRect().top - scroll.current.getBoundingClientRect().top - 16;
  }, [pdf, initialPage]);
  const updatePage = () => {
    const root = scroll.current;
    if (!root) return;
    const line = root.getBoundingClientRect().top + root.clientHeight * 0.35;
    const current = [...root.querySelectorAll<HTMLElement>("[data-page-number]")].find((el) => el.getBoundingClientRect().bottom > line);
    if (current) setPage(Number(current.dataset.pageNumber));
  };
  return <div className="relative h-full bg-[#e8e8e8]">
    <div className="absolute top-3 left-1/2 z-10 flex -translate-x-1/2 items-center gap-3 rounded-md border border-black/10 bg-white/95 px-3 py-1.5 text-xs shadow-sm"><span aria-live="polite">Page {page} / {pdf?.numPages ?? "…"}</span><button autoFocus onClick={onClose} aria-label="Close policy" className="cursor-pointer px-1 text-lg leading-none">×</button></div>
    <div ref={scroll} aria-label="Policy document" onScroll={updatePage} className="h-full overflow-auto px-4 py-4">{error ? <p role="alert" className="mx-auto mt-14 max-w-lg rounded bg-white p-5 text-sm">Could not load this document. <a className="text-brand underline" href={url} target="_blank" rel="noreferrer">Open PDF</a></p> : !pdf ? <p role="status" className="mt-14 text-center text-sm text-subtle">Loading document…</p> : Array.from({ length: pdf.numPages }, (_, i) => <PolicyPage key={i} pdf={pdf} number={i + 1} root={scroll} ratio={ratio} />)}</div>
  </div>;
}
