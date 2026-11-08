// Policy documents for RAG: manifest parsing, chunking, and the on-disk index.
// The documents are hand-supplied files in data/policies/raw/ and are treated as one generic
// state: every form of a line is equally applicable to every customer.

import { readFileSync } from "node:fs";
import path from "node:path";

export const POLICY_LINES = ["home", "auto", "umbrella"] as const;
export type PolicyLine = (typeof POLICY_LINES)[number];

export interface ManifestEntry {
  doc_id: string;
  line: PolicyLine;
  policy_type: string;
  form_number: string;
  state: string;
  persona_fit: string;
  source_type: string;
}

export interface PolicyChunk {
  chunk_id: string;
  doc_id: string;
  line: PolicyLine;
  form_number: string;
  state: string; // source tag only; never used to filter or shown to the model
  policy_type: string;
  page: number | null;
  section: string;
  text: string;
  embedding?: number[];
}

export interface PolicyIndex {
  built_at: string;
  embed_model: string | null; // null = no embeddings; retrieval falls back to lexical search
  documents: { doc_id: string; status: "indexed" | "missing"; chunks: number }[];
  chunks: PolicyChunk[];
}

const DATA_DIR = path.join(process.cwd(), "data");
export const MANIFEST_PATH = path.join(DATA_DIR, "policies", "manifest.csv");
export const RAW_DIR = path.join(DATA_DIR, "policies", "raw");
export const INDEX_PATH = path.join(DATA_DIR, "policy_index.json");

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (ch === "," && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseManifest(csv: string): ManifestEntry[] {
  const [header, ...rows] = csv.trim().split(/\r?\n/);
  const cols = parseCsvLine(header);
  return rows.map((row) => {
    const values = parseCsvLine(row);
    const rec = Object.fromEntries(cols.map((c, i) => [c, values[i] ?? ""]));
    if (!POLICY_LINES.includes(rec.line as PolicyLine)) {
      throw new Error(`manifest row ${rec.doc_id}: unknown line ${rec.line}`);
    }
    return rec as unknown as ManifestEntry;
  });
}

// --- chunking ---------------------------------------------------------------------------------

const SECTION_WORDS =
  /\b(SECTION|COVERAGES?|DEFINITIONS|CONDITIONS|EXCLUSIONS|LOSSES|AGREEMENT|DEDUCTIBLES?|PROVISIONS|ENDORSEMENTS?|INSURING|LIMITS|THIS POLICY|REPORTING A CLAIM|GENERAL TERMS)\b/;

const isAllCaps = (l: string) => /[A-Z]{3}/.test(l) && l === l.toUpperCase();

/**
 * A heading is a short all-caps line naming a policy part. Auto policies also set whole exclusion
 * clauses in capitals, so a line that continues an all-caps or hyphenated line, or that carries
 * clause punctuation, is not a heading.
 */
const ONE_WORD_HEADINGS = new Set(["DEFINITIONS", "AGREEMENT", "DEDUCTIBLE", "EXCLUSIONS", "CONDITIONS"]);

export function isHeading(line: string, prevLine = ""): boolean {
  const l = line.trim().replace(/\.$/, "");
  const prev = prevLine.trim();
  if (ONE_WORD_HEADINGS.has(l)) return true;
  return (
    l.length >= 8 &&
    l.length <= 60 &&
    isAllCaps(l) &&
    l.split(/\s+/).length >= 2 &&
    SECTION_WORDS.test(l) &&
    !/^[\d(]/.test(l) &&
    !/[,.;:]/.test(l) &&
    !/[-–]$|\b(OR|AND|TO|OF|THE|FOR|DO|BY|IN)$/.test(l) &&
    !(prev && (prev.endsWith("-") || (isAllCaps(prev) && !/[.:]$/.test(prev) && !isHeading(prev))))
  );
}

const NOISE = /^(\d+\s+[A-Z0-9-]+|©.*|.*Copyright.*|\d+)$|\.{4,}/; // page headers, copyright, page numbers, table-of-contents leaders

/** Join wrapped lines, healing words hyphenated across a line break. */
function joinLines(lines: string[]): string {
  return lines
    .reduce((acc, l) => (acc.endsWith("-") && /^[a-z]/.test(l) ? acc.slice(0, -1) + l : `${acc} ${l}`), "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface ChunkOptions {
  targetChars?: number;
  overlapLines?: number;
  defaultSection?: string;
}

/** Split page texts into section-aware chunks of roughly targetChars. */
export function chunkPages(
  pages: string[],
  meta: Omit<PolicyChunk, "chunk_id" | "page" | "section" | "text" | "embedding">,
  { targetChars = 1100, overlapLines = 2, defaultSection = "General" }: ChunkOptions = {},
): PolicyChunk[] {
  const chunks: PolicyChunk[] = [];
  let top = ""; // a "SECTION ..." heading
  let section = defaultSection;
  let buf: string[] = [];
  let hasBody = false;
  let bufPage: number | null = null;
  let bufSection = section;

  const flush = (carry: boolean) => {
    const text = joinLines(buf);
    if (text.length >= 80) {
      chunks.push({ ...meta, chunk_id: `${meta.doc_id}#${chunks.length}`, page: bufPage,
                    section: bufSection, text });
    }
    buf = carry ? buf.slice(-overlapLines) : [];
    hasBody = carry && buf.length > 0;
  };

  let prev = "";
  pages.forEach((pageText, i) => {
    for (const raw of pageText.split("\n")) {
      const line = raw.trim();
      if (!line || NOISE.test(line)) continue;
      const heading = isHeading(line, prev);
      prev = line;
      if (heading) {
        if (hasBody) flush(false);
        const name = line.replace(/\.$/, "");
        if (name.startsWith("SECTION")) top = name;
        section = top && name !== top && name.startsWith("COVERAGE") ? `${top} > ${name}` : name;
        if (!name.startsWith("SECTION") && !name.startsWith("COVERAGE")) top = "";
        bufSection = section; // consecutive headings: label with the most specific one
      } else {
        hasBody = true;
      }
      if (!buf.length) {
        bufPage = pages.length > 1 ? i + 1 : null;
        bufSection = section;
      }
      buf.push(line);
      if (buf.join(" ").length >= targetChars) flush(true);
    }
  });
  if (buf.length) flush(false);
  return chunks;
}

/** Visible text of an HTML page, one block per line. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|section|br)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&reg;/g, "®")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 2)
    .join("\n");
}

// --- index ----------------------------------------------------------------------------------

let cached: PolicyIndex | null = null;

export function loadPolicyIndex(): PolicyIndex {
  // Statically scoped path so Next.js traces only data/, not the whole project.
  cached ??= JSON.parse(readFileSync(path.join(process.cwd(), "data", "policy_index.json"), "utf8")) as PolicyIndex;
  return cached;
}
