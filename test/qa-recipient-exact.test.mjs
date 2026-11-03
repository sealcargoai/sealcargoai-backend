// 02-11f — Destinatarios de informes QA por buzón EXACTO.
// emailKey() quita «+etiqueta» en cualquier dominio (sirve para cuotas e identificación), pero autorizar
// un destinatario con esa regla aceptaba «qa+otra-cuenta@dominio» como si fuera qa@dominio, y eso solo es
// cierto si el dominio entrega los alias «+» al buzón base. Ahora: dirección exacta (espacios y
// mayúsculas normalizados); alias solo si están escritos en QA_EMAILS; puntos y «+» solo en Gmail
// (regla documentada por Google). Ventas se rechaza en cualquier variante.
// Parte 1: tabla de la regla (funciones del servidor). Parte 2: servidor real, Resend simulado.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "./fixtures/qa-server.mjs";
import { verifyEmail } from "./fixtures/verify.mjs";

const QA_ENV = {
  // con espacios y mayúsculas a propósito; «qa+informes@» es un alias configurado EXPRESAMENTE
  // «ventas+qa@» listed by mistake as a QA account: as a recipient it is still sales and is refused
  QA_EMAILS: " QA1@prueba.test ,Qa.Dos@prueba.test, qa+informes@prueba.test,qa.gmail@gmail.com,ventas+qa@example.test",
  QA_LEADS_EMAIL: "QA-Inbox@example.test",
  LEADS_EMAIL: "ventas@example.test",
  LEADS_CC: "comercial@example.test",
  QA_NOTIFY_EMAILS: "qa-dev@example.test",
};

// ── Parte 1 ─────────────────────────────────────────────────────────────────────────────────
Object.assign(process.env, { ADMIN_EMAIL: "", ADMIN2_EMAIL: "", ...QA_ENV });
const { qaRecipientAllowed, reportRouting, qaRouting } = await import("../src/services/email.js");
const { mailboxAddress, emailKey } = await import("../src/services/quotaStore.js");

const ALLOWED = [
  ["qa1@prueba.test", "coincidencia exacta"],
  ["  QA1@PRUEBA.TEST  ", "mayúsculas y espacios externos"],
  ["qa.dos@prueba.test", "otra cuenta listada (en mayúsculas en la lista)"],
  ["qa+informes@prueba.test", "alias «+» configurado expresamente"],
  ["QA+Informes@Prueba.Test", "el alias configurado, en mayúsculas"],
  ["qa-inbox@example.test", "buzón QA"],
  ["qagmail@gmail.com", "Gmail: los puntos no cuentan (regla de Google)"],
  ["q.a.gmail+informe@googlemail.com", "Gmail: «+» y googlemail.com llegan al mismo buzón (regla de Google)"],
];
const REFUSED = [
  ["qa1+otra@prueba.test", "«+etiqueta» no configurada"],
  ["qa1+@prueba.test", "«+» vacío"],
  ["qa+otra-cuenta@prueba.test", "otro alias del alias configurado"],
  ["qa@prueba.test", "la base de un alias configurado no queda autorizada"],
  ["q.a1@prueba.test", "puntos fuera de Gmail no se ignoran"],
  ["qados@prueba.test", "sin el punto de la cuenta listada (no es Gmail)"],
  ["qa-inbox+x@example.test", "alias del buzón QA no configurado"],
  ["ventas@example.test", "ventas"],
  ["VENTAS@EXAMPLE.TEST", "ventas en mayúsculas"],
  ["ventas+qa@example.test", "alias de ventas"],
  ["comercial+x@example.test", "alias de la copia comercial"],
  ["cliente@empresa.gt", "externo"],
  ["prueba.demo@empresa.gt", "externo con «prueba» en el nombre"],
  ["qa-dev@example.test", "copia de desarrollo (no es destinatario de informes)"],
  ["qa1@prueba", "formato inválido"],
  ["qa1@@prueba.test", "formato inválido"],
  ["", "vacío"],
  // pasada 1 (evasión): formatos que podrían colar una segunda dirección o un buzón parecido
  ["Ana <qa1@prueba.test>", "nombre visible con dirección"],
  ["qa1@prueba.test,cliente@empresa.gt", "lista separada por coma"],
  ["qa1@prueba.test;cliente@empresa.gt", "lista separada por punto y coma"],
  ["qa1@prueba.test\ncliente@empresa.gt", "salto de línea con otra dirección"],
  ['"qa1"@prueba.test', "parte local entre comillas"],
  ["qa1@prueba.test.", "dominio con punto final"],
  ["q\u04301@prueba.test", "letra cirílica parecida"],
  [`${"a".repeat(250)}@prueba.test`, "más de 254 caracteres"],
];

