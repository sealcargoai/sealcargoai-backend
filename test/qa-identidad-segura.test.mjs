// 02-11h — Identidad de correo segura: clasificación QA, búsqueda, token de informe y destinatario.
// Defectos: (1) isEmail/normalizeEmail aceptaban Unicode y toLowerCase() plegaba «K» (signo Kelvin)
// a «k»: «Ka@prueba.test» se clasificaba como la cuenta QA «ka@prueba.test» (lead [PRUEBA] al buzón
// QA, no a ventas), compartía su búsqueda y su token de informe. (2) La búsqueda registrada y el token
// usaban la clave amplia de cuotas: el token de «qa1+x@» servía para «qa1@». (3) La deduplicación de casos
// usaba la misma clave amplia: el caso de un alias QA se fusionaba con el de la dirección base (cliente).
// Decisión: direcciones solo ASCII imprimible (sin SMTPUTF8/IDN ni invisibles) — se rechazan con
// «email_not_supported» antes de clasificar, registrar, buscar o enviar; nunca se convierten.
// Servidor real; Resend simulado; búsqueda ficticia. Nada sale.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "./fixtures/qa-server.mjs";
import { verifyEmail } from "./fixtures/verify.mjs";

const QA_ENV = {
  QA_EMAILS: "ka@prueba.test,qa1@prueba.test,ana.qa@gmail.com,qa.ws@seal-workspace.test,juan+qa@empresa-cliente.gt",
  QA_LEADS_EMAIL: "qa-inbox@example.test",
  LEADS_EMAIL: "ventas@example.test",
  LEADS_CC: "",
  QA_NOTIFY_EMAILS: "qa-dev@example.test",
};
Object.assign(process.env, { ADMIN_EMAIL: "", ADMIN2_EMAIL: "", ...QA_ENV });
const { normalizeEmail, emailKey, identityKey, isQa } = await import("../src/services/quotaStore.js");
const { isEmail } = await import("../src/middleware/security.js");

// look-alikes of «ka@prueba.test» (each a DIFFERENT mailbox, or not a valid ASCII address at all)
const LOOKALIKES = [
  ["Ka@prueba.test", "signo Kelvin (toLowerCase → k)"],
  ["KA@PRUEBA.TEST", "signo Kelvin en mayúsculas"],
  ["kа@prueba.test", "a cirílica"],
  ["ka@pruеba.test", "e cirílica en el dominio"],
  ["ｋａ@prueba.test", "ancho completo (NFKC → ka)"],
  ["k​a@prueba.test", "espacio de ancho cero"],
  ["k­a@prueba.test", "guion suave"],
  ["ka⁠@prueba.test", "unión de palabras invisible"],
  ["ka@pruebá.test", "dominio IDN con tilde"],
  ["ká@prueba.test", "acento combinado (NFD)"],
  ["İka@prueba.test", "I con punto (toLowerCase → i + combinante)"],
];

test("enumeración · el único carácter no ASCII que toLowerCase() convierte en ASCII puro (U+212A) y cualquier otro no ASCII se rechazan", () => {
  const folds = [];
  for (let c = 0x80; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    const ch = String.fromCodePoint(c);
    if (/^[\x21-\x7e]+$/.test(ch.toLowerCase())) folds.push(c);
  }
  assert.deepEqual(folds, [0x212a], "conjunto de plegados a ASCII de este motor");
  for (const c of folds) {
    const addr = `${String.fromCodePoint(c)}a@prueba.test`;
    assert.equal(normalizeEmail(addr), "");
    assert.equal(emailKey(addr), "");
    assert.equal(identityKey(addr), "");
    assert.equal(isEmail(addr), false);
    assert.equal(isQa(addr), false);
    assert.equal(identityKey(addr), "");
  }
});

test("tabla · las variantes parecidas no son la cuenta QA ni comparten su identidad ni su clave", () => {
  assert.equal(isQa("ka@prueba.test"), true);
  const tok = identityKey("ka@prueba.test");
  for (const [addr, why] of LOOKALIKES) {
    assert.equal(isEmail(addr), false, why);
    assert.equal(isQa(addr), false, why);
    assert.equal(emailKey(addr), "", `cuota: ${why}`);
    assert.notEqual(identityKey(addr), tok, why);
  }
});

test("tabla · la identidad (autorización) es el buzón exacto (no a la clave de cuotas); Gmail sí, Workspace no", () => {
  assert.equal(emailKey("qa1+x@prueba.test"), emailKey("qa1@prueba.test"), "(cuotas: amplia, intencional)");
  assert.notEqual(identityKey("qa1+x@prueba.test"), identityKey("qa1@prueba.test"));
  assert.notEqual(identityKey("k.a@prueba.test"), identityKey("ka@prueba.test"));
  assert.equal(identityKey(" KA@Prueba.Test "), identityKey("ka@prueba.test"), "mayúsculas y espacios: el mismo buzón");
  assert.equal(identityKey("a.n.a.q.a+z@googlemail.com"), identityKey("ana.qa@gmail.com"), "Gmail: regla de Google");
  assert.notEqual(identityKey("qaws@seal-workspace.test"), identityKey("qa.ws@seal-workspace.test"), "Workspace: los puntos cuentan");
  assert.notEqual(identityKey("qa.ws+x@seal-workspace.test"), identityKey("qa.ws@seal-workspace.test"), "Workspace: el «+» cuenta");
});

