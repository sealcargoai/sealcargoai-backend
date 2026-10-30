// Cierre 29-b: the server validates the TYPE and FORMAT of every case field before it registers a
// case, emails SEAL or spends a free search; and EMAIL_DRY_RUN=1 makes sending technically impossible.
// Run: npm test (real server on a free port; Resend replaced by test/fake-resend.mjs, QA recipient)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { quantityError, budgetError, malformedFields } from "../src/middleware/security.js";

test("quantityError: valid ES/EN formats; notation, ranges, approximations and non-text rejected", () => {
  for (const ok of ["1", "10000000", "10,000,000", "10.000.000", "4 unidades", "2,000 piezas", "42 sets de 12 piezas c/u = 504 piezas", 4, 10_000_000, "", null, undefined])
    assert.equal(quantityError(ok), "", `valid: ${JSON.stringify(ok)}`);
  const bad = [
    ["5e2", "quantity_invalid"],
    ["1E3 unidades", "quantity_invalid"],
    ["10^3", "quantity_invalid"],
    ["5-6", "quantity_invalid"],
    ["5 o 6 compresores", "quantity_invalid"],
    ["5 to 10", "quantity_invalid"],
    ["unos 8", "quantity_invalid"],
    ["about 8", "quantity_invalid"],
    [{ n: 4 }, "quantity_invalid"],
    [[4], "quantity_invalid"],
    [NaN, "quantity_invalid"],
    [Infinity, "quantity_invalid"],
    ["3.5", "quantity_not_integer"],
    ["0", "quantity_below_min"],
    ["-1", "quantity_below_min"],
    ["10,000,001", "quantity_above_max"],
    [3.5, "quantity_not_integer"],
  ];
  for (const [v, why] of bad) assert.equal(quantityError(v), why, `invalid: ${JSON.stringify(v)}`);
});

test("budgetError: only plain amounts; malformed text, notation and non-text rejected", () => {
  for (const ok of ["US$5,000", "US$4,500.01", "5000", "5000.5", "Q40,000", "$ 5,000", 5000, "", null, undefined]) assert.equal(budgetError(ok), "", `valid: ${JSON.stringify(ok)}`);
  for (const v of ["5e3", "cinco mil", "12abc", "US$", "5,00,0", "1.000,50", { usd: 5 }, [5000], NaN, "US$5,000.123"]) assert.equal(budgetError(v), "budget_invalid", `invalid: ${JSON.stringify(v)}`);
  for (const v of ["0", "-5", "US$-5", -5, 0]) assert.equal(budgetError(v), "budget_below_min", `min: ${JSON.stringify(v)}`);
  for (const v of ["US$100,000,001", 100_000_001]) assert.equal(budgetError(v), "budget_above_max");
});

test("malformedFields: objects and arrays in text fields, non-string list items", () => {
  assert.deepEqual(malformedFields({ a: "x", b: 3, c: null }, ["a", "b", "c"]), []);
  assert.deepEqual(malformedFields({ a: {}, b: [], c: true }, ["a", "b", "c"]), ["a", "b", "c"]);
  assert.deepEqual(malformedFields({ l: ["x", 1] }, [], ["l"]), ["l"]);
  assert.deepEqual(malformedFields([], ["a"]), ["body"]);
});

