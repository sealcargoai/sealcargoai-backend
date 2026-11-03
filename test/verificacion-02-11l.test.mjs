// 02-11l — Verificación de correo: almacén compartido y persistente, concurrencia, fallos del almacén y abuso.
// Datos ficticios; Resend simulado; los "procesos" son procesos reales de Node sobre una carpeta compartida.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { server } from "./fixtures/qa-server.mjs";
import { verifyEmail } from "./fixtures/verify.mjs";

const run = promisify(execFile);
const { createVerifyStore } = await import("../src/services/verifyStore.js");
const SECRET = Buffer.from("secreto-compartido-de-prueba");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "seal-verify-"));
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");
const worker = (dir, op, args) => run(process.execPath, ["test/fixtures/verify-worker.mjs", dir, op, JSON.stringify(args)]).then((r) => JSON.parse(r.stdout));

test("1 · persistencia: un reinicio (instancia nueva sobre la misma carpeta) conserva código, sesión y autorización", () => {
  const dir = tmp();
  const a = createVerifyStore({ dir, secret: SECRET });
  const t = Date.now();
  const c1 = a.start("ana@cliente-ficticio.test", "10.30.0.1", t);
  const b = createVerifyStore({ dir, secret: SECRET }); // «restart»
  const ok = b.confirm("ana@cliente-ficticio.test", c1.code, "10.30.0.1", t + 1000);
  assert.ok(ok, "el código enviado antes del reinicio sirve después");
  const c = createVerifyStore({ dir, secret: SECRET });
  assert.equal(c.sessionVerifies(ok.session, "ana@cliente-ficticio.test", t + 2000), true);
  assert.equal(c.grantValid(ok.reportGrant, "ana@cliente-ficticio.test", t + 2000), true);
  assert.equal(c.consumeGrant(ok.reportGrant, "ana@cliente-ficticio.test", t + 3000), true);
  assert.equal(a.consumeGrant(ok.reportGrant, "ana@cliente-ficticio.test", t + 4000), false, "la otra instancia ve que ya se usó");
  // nothing in clear in the file
  const raw = fs.readFileSync(path.join(dir, "verify.json"), "utf8");
  for (const x of [ok.session, ok.reportGrant, c1.code, "ana@", "cliente-ficticio", "10.30.0.1"]) assert.ok(!raw.includes(x), `no está en claro: ${x.slice(0, 6)}`);
  assert.equal((fs.statSync(path.join(dir, "verify.json")).mode & 0o777).toString(8), "600");
  // another secret cannot use the stored credentials
  const other = createVerifyStore({ dir, secret: Buffer.from("otro-secreto") });
  assert.equal(other.sessionVerifies(ok.session, "ana@cliente-ficticio.test", t + 5000), false);
});

test("2 · expiración e intentos se conservan en el almacén compartido", () => {
  const dir = tmp();
  const s = createVerifyStore({ dir, secret: SECRET });
  const t = Date.now();
  const c = s.start("vence@cliente-ficticio.test", "10.31.0.1", t);
  assert.equal(createVerifyStore({ dir, secret: SECRET }).confirm("vence@cliente-ficticio.test", c.code, "10.31.0.1", t + 16 * 60 * 1000), null, "15 min");
  const c2 = s.start("vence2@cliente-ficticio.test", "10.31.0.1", t);
  const v = s.confirm("vence2@cliente-ficticio.test", c2.code, "10.31.0.1", t);
  assert.equal(createVerifyStore({ dir, secret: SECRET }).grantValid(v.reportGrant, "vence2@cliente-ficticio.test", t + 31 * 60 * 1000), false, "30 min");
  assert.equal(createVerifyStore({ dir, secret: SECRET }).sessionVerifies(v.session, "vence2@cliente-ficticio.test", t + 13 * 3600 * 1000), false, "12 h");
  // identity: the grant of one address is not the grant of a look-alike or of another address
  const c3 = s.start("k.a@cliente-ficticio.test", "10.31.0.2", t);
  const v3 = s.confirm("k.a@cliente-ficticio.test", c3.code, "10.31.0.2", t);
  for (const e of ["ka@cliente-ficticio.test", "k.a+x@cliente-ficticio.test", "otra@cliente-ficticio.test"]) assert.equal(s.grantValid(v3.reportGrant, e, t), false, e);
});