test("tabla · destinatarios autorizados (exactos, alias expresos, regla de Gmail)", () => {
  assert.equal(qaRouting(), "ok");
  for (const [to, why] of ALLOWED) assert.equal(qaRecipientAllowed(to), true, `${why}: ${to}`);
});
test("tabla · destinatarios rechazados (alias no configurados, ventas, externos, inválidos)", () => {
  for (const [to, why] of REFUSED) {
    assert.equal(qaRecipientAllowed(to), false, `${why}: ${to}`);
    assert.equal(reportRouting(to, "qa1@prueba.test").ok, false, `informe QA → ${why}`);
  }
});
test("tabla · la normalización de cuotas sigue siendo amplia; la de autorización no", () => {
  assert.equal(emailKey("qa1+otra@prueba.test"), "qa1@prueba.test");
  assert.equal(mailboxAddress("qa1+otra@prueba.test"), "qa1+otra@prueba.test");
  assert.equal(mailboxAddress(" Q.A1@Prueba.Test "), "q.a1@prueba.test");
  assert.equal(mailboxAddress("Q.A+x@GoogleMail.com"), "qa@gmail.com");
  assert.equal(mailboxAddress("+x@gmail.com"), "");
});
test("tabla · un cliente real sigue siendo una operación comercial", () => {
  assert.deepEqual(reportRouting("gerencia@importadora.gt", "lucia@importadora.gt"), { test: false, ok: true });
});

// ── Parte 2 ─────────────────────────────────────────────────────────────────────────────────
// 02-11k: a report goes only to the requester's own mailbox, proved with a code (one-use grant). The QA
// recipient rule above still applies to that mailbox (a QA requester must be a listed QA address).
const OK = server(6700, QA_ENV);
const FAILTO = server(6900, { ...QA_ENV, RESEND_FAIL_TO: "^(qa\\.dos@prueba\\.test|rechazada@cliente\\.gt)$", RESEND_FAIL_SUBJECT: "estimación preliminar" });
const CONC = server(7300, QA_ENV);
const ALL = [OK, FAILTO, CONC];
before(async () => {
  for (const s of ALL) await s.start();
});
after(async () => {
  for (const s of ALL) await s.stop();
});
const COMMERCIAL = /ventas|comercial/i;
const QA_DEST = new Set(["qa1@prueba.test", "qa.dos@prueba.test", "qa+informes@prueba.test", "qa.gmail@gmail.com", "qa-inbox@example.test", "qa-dev@example.test"]);
const addrs = (m) => [].concat(m.to || [], m.cc || [], m.bcc || []).map((x) => String(x).trim().toLowerCase());
let ipN = 1;
const ip = () => `10.7.${Math.floor(ipN / 200)}.${(ipN++ % 200) + 1}`; // the per-IP /api/email limiter is not what is measured
const grant = async (s, email) => (await verifyEmail(s, email, ip())).reportGrant;
// a real (tiny) PDF: a refusal must happen before it is even read
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");
const report = (s, body) => s.post("/api/email/report", { totalCostText: "Q64,140.15 (US$8,119.01) sin flete", lang: "es", pdfBase64: PDF, ...body }, ip());

test("servidor · a cualquier otro destinatario (externo, ventas, alias, inválido): rechazado sin direcciones, CERO llamadas a Resend, límites y autorización intactos", async () => {
  const g = await grant(OK, "qa1@prueba.test");
  const before = OK.attempts().length;
  for (const [to, why] of REFUSED) {
    if (!to) continue;
    for (let i = 0; i < 3; i++) {
      const r = await report(OK, { recipientEmail: to, requesterEmail: "qa1@prueba.test", reportGrant: g });
      const body = await r.text();
      assert.ok(r.status === 403 || r.status === 400, `${why}: ${JSON.stringify(to)} → ${r.status}`);
      assert.doesNotMatch(body, /@/, "la respuesta no trae direcciones");
    }
  }
  assert.equal(OK.attempts().length, before, "Resend no fue llamado por ningún rechazo");
  // neither the grant nor the caps were used: the same grant still sends ONE report to the own mailbox
  assert.equal((await report(OK, { requesterEmail: "qa1@prueba.test", reportGrant: g })).status, 200);
});