// ── servidor ────────────────────────────────────────────────────────────────────────────────
const S = server(7700, QA_ENV);
before(() => S.start());
after(() => S.stop());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const addrs = (m) => [].concat(m.to || [], m.cc || [], m.bcc || []).map((x) => String(x).toLowerCase());
const QA_DEST = new Set(["qa-inbox@example.test", "qa-dev@example.test"]);
let n = 0;
const ip = () => `10.9.${Math.floor(n / 200)}.${(n++ % 200) + 1}`;
const search = (email, q = "sillas plásticas apilables para eventos") => S.post("/api/suppliers/search", { productType: "machinery", userQuery: q, quantity: "4", userEmail: email }, ip());
// 02-11k: a report grant = proof of control of the address (code) — one use
const grant = async (email) => (await verifyEmail(S, email, ip())).reportGrant;
const report = (body) => S.post("/api/email/report", { totalCostText: "Q1,000.00", lang: "es", ...body }, ip());

test("servidor · una cuenta QA ASCII sigue enviando consulta, búsqueda y caso solo a destinos QA", async () => {
  const k = S.attempts().length;
  assert.equal((await S.post("/api/email/lead", { name: "QA", email: "ka@prueba.test", query: "Sillas plásticas apilables para eventos" }, ip())).status, 200);
  assert.equal((await search("ka@prueba.test")).status, 200);
  await wait(250);
  const q = await (await S.post("/api/email/quote", { name: "QA", email: "ka@prueba.test", product: "Sillas plásticas" }, ip())).json();
  assert.equal(q.test, true);
  const sent = S.attempts().slice(k);
  assert.equal(sent.length, 3);
  for (const m of sent) {
    assert.match(m.subject, /^\[PRUEBA\]/);
    for (const a of addrs(m)) assert.ok(QA_DEST.has(a), a);
  }
});

test("servidor · variantes Unicode/homógrafas/invisibles: consulta, caso y búsqueda → 400 email_not_supported y CERO correos", async () => {
  const k = S.attempts().length;
  for (const [addr, why] of LOOKALIKES) {
    for (const [path, body] of [
      ["/api/email/lead", { name: "X", email: addr, query: "Sillas plásticas apilables para eventos" }],
      ["/api/email/quote", { name: "X", email: addr, product: "Sillas plásticas" }],
      ["/api/suppliers/search", { productType: "machinery", userQuery: "sillas plásticas apilables para eventos", quantity: "4", userEmail: addr }],
    ]) {
      const r = await S.post(path, body, ip());
      const j = await r.json();
      assert.equal(r.status, 400, `${path} ${why}`);
      assert.equal(j.error, "email_not_supported", `${path} ${why}`);
      assert.doesNotMatch(JSON.stringify(j), /@/);
    }
  }
  await wait(300);
  assert.equal(S.attempts().length, k, "ni a QA ni a ventas");
});

test("servidor · cliente real con correo Unicode: error claro antes de cualquier correo (no se desvía a QA); el mismo cliente en ASCII va a ventas", async () => {
  const k = S.attempts().length;
  const r = await S.post("/api/email/quote", { name: "José", email: "josé@empresa.gt", product: "Sillas plásticas" }, ip());
  assert.equal(r.status, 400);
  assert.equal((await r.json()).error, "email_not_supported");
  assert.equal(S.attempts().length, k);
  const ok = await (await S.post("/api/email/quote", { name: "José", email: "jose@empresa.gt", product: "Sillas plásticas" }, ip())).json();
  assert.equal(ok.test, false);
  const m = S.attempts().slice(k);
  assert.equal(m.length, 1);
  assert.deepEqual(m[0].to, ["ventas@example.test"]);
  assert.doesNotMatch(m[0].subject, /PRUEBA/);
});

test("servidor · la autorización de ka@ no sirve con variantes parecidas, alias, puntos ni para otra cuenta; tampoco repetida", async () => {
  const g = await grant("ka@prueba.test");
  const k = S.attempts().length;
  for (const [requester, status] of [
    ["\u212Aa@prueba.test", 400],
    ["k\u0430@prueba.test", 400],
    ["k\u200Ba@prueba.test", 400],
    ["ka+x@prueba.test", 403],
    ["k.a@prueba.test", 403],
    ["qa1@prueba.test", 403],
  ]) {
    const r = await report({ requesterEmail: requester, reportGrant: g });
    assert.equal(r.status, status, JSON.stringify(requester));
  }
  assert.equal(S.attempts().length, k, "Resend no fue llamado");
  // the same mailbox in other case is the same identity; the grant works ONCE
  assert.equal((await report({ requesterEmail: "KA@Prueba.Test", reportGrant: g })).status, 200);
  const again = await report({ requesterEmail: "ka@prueba.test", reportGrant: g });
  assert.equal(again.status, 403, "repetición rechazada");
  assert.equal((await again.json()).error, "report_not_allowed");
});

