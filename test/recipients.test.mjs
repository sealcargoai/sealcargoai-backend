// Real client data reaches only SEAL's commercial owners; development copies get only
// identified tests (unless explicitly authorized). Follow-up records who and when, and
// survives a restart. QA sessions don't inflate the funnel. No client data in the logs.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-rcpt-"));
const MAIL_LOG = path.join(dir, "mails.jsonl");
const PORT = 4100 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let srv;
let logs = "";
function start(extra = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", path.resolve("test/fake-resend.mjs"), "src/index.js"], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(dir, "data"), MAIL_LOG, RESEND_API_KEY: "re_test", LEADS_EMAIL: "ventas@seal.com.gt", LEADS_CC: "", ADMIN_EMAIL: "dev1@agencia.test.com", ADMIN2_EMAIL: "dev2@agencia.test.com", QA_NOTIFY_EMAILS: "", QA_LEADS_EMAIL: "", DEV_COPIES_REAL_LEADS: "", QA_EMAILS: "qa.cuenta@empresa.gt", PUBLIC_API_URL: "", ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (d) => { logs += d; if (String(d).includes("Recipients")) resolve(p); });
    p.stderr.on("data", (d) => { logs += d; });
    p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
}
const stop = (p) => new Promise((r) => { p.removeAllListeners("exit"); p.on("exit", r); p.kill("SIGTERM"); });
after(async () => { if (srv) await stop(srv); fs.rmSync(dir, { recursive: true, force: true }); });
const mails = () => (fs.existsSync(MAIL_LOG) ? fs.readFileSync(MAIL_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
let ip = 0;
const post = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.50.0.${++ip}` }, body: JSON.stringify(body) });
const REAL = { name: "Lucía Herrera", email: "lucia.herrera@importadora.gt", product: "Sillas plásticas apilables", message: "Mi teléfono es 5555-1234" };

test("defaults: real case → only the commercial inbox; dev copies don't get it", async () => {
  srv = await start();
  assert.match(logs, /Recipients:\s+real → 1 commercial; tests → commercial \+ 2 dev/);
  const j = await (await post("/api/email/quote", REAL)).json();
  assert.equal(j.test, false);
  assert.deepEqual(mails().at(-1).to, ["ventas@seal.com.gt"]);
  const u = new URL(j.caseUrl);
  const d = await (await fetch(BASE + u.pathname + u.search + "&format=json")).json();
  assert.deepEqual(d.notifiedTo, ["ve***@seal.com.gt"]);
});

test("identified tests (test words or a QA_EMAILS account) → commercial (marked [PRUEBA]) + dev copies", async () => {
  const a = await (await post("/api/email/quote", { name: "PRUEBA — NO ATENDER COMERCIALMENTE", email: "qa.ficticio@example.com", product: "Guantes" })).json();
  assert.equal(a.test, true);
  let m = mails().at(-1);
  assert.deepEqual(m.to, ["ventas@seal.com.gt", "dev1@agencia.test.com", "dev2@agencia.test.com"]);
  assert.match(m.subject, /^\[PRUEBA\]/);
  await post("/api/email/quote", { name: "Ana", email: "qa.cuenta@empresa.gt", product: "Termos" });
  m = mails().at(-1);
  assert.deepEqual(m.to, ["ventas@seal.com.gt", "dev1@agencia.test.com", "dev2@agencia.test.com"]);
});

test("the other emails follow the same rule: landing lead, search lead, report copy", async () => {
  await post("/api/email/lead", { name: "Lucía Herrera", email: "lucia.herrera@importadora.gt", query: "Sillas plásticas apilables para eventos" });
  assert.deepEqual(mails().at(-1).to, ["ventas@seal.com.gt"]);
  await post("/api/email/lead", { name: "Prueba QA", email: "qa@example.com", query: "Sillas plásticas apilables para eventos" });
  assert.deepEqual(mails().at(-1).to, ["ventas@seal.com.gt", "dev1@agencia.test.com", "dev2@agencia.test.com"]);
});

test("follow-up: needs a person's name, records who and when, survives a restart", async () => {
  const j = await (await post("/api/email/quote", { name: "Prueba Seguimiento", email: "seg@example.com", product: "Cables" })).json();
  const html = mails().at(-1).html;
  const act = (s) => new URL(html.match(new RegExp(`href="([^"]+s=${s}[^"]+)"`))[1].replace(/&amp;/g, "&"));
  const form = (u, body) => fetch(BASE + u.pathname, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const u = act("contactado");
  const t = u.searchParams.get("t");
  // opening the link changes nothing
  const page = await (await fetch(BASE + u.pathname + u.search)).text();
  assert.match(page, /Estado actual: <b>recibido/);
  assert.match(page, /Tu nombre \(obligatorio/);
  // without a name: refused, state unchanged
  const no = await form(u, `s=contactado&t=${t}`);
  assert.equal(no.status, 400);
  assert.match(await no.text(), /Falta tu nombre/);
  for (const [s, by] of [["contactado", "Ventas SEAL"], ["calificado", "Ventas SEAL"], ["cotizado", "Ventas SEAL"], ["cliente", "Gerencia"]])
    assert.equal((await form(u, `s=${s}&t=${t}&by=${encodeURIComponent(by)}`)).status, 200);
  // transfer: only with the validating person
  assert.equal((await form(u, `s=derivar&t=${t}&transferTo=DLZ`)).status, 400);
  assert.equal((await form(u, `s=derivar&t=${t}&transferTo=DLZ&validatedBy=${encodeURIComponent("Gerencia SEAL")}`)).status, 200);
  await stop(srv);
  srv = await start();
  const after = await (await fetch(BASE + u.pathname + u.search)).text();
  assert.match(after, /Estado actual: <b>cliente/);
  assert.match(after, /estado: contactado · Ventas SEAL/);
  assert.match(after, /estado: cliente · Gerencia/);
  assert.match(after, /DLZ \(validó Gerencia SEAL\)/);
  const cu = new URL(j.caseUrl);
  const d = await (await fetch(BASE + cu.pathname + cu.search + "&format=json")).json();
  assert.equal(d.status, "cliente");
  assert.equal(d.test, true);
});

test("tests and QA sessions don't inflate the commercial funnel", async () => {
  const html = mails().at(-1).html;
  const f = new URL(html.match(/href="([^"]+funnel[^"]+)"/)[1].replace(/&amp;/g, "&"));
  for (let i = 0; i < 3; i++) await post("/api/events", { event: "visita", vid: `qa-vid-${i}-xxxx`, qa: true });
  await post("/api/events", { event: "visita", vid: "real-vid-0001" });
  const j = await (await fetch(BASE + f.pathname + f.search + "&format=json")).json();
  assert.equal(j.stages["Visitas"], 1);
  assert.equal(j.qaEvents.visita, 3);
  // only the real case counts as a request; the test cases (and their "cliente") don't
  assert.equal(j.stages["Solicitudes recibidas (registradas con número)"], 1);
  assert.equal(j.stages["Clientes"], 0);
  assert.deepEqual(j.recipients, { commercial: 1, devCopies: 2, qaInbox: 0, devGetsReal: false });
});

test("explicit authorization and a QA inbox change the routing as configured", async () => {
  await stop(srv);
  srv = await start({ DEV_COPIES_REAL_LEADS: "1", LEADS_CC: "gerencia@seal.com.gt", QA_LEADS_EMAIL: "qa@seal.com.gt" });
  await post("/api/email/quote", { ...REAL, product: "Mesas" });
  assert.deepEqual(mails().at(-1).to, ["ventas@seal.com.gt", "gerencia@seal.com.gt", "dev1@agencia.test.com", "dev2@agencia.test.com"]);
  await post("/api/email/quote", { name: "Prueba", email: "p@example.com", product: "Mesas" });
  assert.deepEqual(mails().at(-1).to, ["qa@seal.com.gt", "dev1@agencia.test.com", "dev2@agencia.test.com"]);
});

test("no client data in the server logs", () => {
  for (const s of ["lucia.herrera@importadora.gt", "Lucía Herrera", "5555-1234", "Sillas plásticas apilables para eventos", "dev1@agencia", "ventas@seal.com.gt"]) assert.ok(!logs.includes(s), `log contains ${s}`);
});
