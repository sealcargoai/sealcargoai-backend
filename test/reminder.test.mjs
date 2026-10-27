// Cases nobody marked as contacted get one reminder to SEAL after the configured time
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-rem-"));
process.env.MAIL_LOG = path.join(dir, "mails.jsonl");
process.env.RESEND_API_KEY = "re_test";
process.env.LEADS_EMAIL = "ventas@seal.com.gt";
process.env.LEAD_REMIND_HOURS = "24";
delete process.env.DATA_DIR;
await import("./fake-resend.mjs");
const { registerLead, updateLead } = await import("../src/services/leadStore.js");
const { remindPending } = await import("../src/routes/leads.js");

test("one reminder per unattended case, none for attended or test cases", async () => {
  const t0 = Date.now() - 30 * 3600000;
  const a = registerLead({ contact: { name: "Luis", email: "luis@empresa.gt" }, case: { product: "Cables" }, source: "landing" }, t0).lead;
  const b = registerLead({ contact: { name: "Eva", email: "eva@empresa.gt" }, case: { product: "Sillas" }, source: "chat" }, t0).lead;
  registerLead({ contact: { name: "Prueba", email: "qa@example.com" }, case: { product: "X" }, test: true }, t0);
  registerLead({ contact: { name: "Nuevo", email: "n@empresa.gt" }, case: { product: "Y" } }); // too recent
  updateLead(b.id, { status: "contactado", by: "Ventas" });
  assert.equal(await remindPending("https://api.example"), 1);
  const mail = JSON.parse(fs.readFileSync(process.env.MAIL_LOG, "utf8").trim());
  assert.match(mail.subject, /1 caso sin contacto/);
  assert.ok(mail.html.includes(a.id) && !mail.html.includes(b.id));
  assert.equal(await remindPending("https://api.example"), 0); // not twice
});