test("servidor · una cuenta QA no saca informes afuera con mayúsculas, alias, autorización ajena ni PDF; se rechaza antes de límites, PDF y Resend", async () => {
  const own = await grant("qa1@prueba.test");
  const alias = await grant("qa1+x@prueba.test");
  const kaG = await grant("ka@prueba.test");
  const k = S.attempts().length;
  const bad = Buffer.from("esto no es un PDF").toString("base64");
  for (const [requester, g, want] of [
    ["qa1@prueba.test", own, "recipient_must_be_requester"],
    ["QA1@PRUEBA.TEST", own, "recipient_must_be_requester"],
    ["qa1@prueba.test", kaG, "recipient_must_be_requester"],
    ["qa1@prueba.test", alias, "recipient_must_be_requester"],
  ]) {
    for (const to of ["cliente@empresa.gt", "ventas@example.test", "VENTAS+x@example.test", "qa1+otra@prueba.test"]) {
      const r = await report({ recipientEmail: to, requesterEmail: requester, reportGrant: g, pdfBase64: bad });
      assert.equal(r.status, 403, `${requester} → ${to}`);
      assert.equal((await r.json()).error, want, `${requester} → ${to} (el PDF inválido no llegó a revisarse)`);
    }
  }
  for (const g of [kaG, alias]) assert.equal((await report({ requesterEmail: "qa1@prueba.test", reportGrant: g })).status, 403, "autorización de otra identidad");
  for (const to of ["no-es-correo", "a@b", "\u212Aa@prueba.test"])
    assert.ok([400, 403].includes((await report({ recipientEmail: to, requesterEmail: "qa1@prueba.test", reportGrant: own })).status), to);
  assert.equal(S.attempts().length, k, "Resend no fue llamado");
  // limits untouched: 3 reports to the QA account still pass (a grant each), the 4th hits the cap
  assert.equal((await report({ requesterEmail: "qa1@prueba.test", reportGrant: own })).status, 200);
  for (let i = 0; i < 2; i++) assert.equal((await report({ requesterEmail: "qa1@prueba.test", reportGrant: await grant("qa1@prueba.test") })).status, 200);
  assert.equal((await report({ requesterEmail: "qa1@prueba.test", reportGrant: await grant("qa1@prueba.test") })).status, 429);
});

test("servidor · el caso de un alias QA no se fusiona con el de la dirección base (cliente real) ni lo reclasifica", async () => {
  const body = { name: "Juan", product: "Tarimas modulares de aluminio" };
  const a = await (await S.post("/api/email/quote", { ...body, email: "juan@empresa-cliente.gt" }, ip())).json();
  assert.deepEqual([a.duplicate, a.test], [false, false]);
  const b = await (await S.post("/api/email/quote", { ...body, email: "juan+qa@empresa-cliente.gt" }, ip())).json();
  assert.deepEqual([b.duplicate, b.test], [false, true], "caso QA aparte");
  assert.notEqual(b.id, a.id);
  // the owner of the real case updates it with its case token: still real, same case
  const caseAuth = [`${a.id}:${new URL(a.caseUrl).searchParams.get("t")}`];
  const c = await (await S.post("/api/email/quote", { ...body, email: "juan@empresa-cliente.gt", caseAuth }, ip())).json();
  assert.deepEqual([c.duplicate, c.test, c.id], [true, false, a.id], "el caso real sigue real");
});

test("servidor · un cliente real ASCII: consulta, búsqueda, caso e informe por el flujo comercial (sin cambios)", async () => {
  const k = S.attempts().length;
  await S.post("/api/email/lead", { name: "Lucía", email: "lucia@importadora.gt", query: "Sillas plásticas apilables para eventos" }, ip());
  assert.equal((await search("lucia@importadora.gt", "sillas tiffany de resina")).status, 200);
  await wait(250);
  await S.post("/api/email/quote", { name: "Lucía", email: "lucia@importadora.gt", product: "Sillas tiffany" }, ip());
  const g = await grant("Lucia@Importadora.gt");
  const r = await report({ requesterEmail: "lucia@importadora.gt", reportGrant: g });
  assert.deepEqual(await r.json(), { success: true, delivered: true, forwarded: false });
  const sent = S.attempts().slice(k).filter((m) => !/código de verificación/i.test(m.subject));
  assert.equal(sent.length, 4);
  for (const m of sent) {
    assert.doesNotMatch(m.subject, /PRUEBA/);
    assert.ok(addrs(m).includes("ventas@example.test"), m.subject);
    assert.ok(!addrs(m).some((x) => QA_DEST.has(x)), m.subject);
  }
});

test("privacidad · ningún registro del servidor trae direcciones", () => {
  assert.doesNotMatch(S.logs, /[\w.+-]+@[\w-]+\.[\w.]+/);
});
