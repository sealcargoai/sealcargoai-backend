// 02-11k — Control del correo antes de autorizar; casos que solo cambia su titular; QA y métricas.
// Defectos reproducidos antes (datos ficticios, Resend simulado):
//  1) una búsqueda pública con CUALQUIER correo devolvía el token del informe (HMAC del correo) y con él se
//     enviaba un PDF hecho en el navegador a una dirección externa, con SEAL como remitente (200);
//  2) repetir /api/email/quote con el mismo correo, producto y proveedor cambiaba cantidad, presupuesto y
//     mensaje del caso sin ninguna prueba;
//  3) escribir una dirección QA bastaba para buscar sin límite;
//  4) /api/events contaba conversiones («solicitud_enviada») enviadas por cualquiera, sin tope por IP.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "./fixtures/qa-server.mjs";
import { verifyEmail } from "./fixtures/verify.mjs";

const ENV = { QA_EMAILS: "qa1@prueba.test", QA_LEADS_EMAIL: "qa-inbox@example.test", LEADS_EMAIL: "ventas@example.test", ADMIN_TOKEN: "admin-token-ficticio-0123456789" };
const S = server(8700, ENV);
// default (production) verification caps: 3 codes per address and hour
const STRICT = server(8900, { ...ENV, VERIFY_MAX_PER_ADDRESS_HOUR: "", VERIFY_MAX_PER_IP_HOUR: "" });
before(async () => {
  await S.start();
  await STRICT.start();
});
after(async () => {
  await S.stop();
  await STRICT.stop();
});
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ip = () => `10.13.${Math.floor(n / 200)}.${(n++ % 200) + 1}`;
const search = (email, q = "sillas plásticas apilables para eventos", extra = {}) => S.post("/api/suppliers/search", { productType: "machinery", userQuery: q, quantity: "4", userEmail: email, ...extra }, ip());
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");
const report = (body) => S.post("/api/email/report", { totalCostText: "Q1,000.00", lang: "es", pdfBase64: PDF, ...body }, ip());
const codeOf = (srv, email) => {
  const m = [...srv.mails()].reverse().find((x) => [].concat(x.to).includes(email) && /código/i.test(x.subject));
  return m && m.html.match(/letter-spacing:6px">(\d{6})</)[1];
};

test("1 · una búsqueda con el correo de otra persona no da ninguna autorización de informe", async () => {
  const r = await search("victima@cliente-ficticio.test");
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.reportToken, undefined, "la búsqueda ya no entrega token");
  assert.doesNotMatch(JSON.stringify(j), /grant|session/i);
  await wait(250);
  const k = S.attempts().length;
  for (const body of [
    { requesterEmail: "victima@cliente-ficticio.test" },
    { requesterEmail: "victima@cliente-ficticio.test", reportToken: "cualquier-cosa-de-32-caracteres!!" },
    { requesterEmail: "victima@cliente-ficticio.test", reportGrant: "x".repeat(43) },
    { recipientEmail: "tercero@externo.test", requesterEmail: "victima@cliente-ficticio.test", reportGrant: "x".repeat(43) },
  ]) {
    const res = await report(body);
    assert.equal(res.status, 403, JSON.stringify(body));
    assert.doesNotMatch(await res.text(), /@/);
  }
  assert.equal(S.attempts().length, k, "nada salió");
});

test("2 · autorización: alterada, de otra identidad, repetida o vencida → rechazada", async () => {
  const v = await verifyEmail(S, "lucia@importadora-ficticia.test", ip());
  const other = await verifyEmail(S, "pedro@importadora-ficticia.test", ip());
  const altered = v.reportGrant.slice(0, -1) + (v.reportGrant.endsWith("A") ? "B" : "A");
  const k = S.attempts().length;
  assert.equal((await report({ requesterEmail: "lucia@importadora-ficticia.test", reportGrant: altered })).status, 403, "alterada");
  assert.equal((await report({ requesterEmail: "lucia@importadora-ficticia.test", reportGrant: other.reportGrant })).status, 403, "de otra identidad");
  assert.equal((await report({ requesterEmail: "lucia@importadora-ficticia.test", reportGrant: v.session })).status, 403, "la sesión no es una autorización de informe");
  assert.equal(S.attempts().length, k);
  assert.equal((await report({ requesterEmail: "lucia@importadora-ficticia.test", reportGrant: v.reportGrant })).status, 200, "la buena, una vez");
  assert.equal((await report({ requesterEmail: "lucia@importadora-ficticia.test", reportGrant: v.reportGrant })).status, 403, "repetida");
  // expiry and code rules, on the module itself (time is injected)
  const vs = await import("../src/services/verifyStore.js");
  const t0 = Date.now();
  const st = vs.startVerification("vence@ficticio.test", "10.0.0.1", t0);
  assert.equal(vs.confirmVerification("vence@ficticio.test", st.code, t0 + 16 * 60 * 1000), null, "código vencido (15 min)");
  const st2 = vs.startVerification("vence2@ficticio.test", "10.0.0.1", t0);
  const ok = vs.confirmVerification("vence2@ficticio.test", st2.code, t0);
  assert.ok(ok);
  assert.equal(vs.confirmVerification("vence2@ficticio.test", st2.code, t0), null, "un código sirve una vez");
  assert.equal(vs.grantValid(ok.reportGrant, "vence2@ficticio.test", t0 + 31 * 60 * 1000), false, "autorización vencida (30 min)");
  assert.equal(vs.sessionIdentity(ok.session, t0 + 13 * 60 * 60 * 1000), "", "sesión vencida (12 h)");
  assert.notEqual(ok.reportGrant, ok.session);
  assert.ok(ok.reportGrant.length >= 40, "token aleatorio de 256 bits");
});

