// 02-11t — Voltaje del equipo (no de un componente) y una traducción que cambia el pedido.
// Recorrido: descripción original → «traducción» simulada → consulta enviada → plataforma simulada →
// filtro → clasificación que recibe la página. Datos ficticios; nada sale.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { server } from "./fixtures/qa-server.mjs";
import { specVerdict, constrainKeyword } from "../src/services/specGate.js";
import { voltageCheck } from "../src/services/voltage.js";

const vectors = JSON.parse(fs.readFileSync(new URL("./fixtures/voltage-vectors.json", import.meta.url), "utf8"));

test("1 · vectores compartidos con la página: veredicto esperado y mismas palabras", () => {
  for (const v of vectors) {
    const r = specVerdict(v.d, v.t);
    assert.equal(r.verdict, v.expect, `${v.d} / ${v.t}`);
    const first = r.reasons[0] || r.toConfirm[0] || null;
    assert.deepEqual(first ? [first.es, first.en] : [null, null], [v.es, v.en], v.t);
  }
});

test("2 · Hz, W, kW, kV y mAh no se leen como voltaje", () => {
  for (const t of ["Screw compressor 220Hz", "Screw compressor 220W", "Screw compressor 220kW", "Screw compressor 220 kV", "Battery 2200mAh compressor"])
    assert.equal(voltageCheck("compresor de tornillo 220 V", t).es, "Voltaje del equipo por confirmar; pediste 220 V", t);
});

test("3 · la traducción no cambia el pedido: voltaje, fase, puntera y látex inventados salen de la consulta", () => {
  const d = "compresor industrial de tornillo de 220 V";
  assert.deepEqual(constrainKeyword("industrial compressor 380v", d), { searchKeyword: "industrial compressor 220v", relevanceKeyword: "industrial compressor" });
  assert.equal(constrainKeyword("screw compressor 380v single phase", "compresor de tornillo 220 V trifásico").searchKeyword, "screw compressor 220v");
  assert.equal(constrainKeyword("steel toe safety boots", "botas con puntera compuesta").searchKeyword, "toe safety boots composite toe");
  assert.equal(constrainKeyword("latex gloves", "guantes sin látex").searchKeyword, "gloves latex free");
  // the original is undecided («220 o 380 V»): both stay, nothing is chosen for the client
  assert.equal(constrainKeyword("screw compressor 220v 380v", "compresor de tornillo 220 o 380 V").searchKeyword, "screw compressor 220v 380v");
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-volt-"));
const servers = [];
after(async () => {
  for (const s of servers) await s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function run(port, offers, kwLog) {
  const S = server(port, { STUB_OFFERS: JSON.stringify(offers), STUB_KW_LOG: kwLog, GROQ_API_KEY: "fake-key", FAKE_GROQ_KEYWORD: "industrial compressor 380v" });
  servers.push(S);
  await S.start();
  const r = await S.post("/api/suppliers/search", { productType: "machinery", userQuery: "compresor industrial de tornillo de 220 V", quantity: "4" }, "10.140.0.1");
  return r.json();
}

test("4 · servidor: con la traducción «380v», la consulta pide 220 V y la clasificación sale bien", async () => {
  const KW = path.join(dir, "kw1.jsonl");
  const j = await run(13100, [
    "Industrial screw compressor 380 V, control panel 220 V",
    "Industrial screw compressor 380V",
    "Industrial screw compressor 220V 60Hz",
    "Industrial screw compressor 220V/380V",
    "Industrial screw compressor",
  ], KW);
  const asked = fs.readFileSync(KW, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const k of asked) {
    assert.doesNotMatch(`${k.keyword} ${k.relevanceKeyword}`, /380/, JSON.stringify(k));
    assert.match(k.keyword, /220v/);
  }
  const shown = Object.fromEntries(j.topSuppliers.map((s) => [s.productName, s.specVerdict.verdict]));
  assert.deepEqual(shown, {
    "Industrial screw compressor 220V 60Hz": "match",
    "Industrial screw compressor 220V/380V": "confirm",
    "Industrial screw compressor": "confirm",
  });
  assert.equal(j.specExcluded, 2);
  assert.ok(j.specReasons.some((r) => /380 V para el equipo \(220 V es de un componente\)/.test(r.es)));
});

test("5 · servidor: el reintento con la palabra clave corta tampoco usa el voltaje inventado", async () => {
  const KW = path.join(dir, "kw2.jsonl");
  const j = await run(13300, ["Industrial screw compressor 380V", "Screw compressor 380 V, control panel 220 V"], KW);
  const asked = fs.readFileSync(KW, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(asked.length, 2, "first search and the shorter retry");
  assert.equal(asked[1].keyword, "compressor 220v");
  for (const k of asked) assert.doesNotMatch(`${k.keyword} ${k.relevanceKeyword}`, /380/, JSON.stringify(k));
  assert.deepEqual(j.topSuppliers, []);
  assert.equal(j.noRelevantMatches, true);
});
