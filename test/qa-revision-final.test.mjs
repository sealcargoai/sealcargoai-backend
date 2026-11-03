// 02-11g — Revisión final de autorización QA. Dos defectos reales:
//  A) Unicode: toLowerCase() convierte el signo Kelvin «K» en «k»; «Ka@dominio» se autorizaba
//     como «ka@dominio» (cuenta QA) pero a Resend se le entregaba la dirección original, otro buzón.
//  B) Clasificación: un alias «+» escrito en QA_EMAILS («juan+qa@empresa») convertía en QA a la dirección
//     base («juan@empresa»), que puede ser un cliente real: sus casos iban al buzón QA, no a ventas, y
//     quedaba sin límite de búsquedas.
// Parte 1: funciones del servidor. Parte 2: servidor real con Resend simulado y datos ficticios.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "./fixtures/qa-server.mjs";

const QA_ENV = {
  QA_EMAILS: "qa1@prueba.test,juan+qa@empresa-cliente.gt,ka@prueba.test,qa.workspace@seal-workspace.test,Ana.QA+informes@Gmail.com",
  QA_LEADS_EMAIL: "qa-inbox@example.test",
  LEADS_EMAIL: "ventas@example.test",
  LEADS_CC: "",
  QA_NOTIFY_EMAILS: "qa-dev@example.test",
};
Object.assign(process.env, { ADMIN_EMAIL: "", ADMIN2_EMAIL: "", ...QA_ENV });
const { qaRecipientAllowed, reportRouting, isTestRecord } = await import("../src/services/email.js");
const { isQa, mailboxAddress } = await import("../src/services/quotaStore.js");

test("A · Unicode: una letra que se convierte en ASCII al pasar a minúsculas no autoriza un buzón QA", () => {
  assert.equal("Ka@prueba.test".toLowerCase(), "ka@prueba.test", "(premisa: el plegado existe)");
  assert.equal(qaRecipientAllowed("ka@prueba.test"), true, "la cuenta real sí");
  for (const to of ["Ka@prueba.test", "KA@PRUEBA.TEST", "qа" + "1@prueba.test", "ｑａ1@prueba.test", "qa1@prueba.test́"]) {
    assert.equal(mailboxAddress(to), "", JSON.stringify(to));
    assert.equal(qaRecipientAllowed(to), false, JSON.stringify(to));
    assert.equal(reportRouting(to, "qa1@prueba.test").ok, false);
  }
});

test("B · un alias «+» en QA_EMAILS clasifica como QA solo a ese alias, no a la dirección base ni a otros alias", () => {
  assert.equal(isQa("juan+qa@empresa-cliente.gt"), true);
  assert.equal(isQa("  JUAN+QA@Empresa-Cliente.GT "), true);
  for (const real of ["juan@empresa-cliente.gt", "Juan@Empresa-Cliente.gt", "juan+pedidos@empresa-cliente.gt"]) {
    assert.equal(isQa(real), false, real);
    assert.equal(isTestRecord(real), false, real);
    assert.deepEqual(reportRouting("gerencia@empresa-cliente.gt", real), { test: false, ok: true }, real);
  }
  // 02-11i: an entry without «+» does NOT cover its «+» variants outside Gmail (each is its own account)
  assert.equal(isQa("QA1+x@prueba.test"), false);
  assert.equal(isQa("QA1@Prueba.Test"), true);
  // Gmail: the alias reaches the base inbox (Google's rule), so base and alias are the same account
  assert.equal(isQa("anaqa@googlemail.com"), true);
  assert.equal(qaRecipientAllowed("a.n.a.q.a+otro@gmail.com"), true);
});

test("Google Workspace u otro dominio propio: sin la regla de Gmail (puntos y «+» cuentan)", () => {
  assert.equal(qaRecipientAllowed("qa.workspace@seal-workspace.test"), true);
  for (const to of ["qaworkspace@seal-workspace.test", "qa.workspace+x@seal-workspace.test", "QA.Work.Space@seal-workspace.test"])
    assert.equal(qaRecipientAllowed(to), false, to);
});

