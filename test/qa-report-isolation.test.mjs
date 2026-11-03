// 02-11k: los informes van solo al buzón propio verificado del solicitante (código → autorización de un uso).
// 02-11e — Informes iniciados por QA. Una solicitud de informe de una cuenta QA (QA_EMAILS) solo puede ir
// a una cuenta QA o al buzón QA, nunca a una dirección externa ni a ventas; se rechaza ANTES de contar
// el límite diario y antes de llamar a Resend. Sin enrutamiento QA válido no sale nada. Si Resend
// rechaza el destinatario, el reenvío de un informe QA va solo a los destinos QA.
// Servidor real; Resend simulado (test/fake-resend.mjs); búsqueda ficticia (test/fixtures). Nada sale.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "./fixtures/qa-server.mjs";
import { verifyEmail } from "./fixtures/verify.mjs";

const QA_ENV = { QA_EMAILS: "qa1@prueba.test,qa2@prueba.test", QA_LEADS_EMAIL: "qa-inbox@example.test" };
const OK = server(5500, QA_ENV);
// Resend refuses these recipients (as an unverified one would)
const FAILTO = server(5700, { ...QA_ENV, RESEND_FAIL_TO: "^(qa2@prueba\\.test|rechazado@cliente\\.gt)$", RESEND_FAIL_SUBJECT: "estimación preliminar" });
const MISSING = server(5900, { QA_EMAILS: QA_ENV.QA_EMAILS });
const INVALID = server(6100, { QA_EMAILS: QA_ENV.QA_EMAILS, QA_LEADS_EMAIL: "no-es-un-correo" });
// «ventas+qa@» is delivered to ventas@: it must count as an overlap with sales
const OVERLAP = server(6300, { QA_EMAILS: QA_ENV.QA_EMAILS, QA_LEADS_EMAIL: "Ventas+qa@example.test" });
// Resend refuses EVERYTHING (the report and its forward)
const ALLFAIL = server(6500, { ...QA_ENV, RESEND_FAIL: "1" });
const ALL = [OK, FAILTO, MISSING, INVALID, OVERLAP, ALLFAIL];
before(async () => {
  for (const s of ALL) await s.start();
});
after(async () => {
  for (const s of ALL) await s.stop();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SALES = "ventas@example.test";
const QA_COPIES = ["qa-inbox@example.test", "qa-dev@example.test"];
// every address a QA operation may reach: the QA accounts, the QA inbox and the QA dev copy
const QA_ALLOWED = new Set(["qa1@prueba.test", "qa2@prueba.test", ...QA_COPIES]);
const addrs = (m) => [].concat(m.to || [], m.cc || [], m.bcc || []).map((x) => String(x).toLowerCase());
/** Requirement 6: to, cc and bcc of a QA operation never include sales or an outside address. */
function assertQaOnly(mails) {
  for (const m of mails)
    for (const a of addrs(m)) {
      assert.ok(!/ventas/.test(a), `QA nunca a ventas (${a})`);
      assert.ok(QA_ALLOWED.has(a.replace(/\+[^@]*@/, "@")), `QA solo a destinos QA (${a})`);
    }
}
// 02-11k: report authorization = proof of control of the requester's own address (code → one-use grant)
let ipN = 1;
const ipx = () => `10.5.${Math.floor(ipN / 200)}.${(ipN++ % 200) + 1}`;
const grant = async (s, email) => (await verifyEmail(s, email, ipx())).reportGrant;
const report = (s, body) => s.post("/api/email/report", { totalCostText: "Q64,140.15 (US$8,119.01) sin flete", lang: "es", ...body }, ipx());
const notCode = (m) => !/código de verificación/i.test(m.subject || "");

test("1 · cuenta QA: a cualquier otro destinatario (externo, ventas, otra cuenta QA, buzón QA) → 403, nada intentado, límite intacto", async () => {
  const g = await grant(OK, "qa1@prueba.test");
  const before = OK.attempts().length;
  for (const to of ["cliente@empresa.gt", SALES, "VENTAS+x@example.test", "prueba.demo@empresa.gt", "qa-dev@example.test", "QA1+informe@prueba.test", "qa-inbox@example.test", "qa2@prueba.test"]) {
    const r = await report(OK, { recipientEmail: to, requesterEmail: "qa1@prueba.test", reportGrant: g });
    assert.equal(r.status, 403, to);
    const body = await r.text();
    assert.equal(JSON.parse(body).error, "recipient_must_be_requester");
    assert.doesNotMatch(body, /@/, "la respuesta no trae direcciones");
  }
  for (let i = 0; i < 12; i++) assert.equal((await report(OK, { recipientEmail: "cliente@empresa.gt", requesterEmail: "qa1@prueba.test", reportGrant: g })).status, 403);
  assert.equal(OK.attempts().length, before, "Resend no fue llamado");
  const ok = await report(OK, { requesterEmail: "qa1@prueba.test", reportGrant: g });
  assert.equal(ok.status, 200, "ni la autorización ni el límite se consumieron con los rechazos");
});

test("2 · cuenta QA → su propio buzón: solo destinos QA", async () => {
  const g = await grant(OK, "qa2@prueba.test");
  const n = OK.attempts().length;
  const r = await report(OK, { requesterEmail: "qa2@prueba.test", reportGrant: g });
  assert.deepEqual(await r.json(), { success: true, delivered: true, forwarded: false });
  const m = OK.attempts().slice(n);
  assert.equal(m.length, 1);
  assert.equal(m[0].to, "qa2@prueba.test");
  assert.deepEqual(m[0].bcc, QA_COPIES);
  assertQaOnly(m);
});

test("3 · enrutamiento QA ausente, inválido o solapado con ventas → 503, ningún correo de prueba", async () => {
  for (const [s, status] of [[MISSING, "missing"], [INVALID, "invalid"], [OVERLAP, "overlaps_commercial"]]) {
    const h = await (await fetch(s.BASE + "/health")).json();
    assert.equal(h.qaRouting, status);
    assert.doesNotMatch(JSON.stringify(h), /@/);
    const g = await grant(s, "qa1@prueba.test");
    const n = s.attempts().length;
    const r = await report(s, { requesterEmail: "qa1@prueba.test", reportGrant: g });
    assert.equal(r.status, 503, status);
    assert.deepEqual(await r.json(), { error: "qa_routing_unavailable" });
    await wait(200);
    assert.equal(s.attempts().length, n, `${status}: nada intentado`);
    assert.match(s.logs, /QA report refused \(qa_routing_unavailable\)/);
  }
});

test("4 · cliente real → su propio buzón: envío normal con copia a ventas y límites existentes", async () => {
  const n = OK.attempts().length;
  const r = await report(OK, { requesterEmail: "lucia@importadora.gt", reportGrant: await grant(OK, "lucia@importadora.gt") });
  assert.deepEqual(await r.json(), { success: true, delivered: true, forwarded: false });
  const m = OK.attempts().slice(n).filter(notCode);
  assert.equal(m.length, 1);
  assert.equal(m[0].to, "lucia@importadora.gt");
  assert.deepEqual(m[0].bcc, [SALES]);
  assert.match(m[0].subject, /^Su estimación preliminar/);
  assert.match(m[0].html, /Costo estimado preliminar, sin flete/);
  // the per-recipient cap (3 a day) still applies
  for (let i = 0; i < 2; i++) assert.equal((await report(OK, { requesterEmail: "lucia@importadora.gt", reportGrant: await grant(OK, "lucia@importadora.gt") })).status, 200);
  assert.equal((await report(OK, { requesterEmail: "lucia@importadora.gt", reportGrant: await grant(OK, "lucia@importadora.gt") })).status, 429);
  // without a grant nothing is sent
  assert.equal((await report(OK, { requesterEmail: "lucia@importadora.gt", reportGrant: "malo-malo-malo-malo-malo" })).status, 403);
});

test("5 · Resend rechaza un informe QA → reenvío solo a QA; 5b el de un cliente real va a ventas; 5c fallo total → 500 genérico", async () => {
  let n = FAILTO.attempts().length;
  const g = await grant(FAILTO, "qa2@prueba.test");
  n = FAILTO.attempts().length;
  const r = await report(FAILTO, { requesterEmail: "qa2@prueba.test", reportGrant: g });
  assert.deepEqual(await r.json(), { success: true, delivered: false, forwarded: true });
  const tried = FAILTO.attempts().slice(n);
  assert.equal(tried.length, 2);
  assert.deepEqual(tried[1].to, QA_COPIES);
  assert.match(tried[1].subject, /^\[PRUEBA\] REENVIAR informe/);
  assertQaOnly(tried);
  const g2 = await grant(FAILTO, "rechazado@cliente.gt");
  n = FAILTO.attempts().length;
  const f = await report(FAILTO, { requesterEmail: "rechazado@cliente.gt", reportGrant: g2 });
  assert.deepEqual(await f.json(), { success: true, delivered: false, forwarded: true });
  assert.deepEqual(FAILTO.attempts().slice(n)[1].to, [SALES]);
  // total failure: no code can be emailed either → verification itself fails (500), nothing sent
  const st = await ALLFAIL.post("/api/email/verify/start", { email: "qa2@prueba.test" }, ipx());
  assert.equal(st.status, 500);
  assert.equal(ALLFAIL.mails().length, 0);
});

test("6-7 · consulta, búsqueda, caso e informe de una cuenta QA: todo solo a QA; nada QA llega a ventas", async () => {
  const n = OK.attempts().length;
  await OK.post("/api/email/lead", { name: "Ana [PRUEBA]", email: "qa2@prueba.test", query: "Sillas plásticas apilables para eventos" }, ipx());
  await OK.post("/api/suppliers/search", { productType: "machinery", userQuery: "sillas plásticas apilables para eventos", quantity: "4", userEmail: "qa2@prueba.test" }, ipx());
  await wait(250);
  const q = await (await OK.post("/api/email/quote", { name: "Ana", email: "qa2@prueba.test", product: "Sillas plásticas" }, ipx())).json();
  assert.equal(q.test, true);
  const v = await verifyEmail(OK, "qa2@prueba.test", ipx());
  assert.equal((await report(OK, { requesterEmail: "qa2@prueba.test", reportGrant: v.reportGrant })).status, 200);
  const ops = OK.attempts().slice(n).filter(notCode);
  assert.equal(ops.length, 4, "consulta, búsqueda, caso, informe");
  assertQaOnly(ops);
});

test("privacidad · ningún registro del servidor trae direcciones", () => {
  for (const s of ALL) assert.doesNotMatch(s.logs, /qa1@prueba|qa2@prueba|qa-inbox@|qa-dev@|ventas@example|ventas\+qa|cliente@empresa|lucia@|pedro@|rechazado@|gerencia@|externo@/i);
});