test("3 · código: 5 intentos fallidos lo anulan; correo de ventas no recibe códigos; límite por dirección (3/hora por defecto)", async () => {
  await S.post("/api/email/verify/start", { email: "intentos@ficticio.test" }, ip());
  const good = codeOf(S, "intentos@ficticio.test");
  const wrong = good === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await S.post("/api/email/verify/confirm", { email: "intentos@ficticio.test", code: wrong }, ip())).status, 403);
  assert.equal((await S.post("/api/email/verify/confirm", { email: "intentos@ficticio.test", code: good }, ip())).status, 403, "anulado tras 5 intentos");
  const k = S.mails().length;
  const sales = await S.post("/api/email/verify/start", { email: "VENTAS+x@example.test" }, ip());
  assert.deepEqual(await sales.json(), { sent: true }, "misma respuesta (no revela nada)");
  assert.equal(S.mails().length, k, "pero a ventas no se envía");
  const codes = [];
  for (let i = 0; i < 4; i++) codes.push((await STRICT.post("/api/email/verify/start", { email: "spam@victima-ficticia.test" }, `10.14.0.${i + 1}`)).status);
  assert.deepEqual(codes, [200, 200, 200, 429]);
});

test("4 · el informe solo va al buzón verificado; un PDF o datos del navegador no se presentan como documento de SEAL", async () => {
  const v = await verifyEmail(S, "rosa@cliente-ficticio.test", ip());
  const k = S.attempts().length;
  const bad = Buffer.from("no es un PDF").toString("base64");
  const r = await report({ recipientEmail: "tercero@externo.test", requesterEmail: "rosa@cliente-ficticio.test", reportGrant: v.reportGrant, pdfBase64: bad });
  assert.equal(r.status, 403, "rechazado antes de leer el PDF");
  assert.equal((await r.json()).error, "recipient_must_be_requester");
  assert.equal(S.attempts().length, k);
  const ok = await report({ requesterEmail: "rosa@cliente-ficticio.test", reportGrant: v.reportGrant, supplierName: "Pago pendiente SAT - abra el adjunto", totalCostText: "Q1 OFICIAL APROBADO" });
  assert.equal(ok.status, 200);
  const m = S.attempts().slice(k)[0];
  assert.equal(m.to, "rosa@cliente-ficticio.test");
  assert.equal(m.subject, "Su estimación preliminar (SmartTrade AI)");
  assert.match(m.attachments[0].filename, /^SmartTrade_estimacion_preliminar_\d+\.pdf$/);
  assert.match(m.html, /se generó en su navegador con los datos que usted ingresó; SEAL no lo revisó ni lo valida/);
  assert.match(m.html, /no es una cotización, ni una verificación del proveedor, ni una clasificación arancelaria confirmada/);
  assert.match(m.html, /según los datos ingresados en la herramienta/);
  assert.doesNotMatch(m.html, /OFICIAL|APROBADO/, "solo cifras en el monto");
});