// ── Parte 2 ─────────────────────────────────────────────────────────────────────────────────
const S = server(7500, QA_ENV);
before(() => S.start());
after(() => S.stop());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const addrs = (m) => [].concat(m.to || [], m.cc || [], m.bcc || []).map((x) => String(x).toLowerCase());
const search = (email, ip, q = "sillas plásticas apilables para eventos") => S.post("/api/suppliers/search", { productType: "machinery", userQuery: q, quantity: "4", userEmail: email }, ip);
// a repeat of one's own identical search is free (cache): the limit test uses different products
const PRODUCTS = ["mesas plegables de plástico", "carpas para eventos 3x3", "manteles de poliéster", "sillas tiffany de resina", "tarimas modulares de aluminio"];

test("servidor · el signo Kelvin no llega a Resend", async () => {
  const tok = (await (await search("qa1@prueba.test", "10.8.0.1")).json()).reportToken;
  await wait(250);
  const n = S.attempts().length;
  const r = await S.post("/api/email/report", { recipientEmail: "Ka@prueba.test", requesterEmail: "qa1@prueba.test", reportToken: tok, lang: "es" }, "10.8.0.2");
  // 02-11h: refused even earlier, as an unsupported address (400), never folded into «ka@»
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "email_not_supported");
  assert.equal(S.attempts().length, n);
});

test("servidor · cliente real cuya dirección es la base de un alias QA: consulta, búsqueda, caso e informe van por el flujo comercial", async () => {
  const n = S.attempts().length;
  assert.equal((await S.post("/api/email/lead", { name: "Juan", email: "juan@empresa-cliente.gt", query: "Sillas plásticas apilables para eventos" }, "10.8.1.1")).status, 200);
  const s = await search("juan@empresa-cliente.gt", "10.8.1.2");
  assert.equal(s.status, 200);
  const tok = (await s.json()).reportToken;
  await wait(300);
  const q = await (await S.post("/api/email/quote", { name: "Juan", email: "juan@empresa-cliente.gt", product: "Sillas plásticas" }, "10.8.1.3")).json();
  assert.equal(q.test, false, "el caso no se marca como prueba");
  const r = await S.post("/api/email/report", { recipientEmail: "gerencia@empresa-cliente.gt", requesterEmail: "juan@empresa-cliente.gt", reportToken: tok, lang: "es" }, "10.8.1.4");
  assert.deepEqual(await r.json(), { success: true, delivered: true, forwarded: false });
  const sent = S.attempts().slice(n);
  assert.equal(sent.length, 4, "consulta, búsqueda, caso, informe");
  for (const m of sent) {
    assert.doesNotMatch(m.subject, /PRUEBA/, m.subject);
    assert.ok(addrs(m).includes("ventas@example.test"), `a ventas: ${m.subject}`);
    assert.ok(!addrs(m).some((a) => /qa-inbox|qa-dev/.test(a)), `nada a QA: ${m.subject}`);
  }
});

test("servidor · la dirección base tiene el límite normal de búsquedas; el alias QA no", async () => {
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await search("juan@empresa-cliente.gt", `10.8.2.${i + 1}`, PRODUCTS[i])).status);
  // one search was already used in the previous test: 2 more pass, then the limit (3) applies
  assert.deepEqual(codes, [200, 200, 429, 429]);
  for (let i = 0; i < 5; i++) assert.equal((await search("juan+qa@empresa-cliente.gt", `10.8.3.${i + 1}`, PRODUCTS[i])).status, 200);
});

test("servidor · el alias QA expreso sí queda aislado (solo destinos QA)", async () => {
  const n = S.attempts().length;
  await S.post("/api/email/lead", { name: "Juan QA", email: "juan+qa@empresa-cliente.gt", query: "Sillas plásticas apilables para eventos" }, "10.8.4.1");
  const m = S.attempts().slice(n);
  assert.equal(m.length, 1);
  assert.match(m[0].subject, /^\[PRUEBA\]/);
  assert.deepEqual(m[0].to, ["qa-inbox@example.test", "qa-dev@example.test"]);
});

test("privacidad · ningún registro del servidor trae direcciones", () => {
  assert.doesNotMatch(S.logs, /[\w.+-]+@[\w-]+\.[\w.]+/);
});
