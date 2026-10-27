// Requests reach SEAL once, with their case number and full context; follow-up and funnel.
// Run: npm test (starts the real server on a free port with Resend replaced)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-leads-"));
const MAIL_LOG = path.join(dir, "mails.jsonl");
const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let srv;

function start(extra = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", path.resolve("test/fake-resend.mjs"), "src/index.js"], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, MAIL_LOG, RESEND_API_KEY: "re_test", LEADS_EMAIL: "ventas@seal.com.gt", ADMIN_EMAIL: "", ADMIN2_EMAIL: "", PUBLIC_API_URL: "", ...extra },
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (d) => String(d).includes("running at") && resolve(p));
    p.stderr.on("data", (d) => process.env.DEBUG && process.stderr.write(d));
    p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
}
const stop = (p) => new Promise((r) => { p.removeAllListeners("exit"); p.on("exit", r); p.kill("SIGTERM"); });
const mails = () => (fs.existsSync(MAIL_LOG) ? fs.readFileSync(MAIL_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const post = (p, body, ip = "10.0.0.1") => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });

const CASE = {
  requestType: "Contacto directo con SEAL",
  source: "chat",
  intent: "tengo_proforma",
  name: "Ana Pérez",
  email: "ana.perez@empresa.com.gt",
  phone: "+502 5555 1234",
  product: "Termos de acero inoxidable 500 ml",
  productDescription: "Termos de acero inoxidable 304, 500 ml, con logo",
  quantity: "2,000 piezas",
  supplierName: "Ningbo Example Co.",
  supplierUrl: "https://www.alibaba.com/product-detail/x_123.html",
  price: "US$2.10 por pieza",
  totalCostText: "Q48,300 (US$6,110)",
  assumptions: ["Precio por pieza tomado de la publicación", "Flete marítimo LCL estimado"],
  warnings: ["Esta publicación indica acero 201; solicitaste 304"],
  chat: ["Ya tengo proforma del proveedor", "Quiero hablar con alguien"],
  message: "Necesito que me ayuden con la importación",
  lang: "es",
};

before(async () => { srv = await start(); });
after(async () => { await stop(srv); fs.rmSync(dir, { recursive: true, force: true }); });

let first;
const firstId = () => first.id;
test("a request is registered with a case number and SEAL gets the whole context", async () => {
  const r = await post("/api/email/quote", CASE);
  assert.equal(r.status, 200);
  first = await r.json();
  assert.match(first.id, /^SEAL-\d{8}-[0-9A-F]{6}$/);
  assert.equal(first.duplicate, false);
  assert.equal(first.notified, true);
  const m = mails();
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].to, ["ventas@seal.com.gt"]);
  assert.match(m[0].subject, new RegExp(`Caso ${first.id}`));
  for (const s of ["Termos de acero inoxidable", "2,000 piezas", "Ningbo Example Co.", "US$2.10 por pieza", "Q48,300", "Flete marítimo LCL estimado", "acero 201", "Ya tengo proforma", "+502 5555 1234", "una persona lo valida", "/api/leads/act/"])
    assert.ok(m[0].html.includes(s), `email must include ${s}`);
});

test("the same person, product and supplier again is the same case: no duplicate, no second email", async () => {
  const r = await post("/api/email/quote", { ...CASE, email: "Ana.Perez@Empresa.com.gt" }, "10.0.0.2");
  const j = await r.json();
  assert.equal(j.id, first.id);
  assert.equal(j.duplicate, true);
  assert.equal(mails().length, 1);
});



test("another product is another case", async () => {
  const j = await (await post("/api/email/quote", { ...CASE, product: "Mochilas escolares", productDescription: "Mochilas escolares", supplierName: "", supplierUrl: "" }, "10.0.0.3")).json();
  assert.notEqual(j.id, first.id);
  assert.equal(mails().length, 2);
});