test("5 · caso repetido sin token: nada cambia, ningún correo ni enlace; con el token del titular sí se actualiza", async () => {
  const base = { name: "Eva", email: "eva@cliente-ficticio.test", product: "válvulas de bola de bronce", supplierName: "Valvulas SA", quantity: "10", budget: "1000", message: "original" };
  const first = await (await S.post("/api/email/quote", base, ip())).json();
  const k = S.attempts().length;
  const forged = await (await S.post("/api/email/quote", { ...base, quantity: "999", budget: "5", message: "alterado", caseAuth: [`${first.id}:falso`] }, ip())).json();
  assert.deepEqual(forged, { success: true, duplicate: true, unchanged: true });
  assert.equal(S.attempts().length, k);
  let j = JSON.stringify(await (await fetch(first.caseUrl + "&format=json")).json());
  assert.ok(!/alterado|999/.test(j));
  const caseAuth = [`${first.id}:${new URL(first.caseUrl).searchParams.get("t")}`];
  const up = await (await S.post("/api/email/quote", { ...base, quantity: "20", message: "nueva cantidad", caseAuth }, ip())).json();
  assert.deepEqual([up.duplicate, up.updated, up.id], [true, true, first.id]);
  assert.equal(S.attempts().length, k + 1, "una actualización a SEAL");
  j = JSON.stringify(await (await fetch(first.caseUrl + "&format=json")).json());
  assert.ok(/nueva cantidad/.test(j));
});

test("6 · QA: escribir la dirección QA no quita el límite; la sesión verificada de ESA dirección sí; sus correos van a QA", async () => {
  const P = ["mesas plegables", "carpas para eventos 3x3", "manteles de poliéster", "sillas tiffany de resina"];
  const codes = [];
  for (const p of P) codes.push((await search("qa1@prueba.test", p)).status);
  assert.deepEqual(codes, [200, 200, 200, 429], "sin verificar: límite normal");
  const other = await verifyEmail(S, "otro@ficticio.test", ip());
  assert.equal((await search("qa1@prueba.test", "platos de cartón", { verifiedSession: other.session })).status, 429, "sesión de otra identidad");
  const v = await verifyEmail(S, "qa1@prueba.test", ip());
  for (const p of ["platos de cartón", "vasos de vidrio", "cubiertos de madera"]) assert.equal((await search("qa1@prueba.test", p, { verifiedSession: v.session })).status, 200);
  // a QA address (verified or not) never reaches sales
  const k = S.attempts().length;
  await S.post("/api/email/lead", { name: "QA", email: "qa1@prueba.test", query: "Sillas plásticas apilables para eventos" }, ip());
  assert.deepEqual(S.attempts().slice(k)[0].to, ["qa-inbox@example.test", "qa-dev@example.test"]);
});

test("7 · eventos: una conversión enviada por el navegador no cuenta; la cuenta el servidor al registrar un caso; tope por IP", async () => {
  const funnel = async () => (await (await fetch(S.BASE + "/api/leads/funnel?format=json", { headers: { "x-admin-token": ENV.ADMIN_TOKEN } })).json()).events;
  const e0 = await funnel();
  for (let i = 0; i < 30; i++) await S.post("/api/events", { event: "solicitud_enviada", vid: `falso-vid-${i}-xx` }, "10.15.0.1");
  assert.equal((await funnel()).solicitud_enviada, e0.solicitud_enviada, "conversiones del navegador ignoradas");
  for (let i = 0; i < 80; i++) await S.post("/api/events", { event: "visita", vid: `vid-ficticio-${i}-x` }, "10.15.0.2");
  assert.equal((await funnel()).visita - e0.visita, 40, "a lo sumo 40 por IP y día");
  await S.post("/api/email/quote", { name: "Nuevo", email: "nuevo@cliente-ficticio.test", product: "cajas de cartón corrugado" }, ip());
  assert.equal((await funnel()).solicitud_enviada, e0.solicitud_enviada + 1, "el servidor cuenta el caso nuevo");
  await S.post("/api/email/quote", { name: "QA", email: "qa1@prueba.test", product: "cajas QA" }, ip());
  assert.equal((await funnel()).solicitud_enviada, e0.solicitud_enviada + 1, "un caso QA no cuenta");
});

test("8 · cliente real: búsqueda, caso e informe propio por el flujo comercial", async () => {
  const k = S.attempts().length;
  assert.equal((await search("mario@importadora-ficticia.test", "bombas de agua sumergibles")).status, 200);
  await wait(250);
  await S.post("/api/email/quote", { name: "Mario", email: "mario@importadora-ficticia.test", product: "bombas de agua" }, ip());
  const v = await verifyEmail(S, "mario@importadora-ficticia.test", ip());
  assert.equal((await report({ requesterEmail: "mario@importadora-ficticia.test", reportGrant: v.reportGrant })).status, 200);
  const sent = S.attempts().slice(k).filter((m) => !/código/i.test(m.subject));
  assert.equal(sent.length, 3);
  for (const m of sent) assert.ok([].concat(m.to, m.bcc || []).includes("ventas@example.test"), m.subject);
});

