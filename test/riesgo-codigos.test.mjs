// 02-11n — El riesgo de fuerza bruta se calcula con los parámetros reales y el cierre no puede afirmar otra
// cifra. Falla si alguien acorta el código, alarga su vigencia o sube los límites sin rehacer la cuenta.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { risk, fmt, exhaustion } from "../scripts/riesgo-codigos.mjs";
const { codeRiskParams } = await import("../src/services/verifyStore.js");

const YEAR = 24 * 365;
const P = codeRiskParams({});

test("la cota conservadora (atacante óptimo, 100 000 IP, 1 año) queda por debajo de 1e-4", () => {
  const r = risk(P, 100_000, YEAR);
  assert.ok(r.bound < 1e-4, `cota ${fmt(r.bound)} con ${JSON.stringify(P)}`);
  assert.ok(r.expected <= r.bound);
});

test("la cifra de 02-11m (8 caracteres) estaba subestimada: con 10 000 IP y 1 año la cota es ~0.48 %, no < 0.1 %", () => {
  const r = risk({ ...P, length: 8 }, 10_000, YEAR);
  assert.ok(r.bound > 1e-3, fmt(r.bound));
});

test("el cierre publica exactamente las cifras que da el cálculo (no otras)", () => {
  const doc = fs.readFileSync("CIERRE-02-11C.md", "utf8");
  const sec = doc.slice(doc.indexOf("## 02-11n"));
  assert.ok(sec.length > 100, "falta la sección 02-11n");
  for (const K of [1_000, 10_000, 100_000]) {
    const r = risk(P, K, YEAR);
    assert.ok(sec.includes(`| ${K.toLocaleString("en-US")} | ${fmt(r.bound)} | ${fmt(r.expected)} |`), `fila K=${K}: ${fmt(r.bound)} / ${fmt(r.expected)}`);
  }
  // the wrong 02-11m statement is marked as corrected, not repeated as valid
  assert.match(sec, /subestimad/);
});

test("02-11o: el cierre publica el costo real de agotar el cupo de una hora (redes, IP, trabajo del desafío)", () => {
  const X = exhaustion(P);
  assert.ok(X.networks >= 70 && X.ips >= 90, JSON.stringify(X));
  const doc = fs.readFileSync("CIERRE-02-11C.md", "utf8");
  const sec = doc.slice(doc.indexOf("## 02-11o"));
  assert.ok(sec.includes(`${X.codes} códigos, ≥${X.networks} redes, ≥${X.ips} IP, ~${X.hashes.toExponential(2)} hashes`), "cifras de agotamiento en el cierre");
});

test("02-11p: las cifras de agotamiento se comprueban simulando al atacante contra el almacén real (no se copian)", async () => {
  const { createVerifyStore } = await import("../src/services/verifyStore.js");
  const { solve } = await import("./fixtures/pow.mjs");
  // same limits as production; only the challenge difficulty is lowered so the test is fast — the tier of
  // every request (none / first / second difficulty) is what is measured, then priced with the REAL bits
  const s = createVerifyStore({ secret: Buffer.from("sim"), env: { VERIFY_POW_BITS_1: "1", VERIFY_POW_BITS_2: "2" } });
  const t = Date.parse("2026-11-04T08:00:00Z");
  const tiers = { 0: 0, 1: 0, 2: 0 };
  const nets = new Set();
  const ips = new Set();
  let i = 0;
  const ask = (ip) => {
    const email = `sim${i++}@cliente-ficticio.test`;
    let r = s.start(email, ip, t + i);
    let tier = 0;
    if (!r.ok && r.reason === "challenge") {
      tier = r.bits;
      const c = s.challenge(email, ip, r.bits, t + i);
      r = s.start(email, ip, t + i, { pow: { challenge: c, nonce: solve(c, r.bits) } });
    }
    if (r.ok) {
      tiers[tier]++;
      nets.add(ip.split(".").slice(0, 3).join("."));
      ips.add(ip);
    }
    return r.ok;
  };
  // main budget: networks of 3 IPs × 10 codes (per-IP and per-network limits), until a network gets nothing
  for (let net = 0; net < 50; net++) {
    let got = 0;
    for (let ipn = 0; ipn < 5; ipn++) for (let k = 0; k < 10; k++) if (ask(`10.${net}.0.${ipn}`)) got++;
    if (!got) break;
  }
  // reserve: fresh networks, one IP each, until refused
  for (let net = 0; net < 200; net++) if (!ask(`11.${net}.0.1`)) break;
  const X = exhaustion(P);
  assert.equal(tiers[0] + tiers[1] + tiers[2], X.codes, JSON.stringify(tiers));
  assert.equal(nets.size, X.networks);
  assert.equal(ips.size, X.ips);
  const hashes = tiers[1] * 2 ** P.powBits[0] + tiers[2] * 2 ** P.powBits[1];
  assert.equal(hashes, X.hashes, `simulado ${hashes} vs script ${X.hashes}`);
});

test("02-11p: el script funciona como comando y lee los parámetros del código", async () => {
  const { execFileSync } = await import("node:child_process");
  const out = execFileSync(process.execPath, ["scripts/riesgo-codigos.mjs"], { encoding: "utf8" });
  const X = exhaustion(P);
  assert.match(out, new RegExp(`Agotar el cupo de una hora: ${X.codes} códigos, ≥${X.networks} redes, ≥${X.ips} IP`));
  assert.match(out, /longitud 10 · K=10000 IP · 1 año: .*cota=4\.67e-6/);
  // every parameter the formulas use comes from codeRiskParams (one source of truth)
  for (const k of ["alphabet", "length", "codeMinutes", "maxCodesPerHour", "failsPerIpHour", "globalHour", "reserveHour", "perNetworkHour", "perIpHour", "powAt", "powBits"]) assert.ok(k in P, k);
});
