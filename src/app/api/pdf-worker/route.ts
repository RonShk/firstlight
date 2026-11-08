import { readFile } from "node:fs/promises";
import path from "node:path";

export async function GET() {
  const worker = await readFile(path.join(process.cwd(), "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"));
  return new Response(worker, { headers: { "Content-Type": "text/javascript", "Cache-Control": "public, max-age=3600" } });
}
