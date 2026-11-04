// 02-11o — Agotamiento global de códigos: direcciones comerciales, cupo por red, desafío adaptativo (prueba
// de trabajo) y recuperación del titular con su sesión verificada. Datos ficticios; Resend simulado.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { server } from "./fixtures/qa-server.mjs";
import { solve, startSolving } from "./fixtures/pow.mjs";
import { verifyEmail } from "./fixtures/verify.mjs";

const run = promisify(execFile);
const { createVerifyStore, netKey, powBits } = await import("../src/services/verifyStore.js");
const SECRET = Buffer.from("secreto-de-prueba-02-11o");
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "seal-o-"));
const ip4 = (i) => `10.${(i >> 8) & 255}.${i & 255}.7`; // a different /24 for each i
// tests that solve many challenges use small difficulties (the default 16/18 bits are checked in test 3)
const FAST = { VERIFY_POW_BITS_1: "4", VERIFY_POW_BITS_2: "6" };
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n").toString("base64");

test("1 · pedidos para direcciones de ventas de SEAL no gastan el cupo global (no se les envía nada)", () => {
  const s = createVerifyStore({ secret: SECRET, env: { ...FAST, VERIFY_MAX_GLOBAL_HOUR: "20" } });
  const t = Date.parse("2026-11-04T10:00:00Z");
  // (each sales address keeps its own per-address limits, like any address: the answer stays uniform)
  for (let i = 0; i < 200; i++) assert.equal(startSolving(s, `ventas+${i}@example.test`, ip4(i), t + i, { noCode: true }).ok, true);
  const r = startSolving(s, "cliente@cliente-ficticio.test", ip4(999), t + 1000);
  assert.equal(r.ok, true, "el cupo para correos reales sigue entero");
  assert.ok(r.code);
});

test("2 · una sola red (/24, o /48 en IPv6) no puede tomar más de 30 de los 300 códigos por hora", () => {
  assert.equal(netKey("10.1.2.3"), "10.1.2.0/24");
  assert.equal(netKey("2001:db8:aa:1::/64"), "2001:db8:aa::/48");
  const s = createVerifyStore({ secret: SECRET, env: { ...FAST } });
  const t = Date.parse("2026-11-04T11:00:00Z");
  const same = [];
  for (let i = 0; i < 40; i++) same.push(startSolving(s, `r${i}@cliente-ficticio.test`, `10.50.60.${i}`, t + i).ok);
  assert.equal(same.filter(Boolean).length, 30);
  const v6 = [];
  for (let i = 0; i < 40; i++) v6.push(startSolving(s, `v${i}@cliente-ficticio.test`, `2001:db8:77:${i.toString(16)}::/64`, t + 100 + i).ok);
  assert.equal(v6.filter(Boolean).length, 30, "40 bloques /64 de un mismo /48 cuentan como una red");
  assert.equal(startSolving(s, "otra@cliente-ficticio.test", "10.50.61.1", t + 200).ok, true, "otra red, sí");
});

test("3 · inundación distribuida que no resuelve el desafío: no gasta el cupo; quien lo resuelve sigue recibiendo códigos", () => {
  const s = createVerifyStore({ secret: SECRET, env: {} });
  const t = Date.parse("2026-11-04T12:00:00Z");
  for (let i = 0; i < 150; i++) assert.equal(s.start(`b${i}@cliente-ficticio.test`, ip4(i), t + i).ok, true, `antes del 50 % no hace falta (${i})`);
  let refused = 0;
  for (let i = 150; i < 1150; i++) {
    const r = s.start(`b${i}@cliente-ficticio.test`, ip4(i), t + i);
    if (!r.ok && r.reason === "challenge" && r.bits === 16) refused++;
  }
  assert.equal(refused, 1000, "1000 pedidos de bots sin desafío: rechazados, sin gastar cupo");
  const legit = startSolving(s, "titular@cliente-ficticio.test", ip4(5000), t + 5000);
  assert.equal(legit.ok, true, "una persona (el navegador resuelve el desafío) sigue recibiendo su código");
  // above 80 % the difficulty rises to 18 bits (default parameters, small budget: 8 of 10 used)
  const s10 = createVerifyStore({ secret: SECRET, env: { VERIFY_MAX_GLOBAL_HOUR: "10" } });
  for (let i = 0; i < 8; i++) assert.equal(startSolving(s10, `c${i}@cliente-ficticio.test`, ip4(6000 + i), t + 6000 + i).ok, true);
  const hard = s10.start("d@cliente-ficticio.test", ip4(7000), t + 7000);
  assert.deepEqual([hard.ok, hard.bits], [false, 18]);
});