test("servidor · el informe al propio buzón QA: solo destinos QA; el buzón QA no se copia a sí mismo", async () => {
  for (const email of ["qa.dos@prueba.test", "QA+Informes@Prueba.Test", "q.a.gmail+informe@googlemail.com"]) {
    const g = await grant(OK, email);
    const n = OK.attempts().length;
    const r = await report(OK, { requesterEmail: email, reportGrant: g });
    assert.equal(r.status, 200, email);
    const m = OK.attempts().slice(n);
    assert.equal(m.length, 1);
    for (const a of addrs(m[0])) {
      assert.doesNotMatch(a, COMMERCIAL, `${email}: nunca ventas`);
      assert.ok(QA_DEST.has(a) || a === email.trim().toLowerCase(), `${email}: solo destinos QA (${a})`);
    }
    assert.ok((m[0].bcc || []).includes("qa-inbox@example.test"), "copia al buzón QA");
  }
});

test("servidor · Resend rechaza un informe QA: el reenvío va solo a destinos QA (ni ventas ni el externo)", async () => {
  const g = await grant(FAILTO, "qa.dos@prueba.test");
  const n = FAILTO.attempts().length;
  const r = await report(FAILTO, { requesterEmail: "qa.dos@prueba.test", reportGrant: g });
  assert.deepEqual(await r.json(), { success: true, delivered: false, forwarded: true });
  const tried = FAILTO.attempts().slice(n);
  assert.equal(tried.length, 2);
  assert.deepEqual(tried[1].to, ["qa-inbox@example.test", "qa-dev@example.test"]);
  for (const m of tried) for (const a of addrs(m)) assert.ok(QA_DEST.has(a) && !COMMERCIAL.test(a), a);
});

test("servidor · cliente real válido: flujo comercial (BCC a ventas y copia comercial; si Resend rechaza, reenvío a ventas)", async () => {
  const g = await grant(OK, "Gerencia@Importadora.gt");
  const n = OK.attempts().length;
  const r = await report(OK, { requesterEmail: "gerencia@importadora.gt", reportGrant: g });
  assert.deepEqual(await r.json(), { success: true, delivered: true, forwarded: false });
  const m = OK.attempts().slice(n);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].bcc, ["ventas@example.test", "comercial@example.test"]);
  assert.doesNotMatch(m[0].subject, /PRUEBA/);
  const g2 = await grant(FAILTO, "rechazada@cliente.gt");
  const k = FAILTO.attempts().length;
  const f = await report(FAILTO, { requesterEmail: "rechazada@cliente.gt", reportGrant: g2 });
  assert.deepEqual(await f.json(), { success: true, delivered: false, forwarded: true });
  assert.deepEqual(FAILTO.attempts().slice(k)[1].to, ["ventas@example.test", "comercial@example.test"]);
});

test("concurrencia · 6 informes válidos (cada uno con su autorización) y 6 rechazados a la vez: exactamente 3 pasan el tope; los rechazos no cuentan", async () => {
  const S = CONC;
  const grants = [];
  for (let i = 0; i < 6; i++) grants.push(await grant(S, "qa+informes@prueba.test"));
  const before = S.attempts().length;
  const bodies = [];
  for (let i = 0; i < 6; i++) {
    bodies.push({ recipientEmail: "qa+otra@prueba.test", requesterEmail: "qa+informes@prueba.test", reportGrant: grants[i] });
    bodies.push({ requesterEmail: "qa+informes@prueba.test", reportGrant: grants[i] });
  }
  const st = await Promise.all(bodies.map((b) => report(S, b).then((r) => r.status)));
  const refused = st.filter((_, i) => i % 2 === 0), sent = st.filter((_, i) => i % 2 === 1);
  assert.deepEqual(refused, [403, 403, 403, 403, 403, 403]);
  assert.equal(sent.filter((x) => x === 200).length, 3, JSON.stringify(sent));
  assert.equal(sent.filter((x) => x === 429).length, 3);
  assert.equal(S.attempts().length - before, 3, "solo los 3 aceptados llegaron a Resend");
});

test("privacidad · ningún registro del servidor trae direcciones", () => {
  for (const s of ALL) assert.doesNotMatch(s.logs, /[\w.+-]+@[\w-]+\.[\w.]+/);
});
