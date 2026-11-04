// 02-11w — Cualquier voltaje (24 V, 12 V DC…), tipo de corriente AC/DC y lo que el anuncio excluye.
// Auditoría 2026-11-04: «bomba de agua 24 V» no daba veredicto frente a 12 V DC ni 220 V AC (solo se leían
// 100–690 V); «380 V compressor, not 220 V» quedaba «por confirmar»; «compresor sin aceite 220 V» tomaba
// «sin … 220 V» como exclusión y marcaba incompatible un compresor de 220 V; y la consulta perdía «24v».
// Recorrido: descripción original → «traducción» simulada → consulta enviada → plataforma simulada →
// filtro → clasificación que recibe la página. Datos ficticios; nada sale a la red.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { server } from "./fixtures/qa-server.mjs";
import { constrainKeyword, specVerdict } from "../src/services/specGate.js";
import { voltageCheck, requestedVolts } from "../src/services/voltage.js";

test("1 · los dos defectos de la auditoría y el falso negativo «sin aceite»", () => {
  assert.equal(specVerdict("bomba de agua 24 V", "12V DC water pump").verdict, "incompatible");
  assert.equal(specVerdict("bomba de agua 24 V", "220V AC water pump").verdict, "incompatible");
  assert.equal(specVerdict("bomba de agua 24 V", "24V DC water pump").verdict, "match");
  assert.deepEqual(voltageCheck("compresor de tornillo 220 V", "380 V compressor, not 220 V"), {
    verdict: "incompatible",
    es: "Esta publicación indica 380 V y excluye 220 V; solicitaste 220 V",
    en: "This listing states 380 V and rules out 220 V; you asked for 220 V",
  });
  assert.equal(specVerdict("compresor sin aceite 220 V", "Oil free compressor 220V").verdict, "match");
  assert.equal(specVerdict("oil-free compressor 220V, no oil", "Oil free silent compressor 220V").verdict, "match");
});

test("2 · un pedido sin AC/DC no inventa el tipo; uno con tipo lo exige", () => {
  assert.deepEqual(requestedVolts("bomba de agua 24 V").list, [{ v: 24, cur: "" }]);
  for (const d of ["bomba 24VDC", "bomba 24 V CC", "bomba 24 V DC", "bomba DC 24V", "bomba de 24 voltios de corriente continua", "pump 24 Vdc"])
    assert.deepEqual(requestedVolts(d).list, [{ v: 24, cur: "dc" }], d);
  for (const d of ["bomba 24 VCA", "bomba 24 V AC", "bomba 24VAC", "bomba AC 24V"]) assert.deepEqual(requestedVolts(d).list, [{ v: 24, cur: "ac" }], d);
  assert.equal(voltageCheck("bomba de agua 24 V", "Water pump 24V AC").verdict, "match");
  assert.equal(voltageCheck("bomba de agua 24 V", "Water pump 24V AC").es, "Indica la alimentación pedida: 24 V");
  assert.equal(voltageCheck("bomba de agua 24 V DC", "Water pump 24V").verdict, "confirm");
});

test("3 · Hz, W, kW, VA, Ah y mAh no son voltaje; ninguna cifra se lee dentro de otra", () => {
  for (const t of ["Water pump 24W", "Water pump 24Hz", "Water pump 2.4kW", "Water pump 24 kV", "UPS 2400VA", "Battery 24Ah", "Battery 2400mAh", "Pump 1024V"])
    assert.notEqual(voltageCheck("bomba de agua 24 V", t)?.verdict, "match", t);
  assert.equal(voltageCheck("bomba de agua 24 V", "Pump 1024V").verdict, "incompatible", "1024 V is not 24 V");
});

