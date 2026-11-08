// GET /api/policy-documents/{docId} -> the policy form PDF. ?download=1 saves it instead of showing it.

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { NextRequest } from "next/server";
import { DOCUMENT_FORMS } from "@/lib/claims/policy-documents";

export async function GET(req: NextRequest, ctx: RouteContext<"/api/policy-documents/[docId]">) {
  const { docId } = await ctx.params;
  // Own-property lookup: docId comes from the URL and also builds the file path below.
  const form = Object.hasOwn(DOCUMENT_FORMS, docId) ? DOCUMENT_FORMS[docId] : undefined;
  if (!form?.hasPdf) return Response.json({ error: "no such policy document" }, { status: 404 });

  let pdf: Buffer;
  try { pdf = await readFile(path.join(process.cwd(), "data", "policies", "raw", `${form.id}.pdf`)); } catch { return Response.json({ error: "Policy PDF unavailable" }, { status: 404 }); }
  const disposition = req.nextUrl.searchParams.has("download") ? "attachment" : "inline";
  return new Response(new Uint8Array(pdf), {
    headers: { "Content-Type": "application/pdf", "Content-Disposition": `${disposition}; filename="${form.id}.pdf"` },
  });
}