test("4 · el desafío no se reutiliza, no sirve para otra dirección o conexión, vence y exige la dificultad pedida", () => {
  const s = createVerifyStore({ secret: SECRET, env: { VERIFY_MAX_GLOBAL_HOUR: "4" } }); // default difficulty
  const t = Date.parse("2026-11-04T13:00:00Z");
  for (let i = 0; i < 2; i++) s.start(`p${i}@cliente-ficticio.test`, ip4(i), t + i); // 50 % → challenge
  const E = "q@cliente-ficticio.test";
  const IP = ip4(50);
  const c = s.challenge(E, IP, 16, t + 10);
  const n = solve(c, 16);
  assert.equal(s.start("otro@cliente-ficticio.test", IP, t + 11, { pow: { challenge: c, nonce: n } }).ok, false, "otra dirección");
  assert.equal(s.start(E, ip4(51), t + 12, { pow: { challenge: c, nonce: n } }).ok, false, "otra conexión");
  assert.equal(s.start(E, IP, t + 10 + 6 * 60_000, { pow: { challenge: c, nonce: n } }).ok, false, "vencido (5 min)");
  const weak = s.challenge(E, IP, 4, t + 20);
  assert.equal(s.start(E, IP, t + 21, { pow: { challenge: weak, nonce: solve(weak, 4) } }).ok, false, "dificultad menor a la pedida");
  const tampered = c.replace(/\.16\./, ".20.");
  assert.equal(s.start(E, IP, t + 22, { pow: { challenge: tampered, nonce: n } }).ok, false, "dificultad alterada (firma)");
  let bad = 0;
  while (powBits(c, String(bad)) >= 16) bad++;
  assert.equal(s.start(E, IP, t + 23, { pow: { challenge: c, nonce: String(bad) } }).ok, false, "nonce que no resuelve");
  assert.equal(s.start(E, IP, t + 24, { pow: { challenge: c, nonce: n } }).ok, true, "el correcto");
  assert.equal(s.start(E, IP, t + 70_000, { pow: { challenge: c, nonce: n } }).ok, false, "y no se puede volver a usar (misma dirección y conexión)");
});

