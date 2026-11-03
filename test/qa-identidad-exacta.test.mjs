// 02-11i — Clasificación QA por identidad exacta.
// Defecto reproducido: con QA_EMAILS=qa1@empresa.test, una consulta de «qa1+compras@empresa.test» se
// clasificaba como QA ([PRUEBA], buzón QA) porque isQa() usaba la clave amplia de cuotas (emailKey quita
// «+etiqueta» en cualquier dominio). Ahora QA = dirección exacta escrita en QA_EMAILS (mayúsculas y
// espacios normalizados; puntos y «+» solo en gmail.com / googlemail.com, regla documentada por Google).
// Servidor real; Resend simulado; búsqueda ficticia. Nada sale.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "./fixtures/qa-server.mjs";

const BASE_ENV = { QA_LEADS_EMAIL: "qa-inbox@example.test", LEADS_EMAIL: "ventas@example.test", LEADS_CC: "", QA_NOTIFY_EMAILS: "qa-dev@example.test" };
// A: only the base account is listed (the reproduced case)
const A = server(7900, { ...BASE_ENV, QA_EMAILS: "qa1@empresa.test,ana.qa@gmail.com" });
// C: same as A, only for the search-limit test (aliases share the broad quota key: it starts empty here)
const C = server(8300, { ...BASE_ENV, QA_EMAILS: "qa1@empresa.test,ana.qa@gmail.com" });
// B: only the «+» alias is listed expressly; Resend refuses that alias (to test the QA forward)
const B = server(8100, { ...BASE_ENV, QA_EMAILS: "qa1+compras@empresa.test", RESEND_FAIL_TO: "^qa1\\+compras@empresa\\.test$" });
before(async () => {
  await A.start();
  await B.start();
  await C.start();
});
after(async () => {
  await A.stop();
  await B.stop();
  await C.stop();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const addrs = (m) => [].concat(m.to || [], m.cc || [], m.bcc || []).map((x) => String(x).toLowerCase());
const QA_COPIES = ["qa-inbox@example.test", "qa-dev@example.test"];
let n = 0;
const ip = () => `10.11.${Math.floor(n / 200)}.${(n++ % 200) + 1}`;
const search = (S, email, q = "sillas plásticas apilables para eventos") => S.post("/api/suppliers/search", { productType: "machinery", userQuery: q, quantity: "4", userEmail: email }, ip());
async function token(S, email, q) {
  const r = await search(S, email, q);
  assert.equal(r.status, 200, email);
  const t = (await r.json()).reportToken;
  assert.ok(t);
  await wait(250);
  return t;
}
const report = (S, body) => S.post("/api/email/report", { totalCostText: "Q1,000.00", lang: "es", ...body }, ip());
const isCommercial = (m) => addrs(m).includes("ventas@example.test") && !/PRUEBA/.test(m.subject) && !addrs(m).some((a) => QA_COPIES.includes(a));
const isQaOnly = (m) => /^\[PRUEBA\]/.test(m.subject) && addrs(m).every((a) => QA_COPIES.includes(a));

test("A · caso reproducido: QA_EMAILS=qa1@ → «qa1+compras@» va por el flujo comercial (consulta, búsqueda y caso)", async () => {
  const k = A.attempts().length;
  assert.equal((await A.post("/api/email/lead", { name: "Compras", email: "qa1+compras@empresa.test", query: "Sillas plásticas apilables para eventos" }, ip())).status, 200);
  await token(A, "qa1+compras@empresa.test");
  const q = await (await A.post("/api/email/quote", { name: "Compras", email: "qa1+compras@empresa.test", product: "Sillas plásticas" }, ip())).json();
  assert.equal(q.test, false, "el caso no es prueba");
  const sent = A.attempts().slice(k);
  assert.equal(sent.length, 3);
  for (const m of sent) assert.ok(isCommercial(m), `a ventas, sin [PRUEBA]: ${m.subject}`);
  // the listed account itself is still QA
  const k2 = A.attempts().length;
  await A.post("/api/email/lead", { name: "QA", email: " QA1@Empresa.Test ", query: "Sillas plásticas apilables para eventos" }, ip());
  assert.ok(isQaOnly(A.attempts().slice(k2)[0]));
});

test("A · «qa1+compras@» conserva sus límites normales de búsqueda; «qa1@» (QA) no tiene límite", async () => {
  const products = ["mesas plegables de plástico", "carpas para eventos 3x3", "manteles de poliéster"];
  // the QA account searches first: its searches are never counted, so they don't eat the alias's
  for (const p of [...products, "sillas tiffany de resina", "tarimas modulares de aluminio"]) assert.equal((await search(C, "qa1@empresa.test", p)).status, 200);
  const codes = [];
  for (const p of [...products, "vasos de vidrio templado"]) codes.push((await search(C, "qa1+compras@empresa.test", p)).status);
  assert.deepEqual(codes, [200, 200, 200, 429], "el límite normal (3) del cliente, intacto");
});

test("A · tokens: «qa1+compras@» y «qa1@» no comparten búsqueda ni token; la cuenta QA no saca informes afuera", async () => {
  const qaTok = await token(A, "qa1@empresa.test", "vasos desechables biodegradables");
  const aliasTok = await token(A, "qa1+otro@empresa.test", "vasos desechables biodegradables");
  const k = A.attempts().length;
  const bad = Buffer.from("no es un PDF").toString("base64");
  for (const [body, status, error] of [
    [{ recipientEmail: "qa1@empresa.test", requesterEmail: "qa1@empresa.test", reportToken: aliasTok }, 403, "report_not_allowed"],
    [{ recipientEmail: "qa1@empresa.test", requesterEmail: "qa1+otro@empresa.test", reportToken: qaTok }, 403, "report_not_allowed"],
    [{ recipientEmail: "cliente@externo.gt", requesterEmail: "qa1@empresa.test", reportToken: qaTok, pdfBase64: bad }, 403, "qa_recipient_not_allowed"],
    [{ recipientEmail: "qa1+compras@empresa.test", requesterEmail: "qa1@empresa.test", reportToken: qaTok, pdfBase64: bad }, 403, "qa_recipient_not_allowed"],
    [{ recipientEmail: "Ventas+x@Example.test", requesterEmail: "QA1@EMPRESA.TEST", reportToken: qaTok, pdfBase64: bad }, 403, "qa_recipient_not_allowed"],
    [{ recipientEmail: "k​a@externo.gt", requesterEmail: "qa1@empresa.test", reportToken: qaTok }, 400, "email_not_supported"],
  ]) {
    const r = await report(A, body);
    assert.equal(r.status, status, JSON.stringify(body.recipientEmail));
    assert.equal((await r.json()).error, error);
  }
  assert.equal(A.attempts().length, k, "Resend no fue llamado; el PDF inválido no llegó a revisarse");
  // limits untouched by the refusals: the QA account can still send 3 reports to itself, then the cap
  for (let i = 0; i < 3; i++) assert.equal((await report(A, { recipientEmail: "qa1@empresa.test", requesterEmail: "qa1@empresa.test", reportToken: qaTok })).status, 200);
  assert.equal((await report(A, { recipientEmail: "qa1@empresa.test", requesterEmail: "qa1@empresa.test", reportToken: qaTok })).status, 429);
});

test("A · «qa1+otro@» (no listado) envía su propio informe por el flujo comercial habitual", async () => {
  const tok = await token(A, "qa1+otro@empresa.test", "cubiertos desechables de madera");
  const k = A.attempts().length;
  const r = await report(A, { recipientEmail: "gerencia@importadora.gt", requesterEmail: "qa1+otro@empresa.test", reportToken: tok });
  assert.deepEqual(await r.json(), { success: true, delivered: true, forwarded: false });
  const m = A.attempts().slice(k);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].bcc, ["ventas@example.test"]);
  // the previous test filled the QA account's daily cap (3 reports to qa1@): QA testing must not use up
  // the cap of a real recipient that shares the base address (it used to: same broad key → 429)
  const r2 = await report(A, { recipientEmail: "qa1+compras@empresa.test", requesterEmail: "qa1+otro@empresa.test", reportToken: tok });
  assert.equal(r2.status, 200, "el tope del cliente real no lo consumió QA");
  assert.deepEqual(A.attempts().slice(k)[1].bcc, ["ventas@example.test"]);
});

