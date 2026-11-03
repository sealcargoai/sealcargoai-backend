// 02-11i — Clasificación QA por identidad exacta.
// Defecto reproducido: con QA_EMAILS=qa1@empresa.test, una consulta de «qa1+compras@empresa.test» se
// clasificaba como QA ([PRUEBA], buzón QA) porque isQa() usaba la clave amplia de cuotas (emailKey quita
// «+etiqueta» en cualquier dominio). Ahora QA = dirección exacta escrita en QA_EMAILS (mayúsculas y
// espacios normalizados; puntos y «+» solo en gmail.com / googlemail.com, regla documentada por Google).
// Servidor real; Resend simulado; búsqueda ficticia. Nada sale.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "./fixtures/qa-server.mjs";
import { verifyEmail } from "./fixtures/verify.mjs";

const BASE_ENV = { QA_LEADS_EMAIL: "qa-inbox@example.test", LEADS_EMAIL: "ventas@example.test", LEADS_CC: "", QA_NOTIFY_EMAILS: "qa-dev@example.test" };
// A: only the base account is listed (the reproduced case)
const A = server(7900, { ...BASE_ENV, QA_EMAILS: "qa1@empresa.test,ana.qa@gmail.com" });
// C: same as A, only for the search-limit test (aliases share the broad quota key: it starts empty here)
const C = server(8300, { ...BASE_ENV, QA_EMAILS: "qa1@empresa.test,ana.qa@gmail.com" });
// B: only the «+» alias is listed expressly; Resend refuses that alias (to test the QA forward)
const B = server(8100, { ...BASE_ENV, QA_EMAILS: "qa1+compras@empresa.test", RESEND_FAIL_TO: "^qa1\\+compras@empresa\\.test$", RESEND_FAIL_SUBJECT: "estimación preliminar" });
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
const search = (S, email, q = "sillas plásticas apilables para eventos", verifiedSession) => S.post("/api/suppliers/search", { productType: "machinery", userQuery: q, quantity: "4", userEmail: email, ...(verifiedSession ? { verifiedSession } : {}) }, ip());
// 02-11k: report authorization = a one-use grant after proving control of the address with a code
const grant = async (S, email) => (await verifyEmail(S, email, ip())).reportGrant;
const report = (S, body) => S.post("/api/email/report", { totalCostText: "Q1,000.00", lang: "es", ...body }, ip());
const isCommercial = (m) => addrs(m).includes("ventas@example.test") && !/PRUEBA/.test(m.subject) && !addrs(m).some((a) => QA_COPIES.includes(a));
const isQaOnly = (m) => /^\[PRUEBA\]/.test(m.subject) && addrs(m).every((a) => QA_COPIES.includes(a));

