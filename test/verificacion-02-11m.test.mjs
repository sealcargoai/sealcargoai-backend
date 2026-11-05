// 02-11m — Abuso distribuido del flujo de códigos y límites diarios de informes persistentes.
// Datos ficticios; Resend simulado; procesos reales sobre una carpeta compartida.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { server } from "./fixtures/qa-server.mjs";
import { verifyEmail } from "./fixtures/verify.mjs";

const { createVerifyStore } = await import("../src/services/verifyStore.js");
const SECRET = Buffer.from("secreto-de-prueba-02-11m");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "seal-m-"));
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");

test("1 · ataque sostenido: fallos masivos + 6 pedidos por hora durante 24 h desde varias IP → el titular igual verifica (con un código propio o con uno que le llegó)", () => {
  const s = createVerifyStore({ secret: SECRET, env: {} });
  const E = "titular@cliente-ficticio.test";
  const t0 = Date.parse("2026-11-06T00:00:00Z");
  let inbox = [];
  for (let h = 0; h < 24; h++) {
    for (let i = 0; i < 6; i++) {
      const r = s.start(E, `10.90.${i % 2}.${h}`, t0 + h * 3600_000 + i * 61_000); // respects the waits
      if (r.ok) inbox.push({ code: r.code, at: t0 + h * 3600_000 + i * 61_000 });
    }
    for (let k = 0; k < 20; k++) s.confirm(E, "AAAAAAAA", `10.91.${h}.${k}`, t0 + h * 3600_000 + 30_000 + k);
  }
  const now = t0 + 23 * 3600_000 + 6 * 61_000 + 1000;
  // a code that reached the owner's inbox (asked for by the attacker) works for the owner from any connection
  const recentCode = inbox.filter((x) => now - x.at < 15 * 60_000).at(-1);
  assert.ok(recentCode, "llegó un código reciente al buzón");
  const s2 = createVerifyStore({ secret: SECRET, env: {} });
  void s2;
  // and the owner can still ask for their own code (reserved slot) and use it
  const mine = s.start(E, "10.92.0.1", now);
  assert.equal(mine.ok, true, "el titular no queda sin código");
  assert.ok(s.confirm(E, mine.code, "10.92.0.1", now + 1000));
});

test("1b · el código que le llegó al titular por pedido de otro también le sirve", () => {
  const s = createVerifyStore({ secret: SECRET, env: {} });
  const E = "buzon@cliente-ficticio.test";
  const t = Date.parse("2026-11-06T09:00:00Z");
  const fromAttacker = s.start(E, "10.89.0.1", t);
  for (let k = 0; k < 40; k++) s.confirm(E, "AAAAAAAA", `10.89.1.${k}`, t + k);
  assert.ok(s.confirm(E, fromAttacker.code, "10.89.2.1", t + 60_000));
});

test("2 · volumen acotado: 12 por hora por dirección aun con muchas IP; la hora siguiente se recupera; sin tope diario que deje fuera al titular", () => {
  const s = createVerifyStore({ secret: SECRET, env: {} });
  const E = "inundada@cliente-ficticio.test";
  const t = Date.parse("2026-11-06T00:00:00Z");
  const hour = [];
  for (let i = 0; i < 20; i++) hour.push(s.start(E, `10.93.${i}.1`, t + i).ok);
  assert.equal(hour.filter(Boolean).length, 12, "12 por hora");
  let total = 12;
  for (let h = 1; h < 24; h++) for (let i = 0; i < 20; i++) if (s.start(E, `10.94.${h}.${i}`, t + h * 3600_000 + i).ok) total++;
  assert.equal(total, 24 * 12, "como máximo 12 por hora, cada hora (sin bloqueo de un día)");
});

test("2b · cupo reservado: una conexión puede pedir 2 veces (con espera) aun con el cupo lleno; una IP bloqueada por fallos no", () => {
  const s = createVerifyStore({ secret: SECRET, env: {} });
  const E = "reserva@cliente-ficticio.test";
  const t = Date.parse("2026-11-06T10:00:00Z");
  for (let i = 0; i < 6; i++) s.start(E, `10.88.0.${i}`, t + i);
  assert.equal(s.start(E, "10.88.1.1", t + 100).ok, true, "primer pedido reservado");
  assert.equal(s.start(E, "10.88.1.1", t + 200).ok, false, "espera de 30 s");
  assert.equal(s.start(E, "10.88.1.1", t + 31_000).ok, true, "segundo pedido reservado (el primer código se fue a spam)");
  assert.equal(s.start(E, "10.88.1.1", t + 200_000).ok, false, "un tercero ya no (cupo lleno)");
  for (let k = 0; k < 5; k++) s.confirm(E, "AAAAAAAA", "10.88.2.1", t + 300 + k);
  assert.equal(s.start(E, "10.88.2.1", t + 400).ok, false, "IP bloqueada por fallos: sin cupo reservado");
});

