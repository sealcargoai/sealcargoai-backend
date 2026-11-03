// 02-11j — Auditoría integral (backend). Servidor real; Resend simulado; búsqueda ficticia; datos ficticios.
// Defectos: (1) quien supiera correo + producto de un cliente recibía el enlace firmado de SU caso y
// reemplazaba su teléfono/empresa; (2) un Host «*.up.railway.app» cualquiera ponía otro sitio en los
// enlaces de los correos de SEAL; (3) la página del caso decía «Costo total estimado» para una estimación
// sin flete; (4) el correo del caso mostraba «Destino GT»; (5) una hoja de tarifas con tipo de cambio 0 o
// «7,80» rompía todas las estimaciones; (6) el nombre libre del solicitante iba en el saludo de informes a
// terceros; (7) texto del cliente en los registros; (8) token de administración comparado con «===».
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "./fixtures/qa-server.mjs";
import { verifyEmail } from "./fixtures/verify.mjs";

const S = server(8500, { QA_EMAILS: "qa1@prueba.test", QA_LEADS_EMAIL: "qa-inbox@example.test", ADMIN_TOKEN: "admin-token-ficticio-0123456789" });
before(() => S.start());
after(() => S.stop());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ip = () => `10.12.${Math.floor(n / 200)}.${(n++ % 200) + 1}`;
const quote = (body, headers = {}) => fetch(S.BASE + "/api/email/quote", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip(), ...headers }, body: JSON.stringify(body) });

const VICTIM = { name: "Ana Cliente", email: "ana@cliente-ficticio.test", phone: "+502 5555 1111", company: "Importadora Ficticia", product: "bomba de agua sumergible 2HP", supplierName: "Acme Pumps", message: "Mensaje confidencial ficticio", budget: "5000", destination: "GT", totalCostText: "Q64,140.15 (US$8,119.01), sin flete" };