test("3 · concurrencia real: 8 procesos consumen la misma autorización a la vez → exactamente 1 la usa", async () => {
  const dir = tmp();
  const s = createVerifyStore({ dir, secret: SECRET });
  const c = s.start("carrera@cliente-ficticio.test", "10.32.0.1");
  const v = s.confirm("carrera@cliente-ficticio.test", c.code, "10.32.0.1");
  const at = Date.now() + 700;
  const results = await Promise.all(Array.from({ length: 8 }, () => worker(dir, "consume", { token: v.reportGrant, email: "carrera@cliente-ficticio.test", at })));
  assert.equal(results.filter((x) => x === true).length, 1, JSON.stringify(results));
  assert.equal(results.filter((x) => x === false).length, 7);
});

test("4 · carrera de pedidos de código desde muchas IP y procesos: nunca más de 12 por dirección y hora (6 + reservados)", async () => {
  const dir = tmp();
  const at = Date.now() + 700;
  // 02-11m: 6 per hour, plus one reserved code per fresh connection up to 12 per hour in total
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => worker(dir, "start", { email: "victima@cliente-ficticio.test", ip: `10.33.0.${i + 1}`, at })));
  assert.equal(results.filter((x) => x === true).length, 12, JSON.stringify(results));
});

test("5 · abuso: un tercero no anula ni agota al titular sin dejarle salida", () => {
  const s = createVerifyStore({ secret: SECRET, env: {} }); // default limits
  const E = "titular@cliente-ficticio.test";
  let t = Date.parse("2026-11-03T10:00:00Z");
  const mine = s.start(E, "10.40.0.1", t); // the owner receives a code
  // the attacker, from one IP: 1 code, then a progressive wait (30 s, then 60 s), at most 3 per hour
  assert.equal(s.start(E, "10.66.0.1", t + 1).ok, true);
  const w = s.start(E, "10.66.0.1", t + 2);
  assert.equal(w.ok, false);
  assert.ok(w.retryAfterSeconds >= 29 && w.retryAfterSeconds <= 30, String(w.retryAfterSeconds));
  assert.equal(s.start(E, "10.66.0.1", t + 31_000).ok, true);
  assert.equal(s.start(E, "10.66.0.1", t + 61_000).ok, false, "segunda espera: 60 s");
  assert.equal(s.start(E, "10.66.0.1", t + 92_000).ok, true, "la tercera, tras esperar 60 s");
  assert.equal(s.start(E, "10.66.0.1", t + 600_000).ok, false, "máximo 3 por hora desde esa IP");
  // from many IPs it reaches the per-address cap (6/hour) …
  for (let i = 2; i <= 9; i++) s.start(E, `10.66.0.${i}`, t + 100_000 + i);
  // 02-11m: an IP that already asked in the last hour does not get the reserved slot
  assert.equal(s.start(E, "10.40.0.1", t + 200_000).ok, false, "cupo por dirección agotado");
  // … but the code the owner already received still works, and wrong guesses from those IPs do not void it
  for (let i = 2; i <= 9; i++) for (let k = 0; k < 2; k++) s.confirm(E, "000000" === mine.code ? "111111" : "000000", `10.66.0.${i}`, t + 210_000 + i);
  assert.ok(s.confirm(E, mine.code, "10.40.0.1", t + 300_000), "el titular verifica con su código");
  // and after the hour the owner gets new codes again
  t += 61 * 60 * 1000;
  const again = s.start(E, "10.40.0.1", t);
  assert.equal(again.ok, true);
  assert.ok(s.confirm(E, again.code, "10.40.0.1", t + 1000));
});

