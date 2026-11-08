// Citations point at a document, page, section and an exact passage. A quote counts only if it
// appears verbatim (after whitespace/punctuation normalization) in a chunk the agent retrieved.

export interface Citation {
  chunk_id: string;
  doc_id: string;
  form_number: string;
  section: string;
  page: number | null;
  quote: string;
  url: string;
}

export const MIN_QUOTE_CHARS = 20;

export function normalizeText(s: string): string {
  return s.toLowerCase()
    // Quote marks carry no meaning for matching and PDFs/models disagree on them ("x" vs 'x' vs “x”).
    .replace(/[‘’“”"']/g, "").replace(/[–—]/g, "-")
    .replace(/(\w)- (\w)/g, "$1$2")
    .replace(/[^a-z0-9$%-]+/g, " ")
    .replace(/\s+/g, " ").trim();
}

/** True when quote is a verbatim (normalized) substring of text. Ellipses split a quote into parts that must each match in order. */
export function quoteAppears(text: string, quote: string): boolean {
  const haystack = normalizeText(text);
  let from = 0;
  const parts = quote.split(/\.{3}|…/).map(normalizeText).filter(Boolean);
  if (!parts.length || parts.join(" ").length < MIN_QUOTE_CHARS) return false;
  for (const part of parts) {
    const at = haystack.indexOf(part, from);
    if (at < 0) return false;
    from = at + part.length;
  }
  return true;
}

/** Link that opens the policy PDF at the cited page. */
export function documentUrl(docId: string, page: number | null): string {
  return `/api/policies?form=${encodeURIComponent(docId)}${page ? `#page=${page}` : ""}`;
}
