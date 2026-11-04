// 02-11s — Proveedores: contradicciones explícitas fuera antes de ordenar, en todo el recorrido de búsqueda
// (descripción original → palabra clave → plataforma simulada → filtro → respuesta). Datos ficticios; nada sale.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { server } from "./fixtures/qa-server.mjs";
import { contradiction, gateBySpecs, constrainKeyword } from "../src/services/specGate.js";

test("1 · los tres falsos positivos se detectan; las coincidencias válidas no", () => {
  const bad = [
    ["Guantes desechables sin látex", "Latex disposable gloves"],
    ["Compresor industrial de tornillo 220 V", "Industrial screw compressor 380V"],
    ["Botas con puntera compuesta", "Steel toe safety boots"],
  ];
  for (const [d, t] of bad) assert.notEqual(contradiction(d, t), "", `${d} / ${t}`);
  const good = [
    ["Guantes desechables sin látex", "Disposable nitrile gloves latex free powder free"],
    ["Guantes desechables sin látex", "Latex-free examination gloves"],
    ["Guantes desechables sin látex", "Non-latex disposable gloves"],
    ["Guantes desechables sin látex", "Disposable gloves"], // nothing said: the page shows it as «por confirmar»
    ["Compresor industrial de tornillo 220 V", "Screw air compressor 220V/380V 60Hz"], // an option is 220 V
    ["Compresor industrial de tornillo 220 V", "Screw air compressor 220-240V"],
    ["Compresor industrial de tornillo 220 V", "Screw air compressor"],
    ["Botas con puntera compuesta", "Composite toe safety boots"],
    ["Botas con puntera compuesta", "Safety boots"],
    ["Repuestos para compresor de tornillo", "Spare parts for screw compressor"], // the client asked for parts
  ];
  for (const [d, t] of good) assert.equal(contradiction(d, t), "", `${d} / ${t}`);
});

test("2 · negaciones ES/EN, fase y accesorios", () => {
  assert.notEqual(contradiction("Disposable gloves, latex-free", "Powder free latex gloves"), "");
  assert.notEqual(contradiction("Compresor de tornillo, no 380 V", "Screw compressor 380V"), "");
  assert.notEqual(contradiction("Screw compressor 220V, not 380V", "Screw compressor 380V"), "");
  assert.equal(contradiction("Compresor de tornillo, no 380 V", "Screw compressor 220V/380V"), "");
  assert.notEqual(contradiction("Compresor 220V trifásico", "single phase 220v compressor"), "");
  assert.notEqual(contradiction("Botas con puntera compuesta", "Composite toe cap for safety shoes"), "");
});

test("3 · la palabra clave conserva los requisitos y no pide lo excluido", () => {
  assert.deepEqual(constrainKeyword("latex gloves", "Guantes desechables sin látex"), { searchKeyword: "gloves latex free", relevanceKeyword: "gloves" });
  assert.equal(constrainKeyword("screw air compressor", "Compresor industrial de tornillo 220 V").searchKeyword, "screw air compressor 220v");
  assert.equal(constrainKeyword("safety boots", "Botas con puntera compuesta").searchKeyword, "safety boots composite toe");
  const g = gateBySpecs(Object.assign(["Latex gloves", "Nitrile gloves latex free"].map((productName) => ({ productName })), { offerCount: 2 }), "guantes sin látex");
  assert.deepEqual([g.length, g.offerCount, g.specExcluded], [1, 2, 1]);
});

// ── the whole server path, with the platform simulated ────────────────────────
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-spec-"));
const KW = path.join(dir, "kw.jsonl");
const servers = [];
after(async () => {
  for (const s of servers) await s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function search(offers, userQuery, port) {
  const S = server(port, { STUB_OFFERS: JSON.stringify(offers), STUB_KW_LOG: KW, GROQ_API_KEY: "" });
  servers.push(S);
  await S.start();
  const r = await S.post("/api/suppliers/search", { productType: "other", userQuery, quantity: "100" }, "10.130.0.1");
  return { status: r.status, j: await r.json(), S };
}

test("4 · servidor: «guantes sin látex» — el de látex no llega a la respuesta; la palabra clave no pide látex", async () => {
  const { j } = await search(["Latex disposable gloves", "Disposable nitrile gloves latex free", "Disposable gloves"], "Guantes desechables sin látex", 12300);
  const names = j.topSuppliers.map((s) => s.productName);
  assert.ok(!names.some((n) => /^latex disposable/i.test(n)), JSON.stringify(names));
  assert.equal(names.length, 2);
  assert.equal(j.specExcluded, 1);
  const kw = fs.readFileSync(KW, "utf8").trim().split("\n").map((l) => JSON.parse(l)).pop();
  assert.match(kw.keyword, /latex free$/);
  assert.doesNotMatch(kw.relevanceKeyword, /latex/);
});

test("5 · servidor: todas contradicen → cero recomendaciones, se dice por qué y no se cobra la búsqueda", async () => {
  const { j } = await search(["Industrial screw compressor 380V", "Screw air compressor 380V 3 phase"], "Compresor industrial de tornillo 220 V", 12500);
  assert.deepEqual(j.topSuppliers, []);
  assert.equal(j.noRelevantMatches, true);
  assert.equal(j.specExcluded, 2);
  assert.match(j.specReasons[0].es, /380 V; solicitaste 220 V/);
  assert.match(j.specReasons[0].en, /380 V; you asked for 220 V/);
});

test("6 · servidor: botas — la de acero sale; la compuesta y la que no dice quedan", async () => {
  const { j } = await search(["Steel toe safety boots", "Composite toe safety boots", "Safety boots"], "Botas con puntera compuesta", 12700);
  const names = j.topSuppliers.map((s) => s.productName);
  assert.deepEqual(names.sort(), ["Composite toe safety boots", "Safety boots"]);
});