test("A · Gmail: puntos y «+» sí son la misma cuenta QA (regla documentada); Workspace no", async () => {
  const k = A.attempts().length;
  await A.post("/api/email/lead", { name: "Ana", email: "a.n.a.qa+pruebas@googlemail.com", query: "Sillas plásticas apilables para eventos" }, ip());
  assert.ok(isQaOnly(A.attempts().slice(k)[0]), "Gmail: QA");
  const tok = await token(A, "anaqa@gmail.com", "platos de cartón para eventos");
  assert.equal((await report(A, { recipientEmail: "ana.qa+informe@gmail.com", requesterEmail: "a.n.a.q.a@googlemail.com", reportToken: tok })).status, 200, "Gmail: misma identidad y destinatario QA");
});

test("A · el caso de «qa1+compras@» (real) y el de «qa1@» (QA) no se fusionan", async () => {
  const body = { name: "X", product: "Tarimas modulares de aluminio" };
  const real = await (await A.post("/api/email/quote", { ...body, email: "qa1+compras@empresa.test" }, ip())).json();
  const qa = await (await A.post("/api/email/quote", { ...body, email: "qa1@empresa.test" }, ip())).json();
  assert.deepEqual([real.duplicate, real.test, qa.duplicate, qa.test], [false, false, false, true]);
  assert.notEqual(real.id, qa.id);
  const again = await (await A.post("/api/email/quote", { ...body, email: "qa1+compras@empresa.test" }, ip())).json();
  assert.deepEqual([again.duplicate, again.test, again.id], [true, false, real.id]);
});