test("privacidad · registros sin direcciones ni códigos", () => {
  for (const s of [S, STRICT]) assert.doesNotMatch(s.logs, /[\w.+-]+@[\w-]+\.[\w.]+/);
});

// ── Revisión independiente ───────────────────────────────────────────────────────────────────
test("10 · un tercero que pide códigos no anula el del titular; fallos limitados por día; envío fallido no consume el tope", async () => {
  const vs = await import("../src/services/verifyStore.js");
  const t0 = Date.parse("2026-11-03T10:00:00Z");
  const mine = vs.startVerification("dueno@cliente-ficticio.test", "10.20.0.1", t0);
  vs.startVerification("dueno@cliente-ficticio.test", "10.20.0.2", t0 + 1000); // someone else asks for one
  assert.ok(vs.confirmVerification("dueno@cliente-ficticio.test", mine.code, t0 + 2000), "el código del titular sigue sirviendo");
  // 10 wrong codes in a day lock the address (brute force across codes and IPs), even with a right code after
  let t = t0 + 3 * 3600 * 1000;
  for (let i = 0; i < 4; i++) {
    const c = vs.startVerification("objetivo@cliente-ficticio.test", `10.21.0.${i}`, t + i * 3600 * 1000);
    assert.equal(c.ok, true);
  }
  t += 4 * 3600 * 1000;
  const good = vs.startVerification("objetivo@cliente-ficticio.test", "10.21.1.1", t);
  let fails = 0;
  for (let i = 0; i < 12; i++) {
    const wrong = String((Number(good.code) + 1 + i) % 1_000_000).padStart(6, "0");
    if (!vs.confirmVerification("objetivo@cliente-ficticio.test", wrong, t + i)) fails++;
    if (i % 4 === 3) vs.startVerification("objetivo@cliente-ficticio.test", `10.21.2.${i}`, t + i);
  }
  assert.equal(fails, 12);
  const late = vs.startVerification("objetivo@cliente-ficticio.test", "10.21.3.1", t + 2 * 3600 * 1000);
  assert.equal(late.ok, true);
  assert.equal(vs.confirmVerification("objetivo@cliente-ficticio.test", late.code, t + 2 * 3600 * 1000 + 1), null, "bloqueado por el día aun con el código correcto");
  assert.ok(vs.confirmVerification("objetivo@cliente-ficticio.test", vs.startVerification("objetivo@cliente-ficticio.test", "10.21.4.1", t + 25 * 3600 * 1000).code, t + 25 * 3600 * 1000 + 1), "al día siguiente sí");
  // a code that could not be emailed does not count against the per-address cap (3/hour by default)
  const t2 = t0 + 100 * 3600 * 1000;
  for (let i = 0; i < 5; i++) {
    const c = vs.startVerification("rebota@cliente-ficticio.test", "10.22.0.1", t2 + i);
    assert.equal(c.ok, true, `intento ${i}`);
    vs.cancelVerification("rebota@cliente-ficticio.test", "10.22.0.1", c.code);
  }
});

test("11 · /quota cuenta la sesión QA (encabezado) y la respuesta a un repetido sin token es idéntica haya o no reintento", async () => {
  const qa = "qa1@prueba.test";
  for (const q of ["mesas plegables de plástico", "carpas para eventos 3x3", "manteles de poliéster", "sillas tiffany de resina"]) await search(qa, q);
  const quota = (h = {}) => fetch(`${S.BASE}/api/suppliers/quota?email=${encodeURIComponent(qa)}`, { headers: { "x-real-ip": "10.23.0.1", ...h } }).then((r) => r.json());
  assert.equal((await quota()).remaining, 0, "sin sesión: límite normal");
  const v = await verifyEmail(S, qa, "10.23.0.2");
  const other = await verifyEmail(S, "otro@cliente-ficticio.test", "10.23.0.3");
  assert.equal((await quota({ "x-verified-session": other.session })).remaining, 0, "sesión de otra identidad: no");
  assert.ok((await quota({ "x-verified-session": v.session })).remaining > 0, "su propia sesión: sí");
  const body = { name: "Mario", email: "mario@cliente-ficticio.test", product: "cajas de cartón corrugado" };
  await S.post("/api/email/quote", body, "10.23.1.1");
  const again = await (await S.post("/api/email/quote", { ...body, name: "Otro" }, "10.23.1.2")).json();
  assert.deepEqual(again, { success: true, duplicate: true, unchanged: true });
});
