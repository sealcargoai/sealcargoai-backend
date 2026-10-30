// 30-c · The start notice ("Consulta iniciada") is a notice, never a request: it creates no case
// number, is marked [PRUEBA] for test data, says it is not a request or a quote, and goes to the
// QA inbox when one is configured (so a test never reaches sales). Production-like defaults are
// checked too: without QA_LEADS_EMAIL a test notice goes to the commercial inbox, marked [PRUEBA].
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-aviso-"));
const MAIL_LOG = path.join(dir, "mails.jsonl");
// 4700–4789: no port in this range is refused by fetch() ("bad port")
const PORT = 4700 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let srv;
function start(extra = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", path.resolve("test/fake-resend.mjs"), "src/index.js"], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: path.join(dir, "data"), MAIL_LOG, RESEND_API_KEY: "re_test", LEADS_EMAIL: "ventas@seal.com.gt", LEADS_CC: "", ADMIN_EMAIL: "", ADMIN2_EMAIL: "", QA_NOTIFY_EMAILS: "", QA_LEADS_EMAIL: "", QA_EMAILS: "", DEV_COPIES_REAL_LEADS: "", PUBLIC_API_URL: "", EMAIL_DRY_RUN: "", ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (d) => String(d).includes("Recipients") && resolve(p));
    p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
}
const stop = (p) =>
  new Promise((r) => {
    p.removeAllListeners("exit");
    p.on("exit", r);
    p.kill("SIGTERM");
  });
after(async () => {
  if (srv) await stop(srv);
  fs.rmSync(dir, { recursive: true, force: true });
});
const mails = () => (fs.existsSync(MAIL_LOG) ? fs.readFileSync(MAIL_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
let ip = 0;
const post = (p, body) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.70.0.${++ip}` }, body: JSON.stringify(body) });
const TEST = { name: "PRUEBA QA", email: "qa-prueba@example.com", query: "PRUEBA QA – No enviar caso comercial. Quiero importar 4 compresores de tornillo con un presupuesto de US$5,000." };

test("defaults like production (no QA inbox): the test notice goes to the commercial inbox, marked [PRUEBA], and says it is not a request", async () => {
  srv = await start();
  const r = await post("/api/email/lead", TEST);
  assert.equal(r.status, 200);
  const j = await r.json();
  // a notice: no case number, no case link
  assert.deepEqual(j, { success: true });
  const m = mails().at(-1);
  assert.deepEqual(m.to, ["ventas@seal.com.gt"]);
  assert.equal(m.subject, "[PRUEBA] Consulta iniciada (aún sin solicitud): PRUEBA QA");
  assert.match(m.html, /Aún no es una solicitud a SEAL ni una cotización/);
  assert.doesNotMatch(m.subject + m.html, /Caso SEAL-|Solicitud recibida|cotizaci[oó]n confirmada|garantiz/i);
});

test("the notice registers no case: the registry stays empty after a restart", async () => {
  await stop(srv);
  srv = null;
  const file = path.join(dir, "data", "leads.json");
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  assert.equal((Array.isArray(saved) ? saved : Object.values(saved)).length, 0);
});

test("with a QA inbox configured, a test notice never reaches sales", async () => {
  srv = await start({ QA_LEADS_EMAIL: "qa-inbox@example.com" });
  await post("/api/email/lead", TEST);
  const m = mails().at(-1);
  assert.deepEqual(m.to, ["qa-inbox@example.com"]);
  assert.match(m.subject, /^\[PRUEBA\] Consulta iniciada \(aún sin solicitud\)/);
  // a real-looking contact is not a test: commercial inbox, no [PRUEBA]
  await post("/api/email/lead", { name: "Lucía Herrera", email: "lucia.herrera@importadora.gt", query: "Sillas apilables" });
  const r = mails().at(-1);
  assert.deepEqual(r.to, ["ventas@seal.com.gt"]);
  assert.doesNotMatch(r.subject, /PRUEBA/);
});

test("the same notice sent twice (double click) is two notices but never a case", async () => {
  const before = mails().length;
  await Promise.all([post("/api/email/lead", TEST), post("/api/email/lead", TEST)]);
  const after2 = mails().slice(before);
  assert.ok(after2.every((m) => /Consulta iniciada/.test(m.subject)));
  await stop(srv);
  srv = null;
  const file = path.join(dir, "data", "leads.json");
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];
  assert.equal((Array.isArray(saved) ? saved : Object.values(saved)).length, 0);
});
