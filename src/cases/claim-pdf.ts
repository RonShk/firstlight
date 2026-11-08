// Simulated State Farm first-notice-of-loss PDF. Layout follows the industry ACORD 1 Property Loss
// Notice (insured, contact, policy, coverages A-D with limits and deductibles, loss description) plus a
// Proof of Loss style statement block. Clearly marked as simulated: not a real State Farm document.
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import type { FiledClaim } from "./claim-files";

const RED = rgb(0.80, 0.09, 0.13);
const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.42, 0.42, 0.46);
const LINE = rgb(0.82, 0.82, 0.85);
const W = 612, H = 792, M = 48;

/** Standard PDF fonts only encode WinAnsi; replace what they cannot draw. */
const safe = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-").replace(/…/g, "...")
  .replace(/[•·]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "");
const usd = (n: number | null | undefined) => (n == null ? "-" : `$${n.toLocaleString("en-US")}`);
const STATUS: Record<string, string> = { covered: "Covered", not_covered: "Not covered", likely_covered: "Needs confirmation",
  likely_excluded: "Needs confirmation", unclear: "Needs confirmation", no_policy: "No policy on file" };

export async function claimPdf(claim: FiledClaim): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Property Loss Notice ${claim.id} (simulated)`);
  doc.setAuthor("Nightwatch claims agent (simulation)");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let page!: PDFPage;
  let y = 0;

  const newPage = () => {
    page = doc.addPage([W, H]);
    page.drawRectangle({ x: 0, y: H - 64, width: W, height: 64, color: RED });
    page.drawText("State Farm", { x: M, y: H - 38, size: 20, font: bold, color: rgb(1, 1, 1) });
    page.drawText("PROPERTY LOSS NOTICE - FIRST NOTICE OF LOSS", { x: M, y: H - 54, size: 8.5, font, color: rgb(1, 1, 1) });
    page.drawText(safe(`Claim ${claim.id}`), { x: W - M - bold.widthOfTextAtSize(`Claim ${claim.id}`, 12), y: H - 38, size: 12, font: bold, color: rgb(1, 1, 1) });
    page.drawText("SIMULATED DOCUMENT FOR DEMONSTRATION - NOT ISSUED BY STATE FARM", { x: M, y: 24, size: 7, font: bold, color: RED });
    page.drawText(`Page ${doc.getPageCount()}`, { x: W - M - 30, y: 24, size: 7, font, color: MUTED });
    y = H - 88;
  };
  const ensure = (h: number) => { if (y - h < 48) newPage(); };
  const wrap = (text: string, f: PDFFont, size: number, width: number) => {
    const out: string[] = [];
    for (const para of safe(text).split("\n")) {
      let line = "";
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(next, size) > width && line) { out.push(line); line = word; } else line = next;
      }
      out.push(line);
    }
    return out;
  };
  const text = (s: string, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; x?: number; width?: number; gap?: number } = {}) => {
    const size = o.size ?? 9.5, f = o.f ?? font, x = o.x ?? M, width = o.width ?? W - M - x;
    for (const line of wrap(s, f, size, width)) { ensure(size + 4); page.drawText(line, { x, y, size, font: f, color: o.color ?? INK }); y -= size + 3.5; }
    y -= o.gap ?? 2;
  };
  const section = (title: string) => {
    ensure(40); y -= 8;
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 17, color: rgb(0.95, 0.95, 0.96) });
    page.drawText(safe(title.toUpperCase()), { x: M + 6, y: y + 1, size: 8.5, font: bold, color: INK });
    y -= 22;
  };
  const fields = (rows: [string, string][], cols = 2) => {
    const colW = (W - 2 * M) / cols;
    for (let i = 0; i < rows.length; i += cols) {
      ensure(30);
      const heights = rows.slice(i, i + cols).map(([label, value], j) => {
        const x = M + j * colW;
        page.drawText(safe(label.toUpperCase()), { x, y, size: 6.5, font: bold, color: MUTED });
        const lines = wrap(value || "-", font, 9.5, colW - 10);
        lines.forEach((l, k) => page.drawText(l, { x, y: y - 12 - k * 12, size: 9.5, font, color: INK }));
        return 12 + lines.length * 12;
      });
      y -= Math.max(...heights) + 6;
    }
  };

  newPage();
  const c = claim.customer;
  const home = c.policies.find((p) => p.home);
  fields([["Date drafted", new Date(claim.filedAt).toLocaleString("en-US")], ["Claim status", { pending: "AWAITING CONFIRMATION", confirmed: "FILED", denied: "DENIED" }[claim.status]],
    ["Drafted by", claim.source === "auto" ? "Nightwatch agent (automatic)" : "Claims reviewer (manual)"], ["Severity (agent)", claim.severity == null ? "-" : `${claim.severity} / 100`]]);
  text(claim.basis, { size: 8.5, color: MUTED, gap: 4 });

  section("Insured");
  fields([["Name of insured", c.name], ["Phone", c.phone], ["Mailing / property address", c.address], ["Household", `${c.household}; ${c.housing}`],
    ["Local agent", c.local_agent ? `${c.local_agent.name}, ${c.local_agent.city} ${c.local_agent.phone}` : "Not assigned"],
    ["Members", c.members.map((m) => `${m.name} (${m.age})`).join(", ")]]);

  section("Loss");
  fields([["Date of loss", claim.incidentDate], ["Location of loss", claim.location], ["Kind of loss / cause", claim.cause],
    ["Police / fire department", "Not reported"]]);
  text("Description of loss and damage:", { f: bold, size: 8.5 });
  text(claim.summary, { gap: 6 });
  if (claim.reportedText.length) {
    text("Policyholder's own words:", { f: bold, size: 8.5 });
    for (const t of claim.reportedText) text(`"${t}"`, { size: 9, color: MUTED, x: M + 10 });
  }

  section("Policy and coverages");
  for (const p of c.policies) {
    fields([["Policy number", p.policy_id], ["Line / form", `${p.line.toUpperCase()} - ${p.form} (${p.form_number})`]]);
    // State Farm homeowners forms: A Dwelling (includes other structures), B Personal Property, C Loss of Use.
    if (p.home) fields([["A. Dwelling", usd(p.home.coverage_a_dwelling)], ["B. Personal property", usd(p.home.coverage_b_personal_property)],
      ["C. Loss of use", usd(p.home.coverage_c_loss_of_use)], ["Deductibles", `All perils ${usd(p.home.deductible_all_other_perils)}; wind/hail ${usd(p.home.deductible_wind_hail)}`]], 4);
    if (p.auto) fields([["Vehicles", p.auto.vehicles.map((v) => `${v.year} ${v.make} ${v.model}`).join(", ")], ["Liability", p.auto.liability_limits],
      ["Comprehensive deductible", usd(p.auto.comprehensive_deductible)], ["Collision deductible", usd(p.auto.collision_deductible)]], 4);
    if (p.umbrella_limit) fields([["Umbrella limit", usd(p.umbrella_limit)]], 2);
  }
  if (!home) text("No homeowners policy on file.", { color: MUTED });

  section("Coverage assessment (Nightwatch agent, Nemotron)");
  if (!claim.findings.length) text("No coverage findings were recorded before filing. An adjuster must assess coverage.", { color: MUTED });
  claim.findings.forEach((f, i) => {
    ensure(60);
    text(`${i + 1}. ${f.item}`, { f: bold, size: 10.5, gap: 0 });
    text(`${f.coverage}${f.policy_id ? ` - policy ${f.policy_id}` : ""} - ${STATUS[f.status] ?? f.status}`, { size: 8.5, color: f.status === "covered" ? rgb(0.1, 0.45, 0.2) : RED });
    text(f.explanation);
    for (const e of claim.evidence.filter((x) => x.finding === i)) {
      text(`Policy ${e.form_number}, ${e.section}${e.page ? `, page ${e.page}` : ""}:`, { size: 8, f: bold, color: MUTED, x: M + 10 });
      text(`"${e.quote.length > 420 ? `${e.quote.slice(0, 420)}...` : e.quote}"`, { size: 8.5, color: MUTED, x: M + 10, gap: 4 });
    }
  });

  section("Claim determination");
  if (claim.status === "pending") text("Drafted - awaiting human confirmation before the claim is filed.", { color: MUTED });
  else {
    fields([["Decision", claim.status === "confirmed" ? "CONFIRMED - CLAIM FILED" : "DENIED"], ["Decided", claim.decidedAt ? new Date(claim.decidedAt).toLocaleString("en-US") : "-"]]);
    if (claim.decisionNote) text(`Note: ${claim.decisionNote}`);
  }

  section("Statement of insured");
  text("The insured states that the information in this notice is true to the best of their knowledge, that the loss did not originate by any act, design or procurement on their part, and that no other insurance covers this loss except as listed above.", { size: 8.5, color: MUTED, gap: 18 });
  ensure(40);
  page.drawLine({ start: { x: M, y }, end: { x: M + 220, y }, color: LINE, thickness: 1 });
  page.drawLine({ start: { x: W - M - 160, y }, end: { x: W - M, y }, color: LINE, thickness: 1 });
  y -= 11;
  page.drawText("Signature of insured", { x: M, y, size: 7, font, color: MUTED });
  page.drawText("Date", { x: W - M - 160, y, size: 7, font, color: MUTED });
  return doc.save();
}
