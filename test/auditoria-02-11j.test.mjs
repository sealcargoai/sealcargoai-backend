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

const S = server(8500, { QA_EMAILS: "qa1@prueba.test", QA_LEADS_EMAIL: "qa-inbox@example.test", ADMIN_TOKEN: "admin-token-ficticio-0123456789" });
before(() => S.start());
after(() => S.stop());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let n = 0;
const ip = () => `10.12.${Math.floor(n / 200)}.${(n++ % 200) + 1}`;
const quote = (body, headers = {}) => fetch(S.BASE + "/api/email/quote", { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip(), ...headers }, body: JSON.stringify(body) });

const VICTIM = { name: "Ana Cliente", email: "ana@cliente-ficticio.test", phone: "+502 5555 1111", company: "Importadora Ficticia", product: "bomba de agua sumergible 2HP", supplierName: "Acme Pumps", message: "Mensaje confidencial ficticio", budget: "5000", destination: "GT", totalCostText: "Q64,140.15 (US$8,119.01), sin flete" };

test("1 · un repetido (mismo correo, producto y proveedor) no entrega el enlace del caso ni reemplaza el contacto", async () => {
  const v = await (await quote(VICTIM)).json();
  assert.equal(v.duplicate, false);
  assert.match(v.caseUrl, /\/api\/leads\/case\//);
  const k = S.attempts().length;
  const a = await (await quote({ name: "Otra Persona", email: "ANA@cliente-ficticio.test", phone: "+502 9999 0000", company: "Otra Empresa", product: "Bomba de agua sumergible 2HP!", supplierName: "acme  pumps" })).json();
  assert.equal(a.duplicate, true);
  assert.equal(a.id, v.id);
  assert.equal(a.caseUrl, undefined, "sin enlace firmado en un repetido");
  // the case keeps the original contact; SEAL sees the different data apart, marked as not applied
  const j = await (await fetch(v.caseUrl + "&format=json")).json();
  assert.ok(!JSON.stringify(j).includes("9999 0000"), "el teléfono del repetido no reemplazó el del caso");
  const upd = S.attempts().slice(k);
  assert.equal(upd.length, 1);
  assert.match(upd[0].subject, /Actualización · Caso/);
  assert.match(upd[0].html, /5555 1111/);
  assert.match(upd[0].html, /Datos de contacto distintos recibidos en esta actualización \(no se aplicaron\)/);
  assert.match(upd[0].html, /9999 0000/);
  // the real owner's legitimate update of the case still works (new data completes the case)
  const b = await (await quote({ ...VICTIM, quantity: "8" })).json();
  assert.equal(b.duplicate, true);
});

test("1b · un repetido no rellena el teléfono ni la empresa que el caso no tenía; el cliente sabe que no se aplicó", async () => {
  const first = await (await quote({ name: "Rosa", email: "rosa@cliente-ficticio.test", product: "tubos de PVC de 4 pulgadas", supplierName: "Tubos SA" })).json();
  const k = S.attempts().length;
  const rep = await (await quote({ name: "Rosa", email: "rosa@cliente-ficticio.test", phone: "+502 8888 0000", company: "Empresa Ajena", product: "tubos de PVC de 4 pulgadas", supplierName: "Tubos SA" })).json();
  assert.equal(rep.duplicate, true);
  assert.equal(rep.contactPending, true);
  const j = await (await fetch(first.caseUrl + "&format=json")).json();
  assert.ok(!JSON.stringify(j).includes("8888 0000"));
  const m = S.attempts().slice(k)[0];
  assert.match(m.html, /no se aplicaron[\s\S]*8888 0000/);
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

test("6 · informe a un tercero: el nombre libre del solicitante no va en el saludo; al propio buzón sí", async () => {
  const s = await (await S.post("/api/suppliers/search", { productType: "machinery", userQuery: "sillas plásticas apilables para eventos", quantity: "4", userEmail: "pedro@cliente-ficticio.test" }, ip())).json();
  await wait(250);
  const send = async (to) => {
    const k = S.attempts().length;
    await S.post("/api/email/report", { recipientEmail: to, requesterEmail: "pedro@cliente-ficticio.test", reportToken: s.reportToken, recipientName: "Juan: su factura está vencida, abra el adjunto", lang: "es" }, ip());
    return S.attempts().slice(k)[0];
  };
  assert.doesNotMatch((await send("gerencia@otra-ficticia.test")).html, /factura está vencida/);
  assert.match((await send("pedro@cliente-ficticio.test")).html, /factura está vencida/);
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