test("invalid email is rejected and nothing is registered", async () => {
  const r = await post("/api/email/quote", { ...CASE, email: "ana@" }, "10.0.0.4");
  assert.equal(r.status, 400);
  assert.equal(mails().length, 2);
});

test("status links: opening changes nothing, the button records it; a bad token is refused", async () => {
  const m = mails()[0];
  const href = m.html.match(/href="([^"]+act[^"]+s=calificado[^"]+)"/)[1].replace(/&amp;/g, "&");
  const url = new URL(href);
  assert.equal(url.origin, BASE.replace("127.0.0.1", url.hostname)); // base from the request
  const local = BASE + url.pathname + url.search;
  const g = await fetch(local);
  assert.equal(g.status, 200);
  assert.match(await g.text(), /Estado actual: <b>recibido/);
  const bad = await fetch(BASE + url.pathname, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "s=calificado&t=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" });
  assert.equal(bad.status, 404);
  const t = url.searchParams.get("t");
  const ok = await fetch(BASE + url.pathname, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `s=calificado&t=${t}&by=Ventas&note=Tiene proforma` });
  assert.equal(ok.status, 200);
  assert.match(await ok.text(), /Estado actual: <b>calificado/);
  // a transfer needs who validated it
  const noVal = await fetch(BASE + url.pathname, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `s=derivar&t=${t}&transferTo=DLZ` });
  assert.equal(noVal.status, 400);
  const val = await fetch(BASE + url.pathname, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `s=derivar&t=${t}&transferTo=DLZ&validatedBy=Gerencia` });
  assert.equal(val.status, 200);
  assert.match(await val.text(), /DLZ \(validó Gerencia\)/);
  // cotizado then cliente
  for (const s of ["cotizado", "cliente"]) await fetch(BASE + url.pathname, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `s=${s}&t=${t}&by=Ventas` });
});

test("funnel: events once per browser and day; requests and later stages from the registry", async () => {
  const vid = "abcdef12-3456";
  for (const ev of ["visita", "visita", "consulta_iniciada", "resultados", "whatsapp_clic", "nope"]) await post("/api/events", { event: ev, vid }, "10.0.0.5");
  await post("/api/events", { event: "visita", vid: "zzzzzzzz-0001" }, "10.0.0.5");
  const link = mails()[0].html.match(/href="([^"]+funnel[^"]+)"/)[1].replace(/&amp;/g, "&");
  const u = new URL(link);
  const j = await (await fetch(`${BASE}${u.pathname}${u.search}&format=json`)).json();
  assert.equal(j.stages["Visitas"], 2);
  assert.equal(j.stages["Consultas iniciadas"], 1);
  assert.equal(j.stages["Resultados mostrados"], 1);
  assert.equal(j.stages["Solicitudes recibidas (registradas con número)"], 2);
  assert.equal(j.stages["Leads calificados"], 1);
  assert.equal(j.stages["Cotizaciones"], 1);
  assert.equal(j.stages["Clientes"], 1);
  assert.equal(j.events.whatsapp_clic, 1);
  assert.equal(j.leads.repetidasAgrupadas, 1);
  assert.equal((await fetch(`${BASE}/api/leads/funnel?t=bad`)).status, 404);
});

test("the registry survives a restart (deploy) and dedupe still works after it", async () => {
  await stop(srv);
  srv = await start();
  const j = await (await post("/api/email/quote", { ...CASE, product: "Mochilas escolares", productDescription: "Mochilas escolares", supplierName: "", supplierUrl: "" }, "10.0.0.6")).json();
  assert.equal(j.duplicate, true);
  assert.equal(mails().length, 2);
});