test("5 · cupo global agotado: el titular recupera con su sesión verificada (sin código nuevo) y con los códigos que ya recibió", () => {
  const s = createVerifyStore({ secret: SECRET, env: { ...FAST, VERIFY_MAX_GLOBAL_HOUR: "10", VERIFY_RESERVE_HOUR: "2" } });
  const t = Date.parse("2026-11-04T14:00:00Z");
  const E = "duena@cliente-ficticio.test";
  const first = startSolving(s, E, ip4(1), t);
  const v = s.confirm(E, first.code, ip4(1), t + 1000);
  const received = startSolving(s, E, ip4(1), t + 40_000); // a code she received, still unused
  for (let i = 0; i < 50; i++) startSolving(s, `atk${i}@cliente-ficticio.test`, ip4(100 + i), t + 50_000 + i);
  assert.equal(startSolving(s, E, ip4(2), t + 60_000).ok, false, "cupo global y reserva agotados: no hay códigos nuevos");
  // recovery 1: the session (12 h) gives a new report grant without email
  const g = s.renew(v.session, E, t + 70_000);
  assert.ok(g?.reportGrant);
  assert.equal(s.consumeGrantAndCount(g.reportGrant, E, "k", "k", { to: 3, by: 10 }, t + 71_000), "ok");
  assert.equal(s.consumeGrantAndCount(g.reportGrant, E, "k", "k", { to: 3, by: 10 }, t + 72_000), "grant", "una sola vez");
  // recovery 2: the code she already received still works (15 min)
  assert.ok(s.confirm(E, received.code, ip4(3), t + 80_000));
  // a third party's session does not renew for her; the session expires at 12 h; at most 10 renewals a day
  const other = s.confirm("atk0@cliente-ficticio.test", "XXXXXXXXXX", ip4(100), t);
  assert.equal(other, null);
  assert.equal(s.renew(v.session, "otra@cliente-ficticio.test", t + 90_000), null);
  let n = 1;
  while (s.renew(v.session, E, t + 100_000 + n)) n++;
  assert.equal(n, 10, "10 renovaciones por día");
  assert.equal(s.renew(v.session, E, t + 13 * 3600_000), null, "sesión vencida (12 h)");
});

test("6 · un envío fallido devuelve también el cupo de red y global", () => {
  const s = createVerifyStore({ secret: SECRET, env: { ...FAST, VERIFY_MAX_GLOBAL_HOUR: "3", VERIFY_MAX_PER_NETWORK_HOUR: "2" } });
  const t = Date.parse("2026-11-04T15:00:00Z");
  for (let i = 0; i < 5; i++) {
    const r = startSolving(s, `f${i}@cliente-ficticio.test`, `10.70.80.${i}`, t + i * 1000);
    assert.equal(r.ok, true, `intento ${i}`);
    s.cancel(`f${i}@cliente-ficticio.test`, `10.70.80.${i}`, r.code, t + i * 1000);
  }
});

test("7 · concurrencia real: 30 procesos de 30 redes con tope global 10 y reserva 2 → exactamente 12 códigos", async () => {
  const dir = tmp();
  const env = { ...FAST, VERIFY_MAX_GLOBAL_HOUR: "10", VERIFY_RESERVE_HOUR: "2" };
  const out = await Promise.all(Array.from({ length: 30 }, (_, i) => run(process.execPath, ["test/fixtures/verify-worker.mjs", dir, "startSolving", JSON.stringify({ email: `w${i}@cliente-ficticio.test`, ip: ip4(i), env })]).then((r) => JSON.parse(r.stdout))));
  assert.equal(out.filter((x) => x === true).length, 12, JSON.stringify(out)); // 10 + reserve 2
});

// ── Servidor real ─────────────────────────────────────────────────────────────────────────────
const S = server(11100, { VERIFY_MAX_GLOBAL_HOUR: "4", VERIFY_MAX_PER_ADDRESS_HOUR: "", VERIFY_MAX_PER_IP_HOUR: "", VERIFY_MAX_PER_ADDRESS_IP_HOUR: "", VERIFY_RESEND_WAIT_SECONDS: "" });
const S2 = server(11300, {});
before(async () => {
  await S.start();
  await S2.start();
});
after(async () => {
  await S.stop();
  await S2.stop();
});

test("8 · HTTP: 428 con desafío (igual para ventas y para cualquier correo); resuelto → enviado; renovación con sesión", async () => {
  const st = (email, ip, extra = {}) => S.post("/api/email/verify/start", { email, ...extra }, ip);
  assert.equal((await st("a1@cliente-ficticio.test", "10.200.1.1")).status, 200);
  assert.equal((await st("a2@cliente-ficticio.test", "10.200.2.1")).status, 200);
  const k = S.attempts().length;
  const r1 = await st("ventas@example.test", "10.200.3.1");
  const r2 = await st("nadie@cliente-ficticio.test", "10.200.4.1");
  const [j1, j2] = [await r1.json(), await r2.json()];
  assert.deepEqual([r1.status, r2.status, j1.error, j2.error, j1.difficulty, j2.difficulty], [428, 428, "challenge_required", "challenge_required", 16, 16], "la misma respuesta");
  assert.doesNotMatch(JSON.stringify(j2), /@/);
  assert.equal(S.attempts().length, k, "nada enviado sin desafío");
  const ok = await st("nadie@cliente-ficticio.test", "10.200.4.1", { challenge: j2.challenge, nonce: solve(j2.challenge, 16) });
  assert.deepEqual([ok.status, await ok.json()], [200, { sent: true }]);
});

