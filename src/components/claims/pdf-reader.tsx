"use client";

import { useEffect, useRef, useState } from "react";

/** Render PDFs in the app so embedded-browser PDF support is not required. */
export function PdfReader({ docId, initialPage = 1 }: { docId: string; initialPage?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [page, setPage] = useState(initialPage);
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pdf, setPdf] = useState<import("pdfjs-dist").PDFDocumentProxy | null>(null);
  const url = `/api/policy-documents/${encodeURIComponent(docId)}`;
  useEffect(() => {
    let disposed = false;
    let task: import("pdfjs-dist").PDFDocumentLoadingTask | undefined;
    import("pdfjs-dist").then(async (lib) => {
      if (disposed) return;
      lib.GlobalWorkerOptions.workerSrc = "/api/pdf-worker";
      task = lib.getDocument({ url });
      const doc = await task.promise;
      if (disposed) return;
      setPages(doc.numPages); setPage(Math.max(1, Math.min(initialPage, doc.numPages))); setPdf(doc);
    }).catch((e: Error) => { if (!disposed) { setError(e.message); setLoading(false); } });
    return () => { disposed = true; void task?.destroy(); };
  }, [url, initialPage]);
  useEffect(() => {
    if (!pdf) return;
    let disposed = false;
    let render: import("pdfjs-dist").RenderTask | undefined;
    pdf.getPage(page).then(async (p) => {
      if (disposed || !canvas.current) return;
      setLoading(true); setError(null);
      const element = canvas.current;
      const viewport = p.getViewport({ scale: 1.3 * zoom });
      const ratio = window.devicePixelRatio || 1;
      element.width = viewport.width * ratio; element.height = viewport.height * ratio;
      element.style.width = `${viewport.width}px`; element.style.height = `${viewport.height}px`;
      render = p.render({ canvas: element, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      await render.promise;
      if (!disposed) setLoading(false);
    }).catch((e: Error) => { if (!disposed) { setError(e.message); setLoading(false); } });
    return () => { disposed = true; render?.cancel(); };
  }, [pdf, page, zoom]);
  return <div className="overflow-hidden rounded-xl border border-line bg-soft">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line bg-white px-4 py-3 text-sm">
      <div className="flex items-center gap-3"><button disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)} className="cursor-pointer disabled:opacity-30">Previous</button><span>Page {page} of {pages || "…"}</span><button disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)} className="cursor-pointer disabled:opacity-30">Next</button><select aria-label="PDF zoom" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} className="rounded border border-line p-1"><option value={0.7}>70%</option><option value={1}>100%</option><option value={1.3}>130%</option></select></div>
      <div className="flex gap-4 font-semibold text-brand"><a href={`${url}#page=${page}`} target="_blank" rel="noreferrer">Open PDF ↗</a><a href={`${url}?download=1`}>Download</a></div>
    </div>
    {loading && <p role="status" className="px-5 py-3 text-sm text-subtle">Loading policy page…</p>}
    {error && <p role="alert" className="p-5 text-sm text-critical-ink">Could not render this document. {error} Use Open PDF or Download above.</p>}
    <div className="max-h-[75vh] overflow-auto p-4"><canvas ref={canvas} aria-label={`${docId}, page ${page}`} className="mx-auto max-w-none bg-white shadow-sm" /></div>
  </div>;
}