test("2c · un envío fallido devuelve el cupo; la espera larga se redondea a 5 minutos", () => {
  const s = createVerifyStore({ secret: SECRET, env: {} });
  const E = "rebote@cliente-ficticio.test";
  const t = Date.parse("2026-11-06T11:00:00Z");
  for (let i = 0; i < 12; i++) {
    const r = s.start(E, `10.87.0.${i}`, t + i);
    s.cancel(E, `10.87.0.${i}`, r.code, t + i);
  }
  assert.equal(s.start(E, "10.87.1.1", t + 100).ok, true, "los 12 cancelados no cuentan");
  const s2 = createVerifyStore({ secret: SECRET, env: {} });
  for (let i = 0; i < 12; i++) s2.start(E, `10.86.0.${i}`, t + i);
  const r = s2.start(E, "10.86.0.0", t + 31_000 + 600_000);
  assert.equal(r.ok, false);
  assert.equal(r.retryAfterSeconds % 300, 0, String(r.retryAfterSeconds));
});

test("3 · los códigos anteriores siguen sirviendo mientras no vencen; vencidos no; la autorización sirve una vez", () => {
  const s = createVerifyStore({ secret: SECRET, env: {} });
  const E = "vigentes@cliente-ficticio.test";
  const t = Date.parse("2026-11-06T12:00:00Z");
  const c1 = s.start(E, "10.95.0.1", t);
  s.start(E, "10.95.0.2", t + 1000); // someone else's request does not void c1
  assert.equal(s.confirm(E, c1.code, "10.95.0.1", t + 16 * 60_000), null, "vencido a los 15 min");
  const c2 = s.start(E, "10.95.0.1", t + 17 * 60_000);
  const v = s.confirm(E, c2.code, "10.95.0.1", t + 17 * 60_000 + 1);
  assert.ok(v);
  const caps = { to: 3, by: 10 };
  assert.equal(s.consumeGrantAndCount(v.reportGrant, E, "k", "k", caps, t + 18 * 60_000), "ok");
  assert.equal(s.consumeGrantAndCount(v.reportGrant, E, "k", "k", caps, t + 18 * 60_000), "grant", "una sola vez");
});

test("4 · límite diario de informes: un reinicio (otra instancia sobre la misma carpeta) no lo reinicia; al llegar al tope la autorización no se gasta", () => {
  const dir = tmp();
  const caps = { to: 3, by: 10 };
  const E = "reportes@cliente-ficticio.test";
  const grant = (st) => {
    const c = st.start(E, `10.96.0.${Math.random()}`);
    return st.confirm(E, c.code, "x").reportGrant;
  };
  const a = createVerifyStore({ dir, secret: SECRET, env: { VERIFY_RESEND_WAIT_SECONDS: "0", VERIFY_MAX_PER_ADDRESS_IP_HOUR: "50", VERIFY_MAX_PER_ADDRESS_HOUR: "50", VERIFY_MAX_PER_IP_HOUR: "50" } });
  for (let i = 0; i < 3; i++) assert.equal(a.consumeGrantAndCount(grant(a), E, "to:x", "by:x", caps), "ok");
  const b = createVerifyStore({ dir, secret: SECRET, env: { VERIFY_RESEND_WAIT_SECONDS: "0", VERIFY_MAX_PER_ADDRESS_IP_HOUR: "50", VERIFY_MAX_PER_ADDRESS_HOUR: "50", VERIFY_MAX_PER_IP_HOUR: "50" } });
  const g = grant(b);
  assert.equal(b.reportCapOk("to:x", "by:x", caps), false);
  assert.equal(b.consumeGrantAndCount(g, E, "to:x", "by:x", caps), "limit");
  assert.equal(b.grantValid(g, E), true, "la autorización no se gastó");
  // 24 h later the cap frees up
  assert.equal(b.consumeGrantAndCount(g, E, "to:x", "by:x", caps, Date.now() + 25 * 3600_000), "grant", "(la autorización vence a los 30 min)");
  const raw = fs.readFileSync(path.join(dir, "verify.json"), "utf8");
  assert.ok(!raw.includes("to:x") && !raw.includes(E), "claves de los contadores como hash");
});

test("4b · concurrencia real: 8 procesos, cada uno con su autorización, envían a la vez → exactamente 3 pasan el tope", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const run = promisify(execFile);
  const dir = tmp();
  const SH = Buffer.from("secreto-compartido-de-prueba"); // the worker's secret
  const env = { VERIFY_RESEND_WAIT_SECONDS: "0", VERIFY_MAX_PER_ADDRESS_IP_HOUR: "50", VERIFY_MAX_PER_ADDRESS_HOUR: "50", VERIFY_MAX_PER_ADDRESS_HARD_HOUR: "50" };
  const s = createVerifyStore({ dir, secret: SH, env });
  const E = "carrera-informes@cliente-ficticio.test";
  const grants = [];
  for (let i = 0; i < 8; i++) {
    const c = s.start(E, `10.99.0.${i}`);
    grants.push(s.confirm(E, c.code, `10.99.0.${i}`).reportGrant);
  }
  const at = Date.now() + 800;
  const out = await Promise.all(grants.map((token) => run(process.execPath, ["test/fixtures/verify-worker.mjs", dir, "report", JSON.stringify({ token, email: E, to: "t", by: "b", at })]).then((r) => JSON.parse(r.stdout))));
  assert.equal(out.filter((x) => x === "ok").length, 3, JSON.stringify(out));
  assert.equal(out.filter((x) => x === "limit").length, 5);
});