function server(extraEnv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-29b-"));
  const MAIL_LOG = path.join(dir, "mails.jsonl");
  const PORT = 4300 + Math.floor(Math.random() * 400);
  const s = { dir, MAIL_LOG, BASE: `http://127.0.0.1:${PORT}`, proc: null };
  s.start = () =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--import", path.resolve("test/fake-resend.mjs"), "src/index.js"], {
        env: {
          ...process.env,
          PORT: String(PORT),
          DATA_DIR: dir,
          MAIL_LOG,
          RESEND_API_KEY: "re_test",
          LEADS_EMAIL: "qa@example.test",
          ADMIN_EMAIL: "",
          ADMIN2_EMAIL: "",
          PUBLIC_API_URL: "",
          GROQ_API_KEY: "",
          ALIBABA_APP_KEY: "",
          EMAIL_DRY_RUN: "",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      s.proc = p;
      p.stdout.on("data", (d) => String(d).includes("running at") && resolve(p));
      p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
    });
  s.stop = async () => {
    await new Promise((r) => {
      s.proc.removeAllListeners("exit");
      s.proc.on("exit", r);
      s.proc.kill("SIGTERM");
    });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  s.mails = () => (fs.existsSync(MAIL_LOG) ? fs.readFileSync(MAIL_LOG, "utf8").trim().split("\n").filter(Boolean) : []);
  s.post = (p, body, ip) => fetch(s.BASE + p, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
  return s;
}
const A = server({});
const DRY = server({ EMAIL_DRY_RUN: "1" });
before(async () => {
  await A.start();
  await DRY.start();
});
after(async () => {
  await A.stop();
  await DRY.stop();
});

const CASE = {
  requestType: "QA",
  source: "chat",
  name: "QA Cierre",
  email: "qa.cierre@example.test",
  product: "compresores industriales de tornillo, 220 V, tanque de 500 litros",
  quantity: "4",
  budget: "US$5,000",
  lang: "es",
};
let ip = 30;

const MALFORMED = [
  ["quantity object", { quantity: { n: 4 } }],
  ["quantity array", { quantity: ["4"] }],
  ["quantity 5e2", { quantity: "5e2" }],
  ["quantity range", { quantity: "5-6" }],
  ["budget object", { budget: { usd: 5000 } }],
  ["budget array", { budget: ["US$5,000"] }],
  ["budget 5e3", { budget: "5e3" }],
  ["budget text", { budget: "cinco mil" }],
  ["product object", { product: { a: 1 } }],
  ["earlier not a list", { earlier: "x" }],
  ["chat with objects", { chat: [{ a: 1 }] }],
  ["totalCost text", { totalCost: "mucho" }],
];
for (const [label, patch] of MALFORMED)
  test(`/api/email/quote rejects ${label} BEFORE registering or emailing`, async () => {
    const before = A.mails().length;
    const r = await A.post("/api/email/quote", { ...CASE, ...patch }, `10.3.0.${ip++}`);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).id, undefined);
    assert.equal(A.mails().length, before);
  });

test("/api/email/quote: the valid case is registered once and sent to the QA recipient only", async () => {
  const r = await A.post("/api/email/quote", CASE, `10.3.1.1`);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.id, /^SEAL-/);
  assert.equal(j.test, true);
  const last = JSON.parse(A.mails().at(-1));
  assert.deepEqual(last.to, ["qa@example.test"]);
});

const SEARCH = {
  productType: "machinery",
  userQuery: "compresores industriales de tornillo de 220 V con tanque de 500 litros",
  quantity: "4",
  budget: "5000",
  userEmail: "cliente.cierre@example.test",
};
for (const [label, patch, why] of [
  ["quantity 5e2", { quantity: "5e2" }, "quantity_invalid"],
  ["quantity ' 4 '", { quantity: " 4 " }, "quantity_invalid"],
  ["quantity object", { quantity: { n: 4 } }, "invalid_fields"],
  ["budget 5e3", { budget: "5e3" }, "budget_invalid"],
  ["budget array", { budget: [5000] }, "invalid_fields"],
  ["userQuery array", { userQuery: ["compresores industriales", "de tornillo"] }, "invalid_fields"],
  ["quantity 10,000,001", { quantity: 10_000_001 }, "quantity_above_max"],
])
  test(`/api/suppliers/search rejects ${label} BEFORE spending a free search`, async () => {
    const theIp = `10.4.0.${ip++}`;
    const q0 = await (await fetch(`${A.BASE}/api/suppliers/quota?email=${encodeURIComponent(SEARCH.userEmail)}`, { headers: { "x-real-ip": theIp } })).json();
    const r = await A.post("/api/suppliers/search", { ...SEARCH, ...patch }, theIp);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error, why);
    const q1 = await (await fetch(`${A.BASE}/api/suppliers/quota?email=${encodeURIComponent(SEARCH.userEmail)}`, { headers: { "x-real-ip": theIp } })).json();
    assert.equal(q1.remaining, q0.remaining);
  });

test("EMAIL_DRY_RUN=1: /health says so, a valid case answers normally and NO email reaches the provider", async () => {
  const h = await (await fetch(`${DRY.BASE}/health`)).json();
  assert.equal(h.emailDryRun, true);
  assert.equal(h.version, "2026.10.29-b");
  const r = await DRY.post("/api/email/quote", { ...CASE, name: "Cliente Real Simulado", email: "persona@empresa-ejemplo-real.gt" }, "10.5.0.1");
  assert.equal(r.status, 200);
  assert.equal(DRY.mails().length, 0);
  const lead = await DRY.post("/api/email/lead", { name: "Cliente", email: "persona@empresa-ejemplo-real.gt", query: "compresores" }, "10.5.0.2");
  assert.equal(lead.status, 200);
  assert.equal(DRY.mails().length, 0);
});

test("without EMAIL_DRY_RUN /health reports false", async () => {
  const h = await (await fetch(`${A.BASE}/health`)).json();
  assert.equal(h.emailDryRun, false);
});