test("1 · un repetido (mismo correo, producto y proveedor) sin el token del caso no cambia nada, no entrega número ni enlace ni avisa a SEAL", async () => {
  const v = await (await quote(VICTIM)).json();
  assert.equal(v.duplicate, false);
  assert.match(v.caseUrl, /\/api\/leads\/case\//);
  const k = S.attempts().length;
  const a = await (await quote({ name: "Otra Persona", email: "ANA@cliente-ficticio.test", phone: "+502 9999 0000", company: "Otra Empresa", product: "Bomba de agua sumergible 2HP!", supplierName: "acme  pumps", quantity: "999", budget: "1", message: "cambiado" })).json();
  assert.deepEqual(a, { success: true, duplicate: true, unchanged: true });
  assert.equal(S.attempts().length, k, "ningún correo de actualización");
  const j = JSON.stringify(await (await fetch(v.caseUrl + "&format=json")).json());
  for (const x of ["9999 0000", "Otra Empresa", "999", "cambiado"]) assert.ok(!j.includes(x), x);
  // with a forged or another case's token, the same
  for (const caseAuth of [[`${v.id}:token-falso`], [`OTRO-ID:${new URL(v.caseUrl).searchParams.get("t")}`]]) {
    const r = await (await quote({ ...VICTIM, caseAuth, quantity: "777" })).json();
    assert.equal(r.unchanged, true);
  }
  assert.equal(S.attempts().length, k);
});

test("1b · el titular, con el token de su caso, sí lo actualiza sin duplicarlo (SEAL recibe la actualización)", async () => {
  const first = await (await quote({ name: "Rosa", email: "rosa@cliente-ficticio.test", product: "tubos de PVC de 4 pulgadas", supplierName: "Tubos SA" })).json();
  const caseAuth = [`${first.id}:${new URL(first.caseUrl).searchParams.get("t")}`];
  const k = S.attempts().length;
  const up = await (await quote({ name: "Rosa", email: "rosa@cliente-ficticio.test", phone: "+502 8888 0000", product: "tubos de PVC de 4 pulgadas", supplierName: "Tubos SA", quantity: "40", caseAuth })).json();
  assert.deepEqual([up.duplicate, up.updated, up.id], [true, true, first.id]);
  assert.equal(up.caseUrl, undefined);
  const m = S.attempts().slice(k);
  assert.equal(m.length, 1);
  assert.match(m[0].subject, /Actualización · Caso/);
  assert.match(m[0].html, /8888 0000/);
  const j = JSON.stringify(await (await fetch(first.caseUrl + "&format=json")).json());
  assert.ok(j.includes("40"));
});

test("2 · un Host «*.up.railway.app» ajeno no cambia el dominio de los enlaces", async () => {
  // (fetch does not let a client set Host: the function that builds the links is checked directly)
  delete process.env.PUBLIC_API_URL;
  const { baseUrl } = await import("../src/routes/leads.js");
  const req = (host) => ({ get: () => host, protocol: "https" });
  assert.equal(baseUrl(req("attacker-app.up.railway.app")), "https://sealcargoai-backend-production.up.railway.app");
  assert.equal(baseUrl(req("sealcargoai-backend-production.up.railway.app")), "https://sealcargoai-backend-production.up.railway.app");
  assert.equal(baseUrl(req("evil.example")), "https://sealcargoai-backend-production.up.railway.app");
  process.env.RAILWAY_PUBLIC_DOMAIN = "seal-staging.up.railway.app";
  assert.equal(baseUrl(req("seal-staging.up.railway.app")), "https://seal-staging.up.railway.app");
  assert.equal(baseUrl(req("attacker-app.up.railway.app")), "https://sealcargoai-backend-production.up.railway.app");
  delete process.env.RAILWAY_PUBLIC_DOMAIN;
});

test("3-4 · página del caso: «Costo estimado preliminar (sin flete)»; correo del caso: «Destino Guatemala»", async () => {
  const k = S.attempts().length;
  const r = await (await quote({ ...VICTIM, email: "eva@cliente-ficticio.test", product: "mangueras industriales" })).json();
  const html = await (await fetch(r.caseUrl)).text();
  assert.match(html, /Costo estimado preliminar \(sin flete\)/);
  assert.doesNotMatch(html, /Costo total estimado/);
  const m = S.attempts().slice(k)[0];
  assert.match(m.html, />Destino<\/td><td[^>]*>(?:<b>)?Guatemala/);
  assert.doesNotMatch(m.html, />GT</);
});

test("5 · tarifas: tipo de cambio 0, fuera de rango o con coma decimal, y contenedor de 0 m³, quedan en el valor por defecto", async () => {
  const { parseValue } = await import("../src/routes/rates.js");
  assert.equal(parseValue("exchangeRate", "7.80"), 7.8);
  for (const bad of ["0", "7,80", "780", "-7.8", "abc"]) assert.equal(parseValue("exchangeRate", bad), undefined, bad);
  assert.equal(parseValue("container40Cbm", "0"), undefined);
  assert.equal(parseValue("container40Cbm", "67"), 67);
  assert.equal(parseValue("dutyRate", "15%"), 0.15);
});

test("6 · informe: solo al propio buzón verificado; a un tercero se rechaza; el correo dice que el PDF no lo validó SEAL", async () => {
  const v = await verifyEmail(S, "pedro@cliente-ficticio.test", ip());
  const k = S.attempts().length;
  const r = await S.post("/api/email/report", { recipientEmail: "gerencia@otra-ficticia.test", requesterEmail: "pedro@cliente-ficticio.test", reportGrant: v.reportGrant, recipientName: "Juan: su factura está vencida", supplierName: "Pago pendiente SAT", lang: "es" }, ip());
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error, "recipient_must_be_requester");
  assert.equal(S.attempts().length, k);
  const ok = await S.post("/api/email/report", { requesterEmail: "pedro@cliente-ficticio.test", reportGrant: v.reportGrant, recipientName: "Juan: su factura está vencida", supplierName: "Pago pendiente SAT", lang: "es" }, ip());
  assert.equal(ok.status, 200);
  const m = S.attempts().slice(k)[0];
  assert.equal(m.to, "pedro@cliente-ficticio.test");
  assert.doesNotMatch(m.html, /factura está vencida/);
  assert.doesNotMatch(m.subject, /Pago pendiente/);
  assert.match(m.html, /SEAL no lo revisó ni lo valida/);
  assert.match(m.html, /no es una cotización/);
  assert.match(m.attachments?.[0]?.filename || "estimacion_preliminar", /estimacion_preliminar|^estimacion/);
});

test("7 · los registros no traen el texto del cliente ni saltos de línea inyectados", async () => {
  await S.post("/api/suppliers/search", { productType: "maquinaria\nFALSO REGISTRO inyectado", material: "acero\nOTRA LINEA", userQuery: "sillas plásticas apilables para eventos", quantity: "4", destination: "Guatemala\nX" }, ip());
  await wait(200);
  assert.doesNotMatch(S.logs, /FALSO REGISTRO|OTRA LINEA/);
});

test("8 · token de administración: solo el exacto abre el embudo", async () => {
  const get = (t) => fetch(S.BASE + "/api/leads/funnel", { headers: t ? { "x-admin-token": t } : {} }).then((r) => r.status);
  assert.equal(await get("admin-token-ficticio-0123456789"), 200);
  for (const bad of ["", "admin-token-ficticio-012345678", "admin-token-ficticio-01234567890", "x"]) assert.equal(await get(bad), 404, JSON.stringify(bad));
  // a non-ASCII token of the same length in characters used to throw (500) and reveal the length
  const same = "admin-token-ficticio-012345678é";
  assert.equal(same.length, "admin-token-ficticio-0123456789".length);
  assert.equal(await get(same), 404);
});