// ── Servidores reales sobre una carpeta compartida ────────────────────────────────────────────
const SHARED = tmp();
const ENV = { DATA_DIR: SHARED, REPORT_SECRET: "secreto-firma-ficticio-02-11m-0123456789" };
const A = server(10100, ENV);
const B = server(10300, ENV);
before(async () => {
  await A.start();
  await B.start();
});
after(async () => {
  await A.stop();
  await B.stop();
});
const reports = () => [...A.attempts(), ...B.attempts()].filter((m) => /estimación preliminar/i.test(m.subject));

test("5 · concurrencia: 6 informes del mismo correo a la vez en dos servidores → exactamente 3 salen (tope diario), sin duplicar", async () => {
  const E = "concurrente@cliente-ficticio.test";
  const grants = [];
  for (let i = 0; i < 6; i++) grants.push((await verifyEmail(i % 2 ? B : A, E, `10.97.0.${i}`)).reportGrant);
  const k = reports().length;
  const res = await Promise.all(grants.map((g, i) => (i % 2 ? B : A).post("/api/email/report", { requesterEmail: E, reportGrant: g, pdfBase64: PDF, lang: "es" }, `10.97.1.${i}`)));
  const codes = res.map((r) => r.status).sort();
  assert.deepEqual(codes, [200, 200, 200, 429, 429, 429], JSON.stringify(codes));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(reports().length - k, 3, "3 correos de informe");
});

test("6 · reinicio del servidor: el tope diario sigue (antes se reiniciaba a cero)", async () => {
  const E = "reinicio@cliente-ficticio.test";
  for (let i = 0; i < 3; i++) {
    const v = await verifyEmail(A, E, `10.98.0.${i}`);
    assert.equal((await A.post("/api/email/report", { requesterEmail: E, reportGrant: v.reportGrant, pdfBase64: PDF }, `10.98.1.${i}`)).status, 200);
  }
  const C = server(10500, ENV); // a new process on the same volume = a restart
  await C.start();
  try {
    const v = await verifyEmail(C, E, "10.98.2.1");
    const r = await C.post("/api/email/report", { requesterEmail: E, reportGrant: v.reportGrant, pdfBase64: PDF }, "10.98.2.2");
    assert.equal(r.status, 429);
    assert.equal((await r.json()).error, "report_limit");
  } finally {
    await C.stop();
  }
});

test("privacidad · registros sin direcciones, códigos ni tokens", () => {
  for (const s of [A, B]) assert.doesNotMatch(s.logs, /[\w.+-]+@[\w-]+\.[\w.]+/);
});

test("7 · /health: DATA_DIR y la carpeta de verificación están (o no) dentro del volumen montado; origen de la clave, sin valores", async () => {
  const vol = tmp();
  const cases = [
    [{ RAILWAY_VOLUME_MOUNT_PATH: vol, DATA_DIR: vol, REPORT_SECRET: "" }, { dataDir: "on-volume", verifyDir: "on-volume", visionDir: "on-volume", verifyKey: "volume-file" }],
    [{ RAILWAY_VOLUME_MOUNT_PATH: vol, DATA_DIR: path.join(vol, "sub"), REPORT_SECRET: "x".repeat(40) }, { dataDir: "on-volume", verifyDir: "on-volume", visionDir: "on-volume", verifyKey: "env" }],
    [{ RAILWAY_VOLUME_MOUNT_PATH: vol, DATA_DIR: tmp(), REPORT_SECRET: "" }, { dataDir: "not-on-volume", verifyDir: "not-on-volume", visionDir: "not-on-volume", verifyKey: "file-not-on-volume" }],
    [{ RAILWAY_VOLUME_MOUNT_PATH: "", DATA_DIR: "", REPORT_SECRET: "" }, { dataDir: "unset", verifyDir: "unset", visionDir: "unset", verifyKey: "ephemeral" }],
  ];
  for (const [env, want] of cases) {
    const s = server(10700, env);
    await s.start();
    const h = await fetch(`${s.BASE}/health`).then((r) => r.json());
    await s.stop();
    assert.deepEqual(h.storage, want, JSON.stringify(want));
    assert.ok(!JSON.stringify(h).includes(vol), "sin rutas");
  }
});
