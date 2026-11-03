// 02-11e — Informes iniciados por QA. Una solicitud de informe de una cuenta QA (QA_EMAILS) solo puede ir
// a una cuenta QA o al buzón QA, nunca a una dirección externa ni a ventas; se rechaza ANTES de contar
// el límite diario y antes de llamar a Resend. Sin enrutamiento QA válido no sale nada. Si Resend
// rechaza el destinatario, el reenvío de un informe QA va solo a los destinos QA.
// Servidor real; Resend simulado (test/fake-resend.mjs); búsqueda ficticia (test/fixtures). Nada sale.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "./fixtures/qa-server.mjs";

const QA_ENV = { QA_EMAILS: "qa1@prueba.test,qa2@prueba.test", QA_LEADS_EMAIL: "qa-inbox@example.test" };
const OK = server(5500, QA_ENV);
// Resend refuses these recipients (as an unverified one would)
const FAILTO = server(5700, { ...QA_ENV, RESEND_FAIL_TO: "^(qa2@prueba\\.test|rechazado@cliente\\.gt)$" });
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
async function token(s, email, ip) {
  const r = await s.post("/api/suppliers/search", { productType: "machinery", userQuery: "sillas plásticas apilables para eventos", quantity: "4", userEmail: email }, ip);
  assert.equal(r.status, 200);
  const t = (await r.json()).reportToken;
  assert.ok(t, "la búsqueda devolvió el token del informe");
  await wait(250); // the search notice is sent in the background
  return t;
}
const report = (s, body, ip) => s.post("/api/email/report", { totalCostText: "Q64,140.15 (US$8,119.01) sin flete", lang: "es", ...body }, ip);

test("1 · cuenta QA + destinatario externo, de ventas o «de prueba» por nombre → 403, nada intentado, límite intacto", async () => {
  const tok = await token(OK, "qa1@prueba.test", "10.5.0.1");
  const before = OK.attempts().length;
  // (each from its own IP: the general per-IP limiter of /api/email is not what is being measured)
  let ip = 10;
  // 02-11f: «QA1+informe@» is not a listed QA address: a «+etiqueta» is not assumed to reach qa1@
  for (const to of ["cliente@empresa.gt", SALES, "VENTAS+x@example.test", "prueba.demo@empresa.gt", "qa-dev@example.test", "QA1+informe@prueba.test", "qa-inbox+x@example.test"]) {
    const r = await report(OK, { recipientEmail: to, requesterEmail: "qa1@prueba.test", reportToken: tok }, `10.5.0.${ip++}`);
    assert.equal(r.status, 403, to);
    const body = await r.text();
    assert.deepEqual(JSON.parse(body), { error: "qa_recipient_not_allowed" });
    assert.doesNotMatch(body, /@/, "la respuesta no trae direcciones");
  }
  // more refused requests than the daily caps (10 per requester, 3 per recipient): none was counted
  for (let i = 0; i < 12; i++) assert.equal((await report(OK, { recipientEmail: "cliente@empresa.gt", requesterEmail: "qa1@prueba.test", reportToken: tok }, `10.5.0.${ip++}`)).status, 403);
  assert.equal(OK.attempts().length, before, "Resend no fue llamado");
  assert.match(OK.logs, /QA report refused \(qa_recipient_not_allowed\); nothing sent, no limit counted/);
  const ok = await report(OK, { recipientEmail: "qa1@prueba.test", requesterEmail: "qa1@prueba.test", reportToken: tok }, "10.5.0.1");
  assert.equal(ok.status, 200, "el límite no se consumió con los rechazos");
});

test("2 · cuenta QA + destinatario QA autorizado → enviado solo a destinos QA", async () => {
  const tok = await token(OK, "qa1@prueba.test", "10.5.0.2");
  for (const to of ["qa2@prueba.test", "QA1@Prueba.Test", "qa-inbox@example.test"]) {
    const n = OK.mails().length;
    const r = await report(OK, { recipientEmail: to, requesterEmail: "qa1@prueba.test", reportToken: tok }, "10.5.0.2");
    assert.equal(r.status, 200, to);
    assert.deepEqual(await r.json(), { success: true, delivered: true, forwarded: false });
    const m = OK.mails().slice(n);
    assert.equal(m.length, 1);
    assert.equal(m[0].to, to);
    // the recipient is not copied to itself (the QA inbox used to get the report twice)
    assert.deepEqual(m[0].bcc, QA_COPIES.filter((x) => x !== to));
    assertQaOnly(m);
  }
});

