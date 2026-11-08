/**
 * Downloads every policy form in the RAG manifest and saves plain text to
 * data/policies/<doc_id>.txt for the agent's policy search.
 *   npm run policies
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { extractText, getDocumentProxy } from "unpdf";
import { POLICY_FORMS } from "../src/lib/sim/data";

const UA = { "User-Agent": "Mozilla/5.0 (Macintosh) NoOneLeftBehind/0.1" };

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|section|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

async function main() {
  mkdirSync("data/policies", { recursive: true });
  for (const form of POLICY_FORMS) {
  try {
    const res = await fetch(form.url, { headers: UA, redirect: "follow" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get("content-type") ?? "";
    let text: string;
    if (type.includes("pdf") || form.url.endsWith(".pdf")) {
      const pdf = await getDocumentProxy(new Uint8Array(await res.arrayBuffer()));
      const { text: pages } = await extractText(pdf, { mergePages: false });
      text = (pages as string[]).map((p, i) => `[page ${i + 1}]\n${p}`).join("\n\n");
    } else {
      text = htmlToText(await res.text());
    }
    writeFileSync(`data/policies/${form.id}.txt`, text);
    console.log(`✓ ${form.id.padEnd(14)} ${String(text.length).padStart(7)} chars`);
  } catch (err) {
    console.log(`✗ ${form.id.padEnd(14)} ${(err as Error).message}`);
  }
}
}

main();