test("B · alias «+» listado expresamente: solo esa identidad es QA; ni la base ni otros alias", async () => {
  const k = B.attempts().length;
  for (const email of ["qa1+compras@empresa.test", "qa1@empresa.test", "qa1+otro@empresa.test"])
    await B.post("/api/email/lead", { name: "X", email, query: "Sillas plásticas apilables para eventos" }, ip());
  const [alias, base, other] = B.attempts().slice(k);
  assert.ok(isQaOnly(alias), "alias listado → QA");
  assert.ok(isCommercial(base), "base → comercial");
  assert.ok(isCommercial(other), "otro alias → comercial");
});

test("B · informe del alias QA: a destinos externos se rechaza; si Resend rechaza su envío, el reenvío va solo a QA", async () => {
  const tok = await token(B, "qa1+compras@empresa.test");
  const k = B.attempts().length;
  assert.equal((await report(B, { recipientEmail: "qa1@empresa.test", requesterEmail: "qa1+compras@empresa.test", reportToken: tok })).status, 403);
  assert.equal(B.attempts().length, k);
  const r = await report(B, { recipientEmail: "qa1+compras@empresa.test", requesterEmail: "qa1+compras@empresa.test", reportToken: tok });
  assert.deepEqual(await r.json(), { success: true, delivered: false, forwarded: true });
  const tried = B.attempts().slice(k);
  assert.equal(tried.length, 2);
  assert.deepEqual(tried[1].to, QA_COPIES);
  for (const m of tried) for (const a of addrs(m)) assert.ok(a === "qa1+compras@empresa.test" || QA_COPIES.includes(a), a);
});

test("privacidad · ningún registro del servidor trae direcciones", () => {
  for (const S of [A, B, C]) assert.doesNotMatch(S.logs, /[\w.+-]+@[\w-]+\.[\w.]+/);
});