test("3 · enrutamiento QA ausente, inválido o solapado con ventas (también «ventas+qa@») → 503, ningún correo", async () => {
  for (const [s, status] of [[MISSING, "missing"], [INVALID, "invalid"], [OVERLAP, "overlaps_commercial"]]) {
    const h = await (await fetch(s.BASE + "/health")).json();
    assert.equal(h.qaRouting, status);
    assert.doesNotMatch(JSON.stringify(h), /@/);
    const tok = await token(s, "qa1@prueba.test", "10.5.1.1");
    for (const to of ["qa2@prueba.test", "qa1@prueba.test", "cliente@empresa.gt"]) {
      const r = await report(s, { recipientEmail: to, requesterEmail: "qa1@prueba.test", reportToken: tok }, "10.5.1.1");
      assert.equal(r.status, 503, `${status} ${to}`);
      assert.deepEqual(await r.json(), { error: "qa_routing_unavailable" });
    }
    // a real requester sending to a QA account is a QA operation too: refused the same way
    const realTok = await token(s, "lucia@importadora.gt", "10.5.1.2");
    assert.equal((await report(s, { recipientEmail: "qa2@prueba.test", requesterEmail: "lucia@importadora.gt", reportToken: realTok }, "10.5.1.2")).status, 503);
    await wait(200);
    // nothing QA was even attempted on this server (only the real client's search notice, to sales)
    for (const m of s.attempts()) assert.deepEqual(m.to, [SALES], `${status}: solo el aviso real a ventas`);
    assert.match(s.logs, /QA_ROUTING_UNAVAILABLE/);
  }
});

test("4 · cliente real + destinatario válido → envío normal, con límites existentes", async () => {
  const tok = await token(OK, "lucia@importadora.gt", "10.5.2.1");
  for (const to of ["lucia@importadora.gt", "gerencia@importadora.gt"]) {
    const n = OK.mails().length;
    const r = await report(OK, { recipientEmail: to, requesterEmail: "lucia@importadora.gt", reportToken: tok, recipientName: "Lucía" }, "10.5.2.1");
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { success: true, delivered: true, forwarded: false });
    const m = OK.mails().slice(n);
    assert.equal(m.length, 1);
    assert.equal(m[0].to, to);
    assert.deepEqual(m[0].bcc, [SALES]);
    assert.match(m[0].subject, /^Su informe SEAL/);
    assert.match(m[0].html, /Costo estimado preliminar, sin flete/);
  }
  // the per-recipient cap (3 a day) still applies
  for (let i = 0; i < 2; i++) assert.equal((await report(OK, { recipientEmail: "gerencia@importadora.gt", requesterEmail: "lucia@importadora.gt", reportToken: tok }, "10.5.2.1")).status, 200);
  assert.equal((await report(OK, { recipientEmail: "gerencia@importadora.gt", requesterEmail: "lucia@importadora.gt", reportToken: tok }, "10.5.2.1")).status, 429);
  // without the search token nothing is sent (unchanged)
  assert.equal((await report(OK, { recipientEmail: "x@importadora.gt", requesterEmail: "lucia@importadora.gt", reportToken: "malo" }, "10.5.2.1")).status, 403);
});

test("5 · Resend rechaza el destinatario de un informe QA → reenvío solo a QA, nunca a ventas ni afuera", async () => {
  const tok = await token(FAILTO, "qa1@prueba.test", "10.5.3.1");
  const n = FAILTO.attempts().length;
  const r = await report(FAILTO, { recipientEmail: "qa2@prueba.test", requesterEmail: "qa1@prueba.test", reportToken: tok }, "10.5.3.1");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { success: true, delivered: false, forwarded: true });
  const tried = FAILTO.attempts().slice(n);
  assert.equal(tried.length, 2, "el envío rechazado y un reenvío");
  assert.equal(tried[0].to, "qa2@prueba.test");
  assert.deepEqual(tried[1].to, QA_COPIES);
  assert.match(tried[1].subject, /^\[PRUEBA\] REENVIAR informe/);
  assertQaOnly(tried);
  assert.doesNotMatch(FAILTO.logs, /qa2@prueba|qa-inbox@|ventas@example/);
  assert.match(FAILTO.logs, /Report to QA recipient failed, forwarding to the QA inbox/);
});

test("5c · Resend rechaza el informe QA Y su reenvío → error 500 genérico; solo se intentaron destinos QA", async () => {
  const tok = await token(ALLFAIL, "qa1@prueba.test", "10.5.3.3");
  const n = ALLFAIL.attempts().length;
  const r = await report(ALLFAIL, { recipientEmail: "qa2@prueba.test", requesterEmail: "qa1@prueba.test", reportToken: tok }, "10.5.3.3");
  assert.equal(r.status, 500);
  const body = await r.text();
  assert.deepEqual(JSON.parse(body), { error: "Could not send email" });
  assert.doesNotMatch(body, /@/);
  const tried = ALLFAIL.attempts().slice(n);
  assert.equal(tried.length, 2, "el informe y un único reenvío, sin más reintentos");
  assertQaOnly(tried);
  assert.equal(ALLFAIL.mails().length, 0, "nada fue aceptado por el proveedor");
});