test("9 · HTTP: con su sesión verificada el titular obtiene otra autorización sin código y envía su informe; una sesión falsa o ajena no", async () => {
  const E = "renueva@cliente-ficticio.test";
  const v = await verifyEmail(S2, E, "10.201.1.1");
  const k = S2.attempts().length;
  const r = await S2.post("/api/email/verify/renew", { email: E, session: v.session }, "10.201.1.2");
  assert.equal(r.status, 200);
  const g = await r.json();
  assert.equal(S2.attempts().length, k, "renovar no envía ningún correo");
  const rep = await S2.post("/api/email/report", { requesterEmail: E, reportGrant: g.reportGrant, pdfBase64: PDF }, "10.201.1.3");
  assert.equal(rep.status, 200);
  assert.equal((await S2.post("/api/email/report", { requesterEmail: E, reportGrant: g.reportGrant, pdfBase64: PDF }, "10.201.1.3")).status, 403, "una sola vez");
  assert.equal((await S2.post("/api/email/verify/renew", { email: E, session: "s".repeat(43) }, "10.201.1.4")).status, 403);
  assert.equal((await S2.post("/api/email/verify/renew", { email: "otra@cliente-ficticio.test", session: v.session }, "10.201.1.5")).status, 403, "la sesión es de otra identidad");
});

test("privacidad · registros sin direcciones ni desafíos", () => {
  for (const x of [S, S2]) assert.doesNotMatch(x.logs, /[\w.+-]+@[\w-]+\.[\w.]+/);
});

test("10 · cupo principal agotado: la reserva da un código a cada red que no pidió en la hora (con el desafío más difícil), hasta 60", () => {
  const s = createVerifyStore({ secret: SECRET, env: { ...FAST } });
  const t = Date.parse("2026-11-04T16:00:00Z");
  // the attacker uses the 300 from 10 networks (30 each)
  let used = 0;
  for (let net = 0; net < 10; net++) for (let k = 0; k < 30; k++) if (startSolving(s, `x${net}-${k}@cliente-ficticio.test`, `10.${net}.1.${k}`, t + net * 100 + k).ok) used++;
  assert.equal(used, 300);
  assert.equal(startSolving(s, "y@cliente-ficticio.test", "10.0.1.200", t + 2000).ok, false, "una red que ya pidió: sin reserva");
  const first = s.start("titular@cliente-ficticio.test", "10.99.9.9", t + 3000);
  assert.deepEqual([first.ok, first.bits], [false, 6], "la reserva exige el desafío más difícil (aquí 6 bits; 18 por defecto)");
  assert.equal(startSolving(s, "titular@cliente-ficticio.test", "10.99.9.9", t + 3000).ok, true, "una red nueva (la del titular) sí obtiene su código");
  assert.equal(startSolving(s, "titular2@cliente-ficticio.test", "10.99.9.10", t + 3001).ok, false, "una por red");
  let reserve = 1;
  for (let i = 0; i < 100; i++) if (startSolving(s, `z${i}@cliente-ficticio.test`, `10.${100 + (i >> 4)}.${i & 15}.1`, t + 4000 + i).ok) reserve++;
  assert.equal(reserve, 60, "la reserva tiene un tope (60): el remitente nunca pasa de 360 por hora");
});