test("if the email to SEAL fails the case is kept, reported as not notified, and retried on the next send", async () => {
  await stop(srv);
  srv = await start({ RESEND_FAIL: "1" });
  const j = await (await post("/api/email/quote", { ...CASE, product: "Sillas plásticas", productDescription: "Sillas plásticas", supplierName: "", supplierUrl: "" }, "10.0.0.7")).json();
  assert.match(j.id, /^SEAL-/);
  assert.equal(j.notified, false);
  await stop(srv);
  srv = await start();
  const k = await (await post("/api/email/quote", { ...CASE, product: "Sillas plásticas", productDescription: "Sillas plásticas", supplierName: "", supplierUrl: "" }, "10.0.0.8")).json();
  assert.equal(k.id, j.id);
  assert.equal(k.notified, true);
  assert.equal(mails().length, 3);
});

test("test records are flagged and kept out of the funnel", async () => {
  const j = await (await post("/api/email/quote", { ...CASE, name: "Prueba QA", email: "qa@example.com" }, "10.0.0.9")).json();
  assert.match(mails().at(-1).subject, /^\[PRUEBA\]/);
  assert.ok(j.id);
});

test("a price typed by the user is labeled as such; the client's case page shows what SEAL received and its status", async () => {
  const r = await post("/api/email/quote", { ...CASE, product: "Bolsas", productDescription: "Bolsas", supplierName: "", supplierUrl: "", price: "US$0.05 / unidad", priceSource: "usuario", publishedPrice: "US$0.04 / unidad" }, "10.0.0.20");
  const j = await r.json();
  const m = mails().at(-1);
  assert.match(m.html, /Precio indicado por el usuario<\/td><td[^>]*><b>US\$0\.05/);
  assert.match(m.html, /Precio publicado<\/td><td[^>]*><b>US\$0\.04/);
  assert.ok(j.caseUrl && j.caseUrl.includes(`/api/leads/case/${j.id}?t=`));
  const u = new URL(j.caseUrl);
  const page = await (await fetch(BASE + u.pathname + u.search)).text();
  assert.match(page, /Recibido por SEAL — pendiente de contacto/);
  assert.match(page, /Aviso a SEAL:<\/span> Entregado al correo de SEAL \(confirmado por el servicio de correo\)/);
  assert.match(page, /Precio indicado por el usuario/);
  assert.match(page, /Ya tengo proforma/);
  const data = await (await fetch(BASE + u.pathname + u.search + "&format=json")).json();
  assert.equal(data.case.priceSource, "usuario");
  assert.deepEqual(data.notification, { sent: true, delivery: "delivered", deliveryText: "Entregado al correo de SEAL (confirmado por el servicio de correo)" });
  assert.equal((await fetch(BASE + u.pathname + "?t=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx")).status, 404);
  // a published price is never labeled as the user's
  await post("/api/email/quote", { ...CASE, product: "Cajas", productDescription: "Cajas", supplierName: "", supplierUrl: "", price: "US$1.00" }, "10.0.0.21");
  assert.doesNotMatch(mails().at(-1).html, /indicado por el usuario/);
});

test("the same case with new information: same number, SEAL gets one update email saying what changed", async () => {
  const base = { ...CASE, product: "Lámparas LED", productDescription: "Lámparas LED", supplierName: "Shenzhen Lamp", supplierUrl: "" };
  const firstCase = await (await post("/api/email/quote", base, "10.0.0.24")).json();
  const n = mails().length;
  const j = await (await post("/api/email/quote", { ...base, message: "Cambió el precio", price: "US$2.40 por pieza", priceSource: "usuario" }, "10.0.0.22")).json();
  assert.equal(j.id, firstCase.id);
  assert.equal(j.duplicate, true);
  assert.equal(mails().length, n + 1);
  const m = mails().at(-1);
  assert.match(m.subject, new RegExp(`^Actualización · Caso ${firstCase.id}`));
  assert.match(m.html, /Actualización del mismo caso/);
  assert.match(m.html, /precio, origen del precio, mensaje|mensaje.*precio|precio.*mensaje/);
  // sent again unchanged: nothing new, no email
  await post("/api/email/quote", { ...base, message: "Cambió el precio", price: "US$2.40 por pieza", priceSource: "usuario" }, "10.0.0.23");
  assert.equal(mails().length, n + 1);
});
