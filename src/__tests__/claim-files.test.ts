// Claims: automatic and manual filing, adjuster decisions, exactly-once settlement, and the claim PDF.
import { it } from "node:test";
import assert from "node:assert/strict";
import { openOps } from "../cases/db";
import { receive } from "../cases/intake";
import { appendMessage } from "../cases/repository";
import { autoFileReady, claimFiles, decideClaim, draftFor, fileClaim } from "../cases/claim-files";
import { claimPdf } from "../cases/claim-pdf";
import type { Decision } from "../agent/schemas";

function fixture() {
  const db = openOps(":memory:");
  const intake = receive(db, { channel: "simulation", address: "sim:PH-0008", customerId: "PH-0008",
    turns: [{ role: "customer", text: "Hail damaged the roof." }] });
  const decision: Decision = {
    severity: 30, severity_reason: "Roof damage", immediate_danger: false, summary: "Hail damaged the roof.",
    reported_facts: ["Roof damage"], unknowns: [],
    findings: [{ item: "Roof", coverage: "Dwelling", policy_id: "HO-1", status: "covered", explanation: "Verified hail damage", citations: [] }],
    next_action: "reply", decision_reason: "Ready", reply: "Reviewed",
  };
  const save = (verified = true) => db.run("UPDATE runs SET status='completed',decision=? WHERE id=?",
    JSON.stringify({ decision, verified, citations: [] }), intake.run!.id);
  save();
  return { db, intake, decision, save };
}

it("auto-files a verified all-covered review once, with no typed fields", () => {
  const { db, intake } = fixture();
  assert.ok(draftFor(db, intake.case.id));
  const [claim] = autoFileReady(db);
  assert.equal(claim.source, "auto");
  assert.equal(claim.status, "pending");
  assert.match(claim.incidentDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(claim.location.length > 5);
  assert.equal(autoFileReady(db).length, 0, "already filed");
  assert.equal(db.all("SELECT * FROM events WHERE type='claim.filed'").length, 1);
});

it("does not auto-file unverified, unresolved, emergency or stale reviews", () => {
  const { db, intake, decision, save } = fixture();
  save(false);
  assert.equal(draftFor(db, intake.case.id), null);
  save(); decision.unknowns = ["Cause unknown"]; save();
  assert.equal(draftFor(db, intake.case.id), null);
  decision.unknowns = []; decision.findings[0].status = "unclear"; save();
  assert.equal(draftFor(db, intake.case.id), null);
  decision.findings[0].status = "covered"; decision.immediate_danger = true; save();
  assert.equal(draftFor(db, intake.case.id), null);
  decision.immediate_danger = false; save();
  appendMessage(db, intake.case.id, "customer", "Actually the roof was worn out.");
  assert.equal(draftFor(db, intake.case.id), null);
  assert.throws(() => fileClaim(db, intake.case.id, "auto"));
  assert.equal(autoFileReady(db).length, 0);
});

it("files manually from any agent state, once per case", () => {
  const { db, intake, decision, save } = fixture();
  decision.findings[0].status = "unclear"; save(false);
  const a = fileClaim(db, intake.case.id, "manual");
  const b = fileClaim(db, intake.case.id, "manual");
  assert.equal(a.id, b.id);
  assert.equal(a.source, "manual");
  assert.match(a.basis, /Drafted by a reviewer/);
  assert.equal(claimFiles(db).length, 1);
});

it("drafts await human confirmation; confirm files the claim, deny needs a reason", () => {
  const { db, intake } = fixture();
  const claim = fileClaim(db, intake.case.id, "manual");
  assert.equal(claim.status, "pending");
  const confirmed = decideClaim(db, claim.id, { decision: "confirm" });
  assert.equal(confirmed.status, "confirmed");
  assert.equal(decideClaim(db, claim.id, { decision: "confirm" }).status, "confirmed", "confirming again is a no-op");
  assert.throws(() => decideClaim(db, claim.id, { decision: "deny", note: "changed mind" }), /already confirmed/);
  assert.equal(db.all("SELECT * FROM events WHERE type='claim.confirmed'").length, 1);

  const other = fixture();
  const c2 = fileClaim(other.db, other.intake.case.id, "manual");
  assert.throws(() => decideClaim(other.db, c2.id, { decision: "deny" }), /reason/);
  const denied = decideClaim(other.db, c2.id, { decision: "deny", note: "Wear and tear exclusion" });
  assert.equal(denied.status, "denied");
  assert.equal(denied.decisionNote, "Wear and tear exclusion");
});

it("renders the simulated property loss notice as a PDF", async () => {
  const { db, intake } = fixture();
  const claim = fileClaim(db, intake.case.id, "manual");
  const pdf = await claimPdf(claim);
  assert.equal(Buffer.from(pdf.slice(0, 5)).toString(), "%PDF-");
  assert.ok(pdf.length > 2_000);
});