test("4 · la traducción no inventa voltaje ni tipo de corriente; el pedido original se conserva", () => {
  const d = "bomba de agua 24 V DC";
  assert.equal(constrainKeyword("water pump 12v ac", d).searchKeyword, "water pump 24v dc");
  assert.equal(constrainKeyword("water pump", d).searchKeyword, "water pump 24v dc");
  assert.equal(constrainKeyword("water pump 24v", d).searchKeyword, "water pump 24v dc");
  assert.equal(constrainKeyword("water pump 24v dc", d).searchKeyword, "water pump 24v dc");
  // no type asked: none added, an invented one taken out
  assert.equal(constrainKeyword("dc water pump 24v dc", "bomba de agua 24 V").searchKeyword, "water pump 24v");
  assert.equal(constrainKeyword("water pump 220v", "bomba de agua 24 V").searchKeyword, "water pump 24v");
  // nothing electric asked: nothing electric added
  assert.equal(constrainKeyword("water pump 24v dc", "bomba de agua para jardín").searchKeyword, "water pump");
  // «sin aceite 220 V» keeps its 220 V
  assert.equal(constrainKeyword("oil free compressor", "compresor sin aceite 220 V").searchKeyword, "oil free compressor 220v");
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-volt-w-"));
const servers = [];
after(async () => {
  for (const s of servers) await s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function run(port, { offers, kwLog, desc, fake, short }) {
  const S = server(port, { STUB_OFFERS: JSON.stringify(offers), STUB_KW_LOG: kwLog, GROQ_API_KEY: "fake-key", FAKE_GROQ_KEYWORD: fake, FAKE_GROQ_SHORT: short || "pump 12v" });
  servers.push(S);
  await S.start();
  const r = await S.post("/api/suppliers/search", { productType: "machinery", userQuery: desc, quantity: "4" }, "10.141.0.1");
  return r.json();
}

test("5 · servidor: 24 V DC con traducción «12v ac» → consulta 24v dc; incompatibles fuera, ausentes «por confirmar»", async () => {
  const KW = path.join(dir, "kw-24.jsonl");
  const j = await run(13500, {
    desc: "bomba de agua sumergible 24 V DC",
    fake: "submersible water pump 12v ac",
    kwLog: KW,
    offers: [
      "Submersible water pump 24V DC brushless",
      "Submersible water pump 12V DC",
      "Submersible water pump 220V AC",
      "Submersible water pump 24V AC",
      "Submersible water pump 48V DC",
      "Submersible water pump 24V",
      "Submersible water pump",
      "Submersible water pump 12V/24V DC",
    ],
  });
  const asked = fs.readFileSync(KW, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const k of asked) {
    assert.doesNotMatch(`${k.keyword} ${k.relevanceKeyword}`, /12v|\bac\b|220/, JSON.stringify(k));
    assert.match(k.keyword, /24v dc/);
  }
  const shown = Object.fromEntries(j.topSuppliers.map((s) => [s.productName, [s.specVerdict.verdict, s.specVerdict.notes[0]?.es || ""]]));
  assert.deepEqual(shown, {
    "Submersible water pump 24V DC brushless": ["match", ""],
    "Submersible water pump 24V": ["confirm", "Tipo de corriente por confirmar: el título indica 24 V sin decir si es AC o DC; pediste 24 V DC"],
    "Submersible water pump": ["confirm", "Voltaje del equipo por confirmar; pediste 24 V DC"],
    "Submersible water pump 12V/24V DC": ["confirm", "Confirma que te coticen la variante de 24 V DC (el título ofrece 12 V DC / 24 V DC)"],
  });
  assert.equal(j.specExcluded, 4);
  const why = j.specReasons.map((r) => r.es);
  for (const w of ["Esta publicación indica 12 V DC; solicitaste 24 V DC", "Esta publicación indica 220 V AC; solicitaste 24 V DC", "Esta publicación indica 24 V AC; solicitaste 24 V DC", "Esta publicación indica 48 V DC; solicitaste 24 V DC"])
    assert.ok(why.includes(w), w);
});

test("6 · servidor: 220 V — «380 V, not 220 V» queda fuera; «sin aceite 220 V» se recomienda", async () => {
  const KW = path.join(dir, "kw-220.jsonl");
  const j = await run(13700, {
    desc: "compresor de tornillo sin aceite 220 V",
    fake: "oil free screw compressor 380v",
    kwLog: KW,
    offers: ["Oil free screw compressor 380 V, not 220 V", "Oil free screw compressor 220V", "Oil free screw compressor 380V, control panel 220V", "Oil free screw compressor 220V/380V optional"],
  });
  const asked = fs.readFileSync(KW, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const k of asked) assert.doesNotMatch(k.keyword, /380/, JSON.stringify(k));
  const shown = Object.fromEntries(j.topSuppliers.map((s) => [s.productName, s.specVerdict.verdict]));
  assert.deepEqual(shown, { "Oil free screw compressor 220V": "match", "Oil free screw compressor 220V/380V optional": "confirm" });
  assert.equal(j.specExcluded, 2);
  assert.ok(j.specReasons.some((r) => r.es === "Esta publicación indica 380 V y excluye 220 V; solicitaste 220 V"));
});

test("7 · servidor: el reintento corto («pump 12v») tampoco cambia el pedido de 24 V", async () => {
  const KW = path.join(dir, "kw-retry.jsonl");
  const j = await run(13900, { desc: "bomba de agua 24 V", fake: "water pump 12v", short: "pump 12v", kwLog: KW, offers: ["Water pump 12V DC", "Water pump 220V AC"] });
  const asked = fs.readFileSync(KW, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(asked.length, 2, "first search and the shorter retry");
  assert.deepEqual(asked.map((k) => k.keyword), ["water pump 24v", "pump 24v"]);
  assert.deepEqual(j.topSuppliers, []);
  assert.equal(j.noRelevantMatches, true);
});

test("8 · paridad con la página: 18 pedidos × 60 títulos difíciles (mismo archivo en el frontend)", () => {
  const p = JSON.parse(fs.readFileSync(new URL("./fixtures/voltage-parity.json", import.meta.url), "utf8"));
  let i = 0;
  for (const d of p.descriptions) for (const t of p.titles) assert.deepEqual(voltageCheck(d, t), p.results[i++], `${d} / ${t}`);
  assert.equal(i, 1080);
});
