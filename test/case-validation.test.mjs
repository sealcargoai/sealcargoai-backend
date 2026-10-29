// Audit 2026-10-29: the server is the last line of defense for the case data. A quantity that is
// not a whole number from 1 to 10,000,000 (3.5, 0, -1, 10,000,001) or an out-of-range budget is
// rejected: nothing is registered, nothing is emailed, and nothing is rounded or clamped.
// Run: npm test (real server on a free port; Resend replaced by test/fake-resend.mjs)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quantityError, budgetError } from "../src/middleware/security.js";

test("quantityError: whole units 1–10,000,000, Spanish and English formats", () => {
  for (const ok of ["1", "4", "10000000", "10,000,000", "10.000.000", "2,000 piezas", "1.000 unidades", "500 compresores", "", null, undefined, "por definir"])
    assert.equal(quantityError(ok), "", `valid: ${ok}`);
  for (const [bad, why] of [["0", "quantity_below_min"], ["-1", "quantity_below_min"], ["3.5", "quantity_not_integer"], ["3,5", "quantity_not_integer"], ["3.5 compresores", "quantity_not_integer"], ["10000001", "quantity_above_max"], ["10,000,001", "quantity_above_max"], ["10.000.001 unidades", "quantity_above_max"]])
    assert.equal(quantityError(bad), why, `invalid: ${bad}`);
});

test("budgetError: positive amounts up to 100,000,000", () => {
  for (const ok of ["US$5,000", "5000", "4500.01", "Q40,000", "", undefined]) assert.equal(budgetError(ok), "", `valid: ${ok}`);
  for (const bad of ["0", "-5", "US$100,000,001"]) assert.notEqual(budgetError(bad), "", `invalid: ${bad}`);
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-validate-"));
const MAIL_LOG = path.join(dir, "mails.jsonl");
const PORT = 4100 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let srv;
const mails = () => (fs.existsSync(MAIL_LOG) ? fs.readFileSync(MAIL_LOG, "utf8").trim().split("\n").filter(Boolean) : []);
const post = (p, body, ip) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
before(async () => {
  srv = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", path.resolve("test/fake-resend.mjs"), "src/index.js"], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, MAIL_LOG, RESEND_API_KEY: "re_test", LEADS_EMAIL: "qa@example.test", ADMIN_EMAIL: "", ADMIN2_EMAIL: "", PUBLIC_API_URL: "", GROQ_API_KEY: "", ALIBABA_APP_KEY: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (d) => String(d).includes("running at") && resolve(p));
    p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
});
after(async () => {
  await new Promise((r) => { srv.removeAllListeners("exit"); srv.on("exit", r); srv.kill("SIGTERM"); });
  fs.rmSync(dir, { recursive: true, force: true });
});

const CASE = { requestType: "QA", source: "chat", name: "QA Auditoría", email: "qa.audit@example.test", product: "compresores industriales de tornillo, 220 V, tanque de 500 litros", quantity: "4", budget: "US$5,000", lang: "es" };

let ip = 20;
for (const [quantity, why] of [["3.5", "quantity_not_integer"], ["0", "quantity_below_min"], ["-1", "quantity_below_min"], ["10,000,001", "quantity_above_max"]])
  test(`/api/email/quote rejects quantity ${quantity}: nothing registered or emailed`, async () => {
    const before = mails().length;
    const r = await post("/api/email/quote", { ...CASE, quantity }, `10.1.0.${ip++}`);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, why);
    assert.equal(mails().length, before);
  });

test("/api/email/quote rejects a budget above US$100,000,000", async () => {
  const before = mails().length;
  const r = await post("/api/email/quote", { ...CASE, budget: "US$100,000,001" }, `10.1.0.${ip++}`);
  assert.equal(r.status, 400);
  assert.equal(mails().length, before);
});

test("/api/email/quote keeps a valid case exactly as sent (4 units, US$5,000) — QA recipient, fake mail", async () => {
  const r = await post("/api/email/quote", CASE, `10.1.0.${ip++}`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.id);
  const m = mails().map((l) => JSON.parse(l));
  const last = m[m.length - 1];
  assert.deepEqual(last.to, ["qa@example.test"]);
  assert.ok(last.html.includes(">4<") || /Cantidad[^]*?4/.test(last.html));
  assert.ok(last.html.includes("US$5,000"));
});

for (const [quantity, why] of [[3.5, "quantity_not_integer"], ["3.5", "quantity_not_integer"], [0, "quantity_below_min"], [10_000_001, "quantity_above_max"]])
  test(`/api/suppliers/search rejects quantity ${quantity} instead of rounding/clamping it`, async () => {
    const r = await post("/api/suppliers/search", { productType: "machinery", userQuery: "compresores industriales de tornillo de 220 V con tanque de 500 litros", quantity, budget: "5000", userEmail: "qa.audit@example.test" }, `10.2.0.${ip++}`);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, why);
  });
