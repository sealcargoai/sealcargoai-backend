// 02-11n — El riesgo de fuerza bruta se calcula con los parámetros reales y el cierre no puede afirmar otra
// cifra. Falla si alguien acorta el código, alarga su vigencia o sube los límites sin rehacer la cuenta.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { risk, fmt } from "../scripts/riesgo-codigos.mjs";
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
