// 02-11c — Aislamiento de QA. Una prueba se identifica SOLO por una cuenta de la lista QA_EMAILS; las
// palabras del producto, la consulta, el nombre o el correo nunca convierten un lead real en prueba.
// Sin buzón QA válido, una prueba no se envía a nadie (503 qa_routing_unavailable), nunca a ventas.
// Servidor real; Resend simulado (test/fake-resend.mjs); búsqueda ficticia (test/fixtures). Nada sale.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function server(portBase, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-qa-"));
  const MAIL_LOG = path.join(dir, "mails.jsonl");
  const s = { BASE: "", proc: null, logs: "" };
  const once = (PORT) =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--import", path.resolve("test/fixtures/stub-register.mjs"), "--import", path.resolve("test/fake-resend.mjs"), "src/index.js"], {
        env: {
          ...process.env,
          PORT: String(PORT),
          DATA_DIR: dir,
          MAIL_LOG,
          RESEND_API_KEY: "re_test",
          LEADS_EMAIL: "ventas@example.test",
          LEADS_CC: "",
          QA_NOTIFY_EMAILS: "qa-dev@example.test",
          QA_EMAILS: "qa1@prueba.test",
          QA_LEADS_EMAIL: "",
          ADMIN_EMAIL: "",
          ADMIN2_EMAIL: "",
          DEV_COPIES_REAL_LEADS: "",
          PUBLIC_API_URL: "",
          GROQ_API_KEY: "",
          EMAIL_DRY_RUN: "",
          ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      p.stdout.on("data", (d) => {
        s.logs += d;
        if (String(d).includes("running at")) {
          p.removeAllListeners("exit");
          resolve(p);
        }
      });
      p.stderr.on("data", (d) => (s.logs += d));
      p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
    });
  s.start = async () => {
    let last;
    for (let i = 0; i < 6; i++) {
      const PORT = portBase + Math.floor(Math.random() * 180);
      try {
        s.proc = await once(PORT);
        s.BASE = `http://127.0.0.1:${PORT}`;
        await new Promise((r) => setTimeout(r, 200));
        return;
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
  s.stop = async () => {
    await new Promise((r) => {
      s.proc.removeAllListeners("exit");
      s.proc.on("exit", r);
      s.proc.kill("SIGTERM");
    });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  s.mails = () => (fs.existsSync(MAIL_LOG) ? fs.readFileSync(MAIL_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  s.post = (p, body, ip) => fetch(s.BASE + p, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
  return s;
}
const OK = server(5100, { QA_LEADS_EMAIL: "qa-inbox@example.test" });
const MISSING = server(5300, {});
before(async () => {
  await OK.start();
  await MISSING.start();
});
after(async () => {
  await OK.stop();
  await MISSING.stop();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const QA_TO = ["qa-inbox@example.test", "qa-dev@example.test"];
const SALES = ["ventas@example.test"];
const WORDY = "Unidad de prueba de compresor para demo en planta, testing de 220 V, ejemplo del catálogo";
const search = (s, email, ip, q = WORDY) => s.post("/api/suppliers/search", { productType: "machinery", userQuery: q, quantity: "4", userEmail: email }, ip);

test("búsqueda comercial con «prueba», «demo», «testing», «ejemplo»: aviso a ventas, sin [PRUEBA]", async () => {
  const n = OK.mails().length;
  const r = await search(OK, "compras@importadora.gt", "10.1.0.1");
  assert.equal(r.status, 200);
  await wait(300);
  const m = OK.mails().slice(n);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].to, SALES);
  assert.doesNotMatch(m[0].subject, /PRUEBA/);
});

test("consulta iniciada y caso comerciales con esas palabras: ventas, sin [PRUEBA], test=false", async () => {
  let n = OK.mails().length;
  await OK.post("/api/email/lead", { name: "Pedro Ejemplo", email: "pedro@demo-industrial.gt", query: WORDY }, "10.1.0.2");
  let m = OK.mails().slice(n);
  assert.deepEqual(m[0].to, SALES);
  assert.doesNotMatch(m[0].subject, /PRUEBA/);
  n = OK.mails().length;
  const j = await (await OK.post("/api/email/quote", { name: "Pedro Ejemplo", email: "pedro@demo-industrial.gt", product: WORDY, message: "Es una prueba piloto de 2 unidades" }, "10.1.0.2")).json();
  assert.equal(j.test, false);
  m = OK.mails().slice(n);
  assert.deepEqual(m[0].to, SALES);
  assert.doesNotMatch(m[0].subject, /PRUEBA/);
});

test("cuenta QA permitida (en cualquier mayúscula o con +etiqueta) con buzón QA: cada evento va solo a QA y marcado", async () => {
  const n = OK.mails().length;
  await OK.post("/api/email/lead", { name: "Ana", email: "QA1+r1@prueba.test", query: "Sillas plásticas apilables para eventos" }, "10.1.0.3");
  const s = await (await search(OK, "qa1@prueba.test", "10.1.0.3", "sillas plásticas apilables para eventos")).json();
  await wait(300);
  const q = await (await OK.post("/api/email/quote", { name: "Ana", email: "qa1@prueba.test", product: "Sillas plásticas" }, "10.1.0.3")).json();
  assert.equal(q.test, true);
  const r = await OK.post("/api/email/report", { recipientEmail: "otra.persona@empresa.gt", requesterEmail: "qa1@prueba.test", reportToken: s.reportToken, totalCostText: "Q1,000.00", lang: "es" }, "10.1.0.3");
  assert.equal(r.status, 200);
  const m = OK.mails().slice(n);
  assert.equal(m.length, 4);
  assert.match(m[0].subject, /^\[PRUEBA\] Consulta iniciada \(aún sin solicitud\)/);
  assert.match(m[1].subject, /^\[PRUEBA\] Búsqueda:/);
  assert.match(m[2].subject, new RegExp(`^\\[PRUEBA\\] Caso ${q.id}`));
  for (const x of m.slice(0, 3)) assert.deepEqual(x.to, QA_TO);
  assert.match(m[3].subject, /^Su informe SEAL/);
  assert.equal(m[3].to, "otra.persona@empresa.gt");
  assert.deepEqual(m[3].bcc, QA_TO);
  for (const x of m) assert.ok(![].concat(x.to, x.bcc || []).some((a) => /ventas@/.test(a)), "nunca a ventas");
});

test("buzón QA ausente: la prueba no se envía a nadie y se rechaza (503); lo real sigue igual", async () => {
  const h = await (await fetch(MISSING.BASE + "/health")).json();
  assert.equal(h.qaRouting, "missing");
  assert.doesNotMatch(JSON.stringify(h), /@/);
  assert.match(MISSING.logs, /tests → NOT SENT/);
  assert.match(MISSING.logs, /QA routing missing/);
  const n = MISSING.mails().length;
  assert.equal((await MISSING.post("/api/email/lead", { name: "Ana", email: "qa1@prueba.test", query: "Sillas plásticas apilables para eventos" }, "10.2.0.1")).status, 503);
  const q = await MISSING.post("/api/email/quote", { name: "Ana", email: "qa1@prueba.test", product: "Sillas" }, "10.2.0.1");
  assert.equal(q.status, 503);
  assert.deepEqual(await q.json(), { error: "qa_routing_unavailable" });
  // the QA search still works for the tester, but its notice is not sent anywhere
  const s = await search(MISSING, "qa1@prueba.test", "10.2.0.1", "sillas plásticas apilables para eventos");
  assert.equal(s.status, 200);
  const tok = (await s.json()).reportToken;
  assert.equal((await MISSING.post("/api/email/report", { recipientEmail: "x@empresa.gt", requesterEmail: "qa1@prueba.test", reportToken: tok, lang: "es" }, "10.2.0.1")).status, 503);
  await wait(300);
  assert.equal(MISSING.mails().length, n, "ningún correo de prueba salió");
  assert.match(MISSING.logs, /QA_ROUTING_UNAVAILABLE/);
  // a real client is unaffected
  await MISSING.post("/api/email/quote", { name: "Lucía", email: "lucia@importadora.gt", product: "Sillas" }, "10.2.0.2");
  assert.deepEqual(MISSING.mails().at(-1).to, SALES);
});

test("sin direcciones en los registros del servidor", () => {
  for (const s of [OK.logs, MISSING.logs]) {
    assert.doesNotMatch(s, /qa-inbox@|qa-dev@|ventas@example|qa1@prueba|pedro@demo|lucia@/);
  }
});

test("un caso registrado antes con otra clasificación se reclasifica al actualizarse (revisión independiente)", async () => {
  // simulates an old record: registered as test (old word rule), the same person writes again
  const { registerLead, _resetLeads } = await import("../src/services/leadStore.js");
  _resetLeads();
  const base = { contact: { name: "Demo SA", email: "compras@demo.gt" }, case: { product: "Sillas" }, source: "chat", requestType: "x" };
  const first = registerLead({ ...base, test: true });
  assert.equal(first.lead.test, true);
  const again = registerLead({ ...base, case: { product: "Sillas", quantity: "10" }, test: false });
  assert.equal(again.duplicate, true);
  assert.equal(again.lead.test, false, "real again: goes to sales");
  const qa = registerLead({ ...base, test: true });
  assert.equal(qa.lead.test, true);
});
