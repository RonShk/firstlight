import { readFile } from "node:fs/promises";
import path from "node:path";
import { FORMS_BY_ID } from "@/lib/sim/data";

export async function GET(request: Request) {
  const form = new URL(request.url).searchParams.get("form") ?? "";
  if (!Object.hasOwn(FORMS_BY_ID, form) || form === "SF-UMB-WEB") {
    return Response.json({ error: "Policy PDF not found" }, { status: 404 });
  }
  try {
    const pdf = await readFile(path.join(process.cwd(), "data/policies/raw", `${form}.pdf`));
    return new Response(pdf, { headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${form}.pdf"`,
      "X-Content-Type-Options": "nosniff",
    } });
  } catch {
    return Response.json({ error: "Policy PDF unavailable" }, { status: 404 });
  }
}