test("5b · el reenvío de un cliente real rechazado sigue yendo a ventas (sin cambio)", async () => {
  const tok = await token(FAILTO, "rechazado@cliente.gt", "10.5.3.2");
  const n = FAILTO.attempts().length;
  const r = await report(FAILTO, { recipientEmail: "rechazado@cliente.gt", requesterEmail: "rechazado@cliente.gt", reportToken: tok }, "10.5.3.2");
  assert.deepEqual(await r.json(), { success: true, delivered: false, forwarded: true });
  const tried = FAILTO.attempts().slice(n);
  assert.equal(tried.length, 2);
  assert.deepEqual(tried[1].to, [SALES]);
  assert.doesNotMatch(tried[1].subject, /PRUEBA/);
});

test("6-7 · consulta, búsqueda, caso e informe de una cuenta QA usan la misma regla: todo solo a QA", async () => {
  const n = OK.attempts().length;
  await OK.post("/api/email/lead", { name: "Ana [PRUEBA]", email: "qa2@prueba.test", query: "Sillas plásticas apilables para eventos" }, "10.5.4.1");
  // 02-11h: the report token belongs to the exact mailbox that searched: the token of «QA2+x@» does
  // not serve «qa2@» (it used to, through the broad quota key)
  const aliasTok = await token(OK, "QA2+x@prueba.test", "10.5.4.1");
  assert.equal((await report(OK, { recipientEmail: "qa2@prueba.test", requesterEmail: "qa2@prueba.test", reportToken: aliasTok }, "10.5.4.1")).status, 403);
  const tok = await token(OK, "qa2@prueba.test", "10.5.4.1");
  const q = await (await OK.post("/api/email/quote", { name: "Ana", email: "qa2@prueba.test", product: "Sillas plásticas" }, "10.5.4.1")).json();
  assert.equal(q.test, true);
  assert.equal((await report(OK, { recipientEmail: "externo@empresa.gt", requesterEmail: "qa2@prueba.test", reportToken: tok }, "10.5.4.1")).status, 403);
  assert.equal((await report(OK, { recipientEmail: "qa2@prueba.test", requesterEmail: "qa2@prueba.test", reportToken: tok }, "10.5.4.1")).status, 200);
  // a real requester sending to a QA account: a QA operation (QA copies, not sales)
  const realTok = await token(OK, "pedro@importadora.gt", "10.5.4.2");
  const before = OK.attempts().length;
  assert.equal((await report(OK, { recipientEmail: "qa1@prueba.test", requesterEmail: "pedro@importadora.gt", reportToken: realTok }, "10.5.4.2")).status, 200);
  const toQa = OK.attempts().slice(before);
  assert.deepEqual(toQa.map((m) => m.bcc), [QA_COPIES]);
  // every QA send of this test (lead, search, case, report) stayed within QA destinations
  const qaOps = OK.attempts().slice(n).filter((m) => !/pedro@importadora/.test(m.subject || "") && !(m.to || []).includes(SALES));
  assert.equal(qaOps.length, 5, "consulta, búsqueda, caso, informe QA e informe a cuenta QA");
  assertQaOnly(qaOps);
  // the only sends to sales in this test: the real requester's search and «QA2+x@»'s (02-11i: an alias
  // not listed in QA_EMAILS is not a QA account) — no QA operation reached sales
  const toSales = OK.attempts().slice(n).filter((m) => addrs(m).some((x) => x.includes("ventas")));
  assert.equal(toSales.length, 2, JSON.stringify(toSales.map((m) => m.subject)));
  for (const m of toSales) assert.doesNotMatch(m.subject, /PRUEBA/);
  // the real requester's own search notice went to sales (unchanged)
  assert.ok(OK.attempts().slice(n).some((m) => [].concat(m.to).includes(SALES) && /Búsqueda/.test(m.subject)));
});

test("privacidad · ningún registro del servidor trae direcciones", () => {
  for (const s of ALL) assert.doesNotMatch(s.logs, /qa1@prueba|qa2@prueba|qa-inbox@|qa-dev@|ventas@example|ventas\+qa|cliente@empresa|lucia@|pedro@|rechazado@|gerencia@|externo@/i);
});