test("6 · fuerza bruta: 5 fallos por IP y dirección por hora bloquean ESA IP; 02-11m: no hay bloqueo por dirección", () => {
  const s = createVerifyStore({ secret: SECRET, env: {} });
  const E = "objetivo@cliente-ficticio.test";
  const t = Date.parse("2026-11-03T12:00:00Z");
  const c = s.start(E, "10.50.0.1", t);
  assert.match(c.code, /^[A-HJ-NP-Z2-9]{10}$/, "10 símbolos sin I, O, 0 ni 1");
  for (let i = 0; i < 5; i++) assert.equal(s.confirm(E, "AAAAAAAA", "10.51.0.1", t + i), null);
  assert.equal(s.confirm(E, c.code, "10.51.0.1", t + 10), null, "esa IP: bloqueada una hora aun con el código correcto");
  // 100 wrong codes from 20 other IPs do not lock the address: the owner still verifies
  for (let i = 0; i < 100; i++) s.confirm(E, "AAAAAAAA", `10.52.0.${i % 20}`, t + 20 + i);
  assert.ok(s.confirm(E, c.code.toLowerCase().replace(/(.{5})/, "$1-"), "10.50.0.1", t + 200), "el titular verifica (minúsculas y guion aceptados)");
});

test("7 · fallo del almacén: lectura o escritura imposible → error controlado, nada concedido", () => {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "verify.json")); // unreadable as a file
  const s = createVerifyStore({ dir, secret: SECRET });
  for (const f of [() => s.start("x@cliente-ficticio.test", "10.60.0.1"), () => s.confirm("x@cliente-ficticio.test", "123456", "10.60.0.1"), () => s.consumeGrant("g".repeat(43), "x@cliente-ficticio.test")])
    assert.throws(f, (e) => e.code === "VERIFY_STORE");
  // a file that cannot be read but whose place can be written (a symlink loop): still refused, never
  // treated as «empty» (that would forget used grants and counters)
  const dir3 = tmp();
  fs.symlinkSync("verify.json", path.join(dir3, "verify.json"));
  const s3 = createVerifyStore({ dir: dir3, secret: SECRET });
  assert.throws(() => s3.consumeGrant("g".repeat(43), "x@cliente-ficticio.test"), (e) => e.code === "VERIFY_STORE");
  assert.throws(() => s3.start("x@cliente-ficticio.test", "10.60.0.2"), (e) => e.code === "VERIFY_STORE");
  // a damaged (not JSON) file is set aside: credentials are lost (fail closed), the store keeps working
  const dir2 = tmp();
  fs.writeFileSync(path.join(dir2, "verify.json"), "{dañado");
  const s2 = createVerifyStore({ dir: dir2, secret: SECRET });
  assert.equal(s2.grantValid("g".repeat(43), "x@cliente-ficticio.test"), false);
  assert.ok(fs.readdirSync(dir2).some((f) => f.startsWith("verify.json.damaged-")));
});

// ── Servidor real ─────────────────────────────────────────────────────────────────────────────
const SHARED = tmp();
const ENV = { DATA_DIR: SHARED, REPORT_SECRET: "secreto-de-firma-ficticio-0123456789", QA_EMAILS: "qa1@prueba.test" };
const A = server(9100, ENV);
const B = server(9300, ENV);
const BROKEN = server(9500, { VERIFY_DATA_DIR: path.join(SHARED, "no-es-carpeta.txt", "sub") });
before(async () => {
  fs.writeFileSync(path.join(SHARED, "no-es-carpeta.txt"), "x");
  await A.start();
  await B.start();
  await BROKEN.start();
});
after(async () => {
  await A.stop();
  await B.stop();
  await BROKEN.stop();
});
const allMails = () => [...A.attempts(), ...B.attempts()];