test("A · caso reproducido: QA_EMAILS=qa1@ → «qa1+compras@» va por el flujo comercial (consulta, búsqueda y caso)", async () => {
  const k = A.attempts().length;
  assert.equal((await A.post("/api/email/lead", { name: "Compras", email: "qa1+compras@empresa.test", query: "Sillas plásticas apilables para eventos" }, ip())).status, 200);
  assert.equal((await search(A, "qa1+compras@empresa.test")).status, 200);
  await wait(250);
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

test("A · «qa1+compras@» conserva sus límites normales de búsqueda; «qa1@» (QA) no tiene límite solo con sesión verificada", async () => {
  const products = ["mesas plegables de plástico", "carpas para eventos 3x3", "manteles de poliéster"];
  // 02-11k: the QA account skips the limits only with a verified session of its own address
  const v = await verifyEmail(C, "qa1@empresa.test", ip());
  for (const p of [...products, "sillas tiffany de resina", "tarimas modulares de aluminio"]) assert.equal((await search(C, "qa1@empresa.test", p, v.session)).status, 200);
  const codes = [];
  for (const p of [...products, "vasos de vidrio templado"]) codes.push((await search(C, "qa1+compras@empresa.test", p)).status);
  assert.deepEqual(codes, [200, 200, 200, 429], "el límite normal (3) del cliente, intacto");
});

test("A · autorizaciones: «qa1+otro@» y «qa1@» no comparten la del otro; la cuenta QA solo se envía el informe a sí misma", async () => {
  const qaG = await grant(A, "qa1@empresa.test");
  const aliasG = await grant(A, "qa1+otro@empresa.test");
  const k = A.attempts().length;
  const bad = Buffer.from("no es un PDF").toString("base64");
  for (const [body, status, error] of [
    [{ requesterEmail: "qa1@empresa.test", reportGrant: aliasG }, 403, "report_not_allowed"],
    [{ requesterEmail: "qa1+otro@empresa.test", reportGrant: qaG }, 403, "report_not_allowed"],
    [{ recipientEmail: "cliente@externo.gt", requesterEmail: "qa1@empresa.test", reportGrant: qaG, pdfBase64: bad }, 403, "recipient_must_be_requester"],
    [{ recipientEmail: "qa1+compras@empresa.test", requesterEmail: "qa1@empresa.test", reportGrant: qaG, pdfBase64: bad }, 403, "recipient_must_be_requester"],
    [{ recipientEmail: "Ventas+x@Example.test", requesterEmail: "QA1@EMPRESA.TEST", reportGrant: qaG, pdfBase64: bad }, 403, "recipient_must_be_requester"],
    [{ recipientEmail: "k\u200Ba@externo.gt", requesterEmail: "qa1@empresa.test", reportGrant: qaG }, 400, "email_not_supported"],
  ]) {
    const r = await report(A, body);
    assert.equal(r.status, status, JSON.stringify(body.recipientEmail));
    assert.equal((await r.json()).error, error);
  }
  assert.equal(A.attempts().length, k, "Resend no fue llamado; el PDF inválido no llegó a revisarse");
  // the refusals did not use the grant nor the limits: 3 reports to itself (a grant each), then the cap
  assert.equal((await report(A, { requesterEmail: "qa1@empresa.test", reportGrant: qaG })).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await report(A, { requesterEmail: "qa1@empresa.test", reportGrant: await grant(A, "qa1@empresa.test") })).status, 200);
  assert.equal((await report(A, { requesterEmail: "qa1@empresa.test", reportGrant: await grant(A, "qa1@empresa.test") })).status, 429);
});

test("A · «qa1+otro@» (no listado) envía su propio informe por el flujo comercial habitual; QA no consumió su tope", async () => {
  const g = await grant(A, "qa1+otro@empresa.test");
  const k = A.attempts().length;
  const r = await report(A, { requesterEmail: "qa1+otro@empresa.test", reportGrant: g });
  assert.deepEqual(await r.json(), { success: true, delivered: true, forwarded: false });
  const m = A.attempts().slice(k);
  assert.equal(m.length, 1);
  assert.equal(m[0].to, "qa1+otro@empresa.test");
  assert.deepEqual(m[0].bcc, ["ventas@example.test"]);
});

test("A · Gmail: puntos y «+» sí son la misma cuenta QA (regla documentada); Workspace no", async () => {
  const k = A.attempts().length;
  await A.post("/api/email/lead", { name: "Ana", email: "a.n.a.qa+pruebas@googlemail.com", query: "Sillas plásticas apilables para eventos" }, ip());
  assert.ok(isQaOnly(A.attempts().slice(k)[0]), "Gmail: QA");
  const g = await grant(A, "anaqa@gmail.com");
  assert.equal((await report(A, { recipientEmail: "ana.qa+informe@gmail.com", requesterEmail: "a.n.a.q.a@googlemail.com", reportGrant: g })).status, 200, "Gmail: misma identidad");
});

test("A · el caso de «qa1+compras@» (real) y el de «qa1@» (QA) no se fusionan", async () => {
  const body = { name: "X", product: "Tarimas modulares de aluminio" };
  const real = await (await A.post("/api/email/quote", { ...body, email: "qa1+compras@empresa.test" }, ip())).json();
  const qa = await (await A.post("/api/email/quote", { ...body, email: "qa1@empresa.test" }, ip())).json();
  assert.deepEqual([real.duplicate, real.test, qa.duplicate, qa.test], [false, false, false, true]);
  assert.notEqual(real.id, qa.id);
  // (02-11k: a repeat without the case token changes nothing and hands out no case number)
  const again = await (await A.post("/api/email/quote", { ...body, email: "qa1+compras@empresa.test" }, ip())).json();
  assert.deepEqual([again.duplicate, again.unchanged, again.id], [true, true, undefined]);
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
  const g = await grant(B, "qa1+compras@empresa.test");
  const k = B.attempts().length;
  assert.equal((await report(B, { recipientEmail: "qa1@empresa.test", requesterEmail: "qa1+compras@empresa.test", reportGrant: g })).status, 403);
  assert.equal(B.attempts().length, k);
  const r = await report(B, { recipientEmail: "qa1+compras@empresa.test", requesterEmail: "qa1+compras@empresa.test", reportGrant: g });
  assert.deepEqual(await r.json(), { success: true, delivered: false, forwarded: true });
  const tried = B.attempts().slice(k);
  assert.equal(tried.length, 2);
  assert.deepEqual(tried[1].to, QA_COPIES);
  for (const m of tried) for (const a of addrs(m)) assert.ok(a === "qa1+compras@empresa.test" || QA_COPIES.includes(a), a);
});

test("privacidad · ningún registro del servidor trae direcciones", () => {
  for (const S of [A, B, C]) assert.doesNotMatch(S.logs, /[\w.+-]+@[\w-]+\.[\w.]+/);
});