test("8 · dos instancias: código pedido en A, confirmado en B; informe en A; la autorización enviada a A y B a la vez sirve una vez", async () => {
  await A.post("/api/email/verify/start", { email: "multi@cliente-ficticio.test" }, "10.70.0.1");
  const m = A.mails().filter((x) => /código/i.test(x.subject)).at(-1);
  const code = m.html.match(/letter-spacing:6px[^"]*">([A-Z0-9]{5}-[A-Z0-9]{5})</)[1];
  const r = await B.post("/api/email/verify/confirm", { email: "multi@cliente-ficticio.test", code }, "10.70.0.1");
  assert.equal(r.status, 200, "B conoce el código enviado por A");
  const v = await r.json();
  assert.ok(v.reportGrant);
  const before = allMails().filter((x) => /estimación preliminar/i.test(x.subject)).length;
  const body = { requesterEmail: "multi@cliente-ficticio.test", reportGrant: v.reportGrant, pdfBase64: PDF, lang: "es" };
  const [ra, rb] = await Promise.all([A.post("/api/email/report", body, "10.70.0.2"), B.post("/api/email/report", body, "10.70.0.3")]);
  assert.deepEqual([ra.status, rb.status].sort(), [200, 403], "una sola instancia lo envía");
  await new Promise((x) => setTimeout(x, 200));
  assert.equal(allMails().filter((x) => /estimación preliminar/i.test(x.subject)).length, before + 1, "un solo informe");
});

test("9 · una sesión QA verificada en A sirve en B (límite de búsquedas)", async () => {
  const v = await verifyEmail(A, "qa1@prueba.test", "10.71.0.1");
  const q = await fetch(`${B.BASE}/api/suppliers/quota?email=qa1%40prueba.test`, { headers: { "x-real-ip": "10.71.0.2", "x-verified-session": v.session } }).then((r) => r.json());
  assert.equal(q.reason, "");
  const health = await fetch(`${B.BASE}/health`).then((r) => r.json());
  assert.equal(health.verifyStore, "persistent");
});

test("10 · almacén caído: pedir código, confirmarlo o enviar informe → 503 con mensaje claro, sin correos", async () => {
  const k = BROKEN.attempts().length;
  const s = await BROKEN.post("/api/email/verify/start", { email: "caido@cliente-ficticio.test" }, "10.72.0.1");
  assert.equal(s.status, 503);
  const j = await s.json();
  assert.equal(j.error, "verify_unavailable");
  assert.match(j.message, /Nothing was sent/);
  assert.doesNotMatch(JSON.stringify(j), /@|verify\.json|ENOTDIR/);
  assert.equal((await BROKEN.post("/api/email/verify/confirm", { email: "caido@cliente-ficticio.test", code: "123456" }, "10.72.0.1")).status, 503);
  assert.equal((await BROKEN.post("/api/email/report", { requesterEmail: "caido@cliente-ficticio.test", reportGrant: "g".repeat(43), pdfBase64: PDF }, "10.72.0.1")).status, 503);
  assert.equal(BROKEN.attempts().length, k, "nada se intentó enviar");
  // searches keep working with normal limits (a QA session cannot be checked: not exempt)
  const q = await BROKEN.post("/api/suppliers/search", { productType: "machinery", userQuery: "sillas plásticas apilables para eventos", quantity: "4", userEmail: "qa1@prueba.test", verifiedSession: "s".repeat(43) }, "10.72.0.2");
  assert.equal(q.status, 200);
  assert.equal((await fetch(`${BROKEN.BASE}/health`).then((r) => r.json())).verifyStore, "persistent");
});

test("privacidad · registros sin direcciones, códigos ni tokens", () => {
  for (const s of [A, B, BROKEN]) assert.doesNotMatch(s.logs, /[\w.+-]+@[\w-]+\.[\w.]+|\b\d{6}\b(?!\s*ms)/);
});

test("11 · remitente: /health informa el estado del dominio en Resend (solo lectura, sin dirección ni clave)", async () => {
  const cases = [
    [{ RESEND_FROM: "SEAL <avisos@seal-ficticio.test>", FAKE_DOMAINS: JSON.stringify([{ name: "seal-ficticio.test", status: "verified" }]) }, { from: "custom", domain: "verified" }],
    [{ RESEND_FROM: "SEAL <avisos@mail.seal-ficticio.test>", FAKE_DOMAINS: JSON.stringify([{ name: "mail.seal-ficticio.test", status: "pending" }]) }, { from: "custom", domain: "pending" }],
    // only the parent domain verified: the sending subdomain is NOT reported as verified
    [{ RESEND_FROM: "SEAL <avisos@mail.seal-ficticio.test>", FAKE_DOMAINS: JSON.stringify([{ name: "seal-ficticio.test", status: "verified" }]) }, { from: "custom", domain: "not_found" }],
    [{ RESEND_FROM: "SEAL <avisos@otro-ficticio.test>", FAKE_DOMAINS: "[]" }, { from: "custom", domain: "not_found" }],
    [{ RESEND_FROM: "SEAL <avisos@seal-ficticio.test>", FAKE_DOMAINS_DENIED: "1" }, { from: "custom", domain: "no_access" }],
    [{ RESEND_FROM: "" }, { from: "resend-test-sender", domain: "unknown" }],
  ];
  for (const [env, want] of cases) {
    const s = server(9700, env);
    await s.start();
    await new Promise((r) => setTimeout(r, 300));
    const h = await fetch(`${s.BASE}/health`).then((r) => r.json());
    const k = s.attempts().length;
    await s.stop();
    assert.deepEqual(h.emailSender, want, JSON.stringify(env));
    assert.doesNotMatch(JSON.stringify(h), /@|ficticio|re_test/);
    assert.equal(k, 0, "ningún correo");
  }
});

test("13 · revisión: bloqueo vencido se recupera; bloqueo vivo → error controlado en ≤ ~1 s; lecturas no reescriben", () => {
  const dir = tmp();
  const s = createVerifyStore({ dir, secret: SECRET });
  const c = s.start("lock@cliente-ficticio.test", "10.83.0.1");
  const v = s.confirm("lock@cliente-ficticio.test", c.code, "10.83.0.1");
  const lock = path.join(dir, "verify.json.lock");
  // a live lock (another process inside a transaction): fails closed, quickly
  fs.writeFileSync(lock, "otro-proceso");
  const t0 = Date.now();
  assert.throws(() => s.consumeGrant(v.reportGrant, "lock@cliente-ficticio.test"), (e) => e.code === "VERIFY_STORE");
  assert.ok(Date.now() - t0 < 1500, `esperó ${Date.now() - t0} ms`);
  assert.equal(fs.readFileSync(lock, "utf8"), "otro-proceso", "no borra un bloqueo ajeno");
  // the same lock, left by a crashed process (old): taken over
  const old = new Date(Date.now() - 5000);
  fs.utimesSync(lock, old, old);
  const before = fs.statSync(path.join(dir, "verify.json")).mtimeMs;
  assert.equal(s.grantValid(v.reportGrant, "lock@cliente-ficticio.test"), true);
  assert.equal(fs.statSync(path.join(dir, "verify.json")).mtimeMs, before, "una lectura no reescribe el archivo");
  assert.equal(s.consumeGrant(v.reportGrant, "lock@cliente-ficticio.test"), true);
  assert.ok(!fs.existsSync(lock), "bloqueo liberado");
});

test("14 · revisión: tope global de códigos por hora; direcciones de ventas sin código guardado", () => {
  const s = createVerifyStore({ secret: SECRET, env: { VERIFY_MAX_GLOBAL_HOUR: "3" } });
  const t = Date.now();
  assert.deepEqual([1, 2, 3, 4].map((i) => s.start(`g${i}@cliente-ficticio.test`, `10.84.0.${i}`, t + i).ok), [true, true, true, false]);
  const dir = tmp();
  const p = createVerifyStore({ dir, secret: SECRET });
  assert.deepEqual(p.start("ventas@example.test", "10.85.0.1", t, { noCode: true }), { ok: true, code: "" });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "verify.json"), "utf8")).codes, {}, "ningún código que adivinar");
});

test("15 · revisión: /health dice si la clave de los hashes no sobrevive a un reinicio", async () => {
  const dir = tmp();
  const s = server(9900, { DATA_DIR: "", REPORT_SECRET: "", VERIFY_SECRET: "", VERIFY_DATA_DIR: dir });
  await s.start();
  const h = await fetch(`${s.BASE}/health`).then((r) => r.json());
  await s.stop();
  assert.equal(h.verifyStore, "persistent-ephemeral-key");
  const s2 = server(9900, { DATA_DIR: "", REPORT_SECRET: "", VERIFY_SECRET: "un-secreto-ficticio-de-prueba", VERIFY_DATA_DIR: dir });
  await s2.start();
  const h2 = await fetch(`${s2.BASE}/health`).then((r) => r.json());
  await s2.stop();
  assert.equal(h2.verifyStore, "persistent");
});
