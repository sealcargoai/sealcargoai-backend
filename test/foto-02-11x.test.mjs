// 02-11x — Foto opcional del producto: la IA SUGIERE qué producto es; no busca, no cuenta, no guarda, no envía.
// Imágenes ficticias (test/fixtures/foto-*) y Groq simulado (test/fixtures/fake-groq.mjs); nada sale a la red.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { server } from "./fixtures/qa-server.mjs";
import { parseImage, IMAGE_MAX_BYTES } from "../src/services/vision.js";

const img = (f, mime) => `data:${mime};base64,${fs.readFileSync(new URL(`./fixtures/foto-${f}`, import.meta.url)).toString("base64")}`;
const JPG = img("producto.jpg", "image/jpeg");
const PNG = img("producto.png", "image/png");
const WEBP = img("producto.webp", "image/webp");
const GIF = img("no-imagen.gif", "image/gif");

test("1 · tipo y tamaño se comprueban por los bytes reales, no por el nombre", () => {
  assert.equal(parseImage(JPG).ok, true);
  assert.equal(parseImage(PNG).ok, true);
  assert.equal(parseImage(WEBP).ok, true);
  assert.equal(parseImage(GIF).error, "image_type");
  assert.equal(parseImage(JPG.replace("image/jpeg", "image/png")).error, "image_invalid", "declared PNG, bytes are JPEG");
  assert.equal(parseImage("data:image/svg+xml;base64,PHN2Zz4=").error, "image_type");
  assert.equal(parseImage(`data:image/jpeg;base64,${Buffer.from("not an image at all").toString("base64")}`).error, "image_type");
  assert.equal(parseImage("https://example.com/x.jpg").error, "image_invalid");
  assert.equal(parseImage("").error, "image_missing");
  assert.equal(parseImage({}).error, "image_missing");
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(IMAGE_MAX_BYTES + 10)]);
  assert.equal(parseImage(`data:image/jpeg;base64,${big.toString("base64")}`).error, "image_size");
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-foto-"));
const servers = [];
after(async () => {
  for (const s of servers) await s.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});
async function start(port, env) {
  const S = server(port, { GROQ_API_KEY: "fake-key", ...env });
  servers.push(S);
  await S.start();
  return S;
}
const PUMP = JSON.stringify({ isProduct: true, productEs: "bomba de agua sumergible de acero inoxidable", productEn: "stainless submersible water pump", visibleSpecs: ["24V DC", "60W"], confidence: "high" });

test("2 · foto válida: sugiere el producto y lo impreso; la foto no se guarda, no se registra y no se envía", async () => {
  const LOG = path.join(dir, "groq.jsonl");
  const DATA = fs.mkdtempSync(path.join(dir, "data-"));
  const S = await start(14200, { FAKE_GROQ_VISION: PUMP, FAKE_GROQ_LOG: LOG, DATA_DIR: DATA });
  const r = await S.post("/api/suppliers/image-analyze", { image: JPG, description: "bomba para pozo", lang: "es" }, "10.150.0.1");
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true, isProduct: true, productEs: "bomba de agua sumergible de acero inoxidable", productEn: "stainless submersible water pump", visibleSpecs: ["24V DC", "60W"], confidence: "high" });
  const sent = fs.readFileSync(LOG, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].model, "qwen/qwen3.8-27b");
  assert.deepEqual(sent[0].response_format, { type: "json_object" });
  assert.match(sent[0].text, /bomba para pozo/);
  assert.equal(sent[0].imageBytes, JPG.length);
  // nothing persisted anywhere and no email
  const chunk = JPG.split(",")[1].slice(40, 120);
  const files = fs.readdirSync(DATA, { recursive: true }).map((f) => path.join(DATA, String(f))).filter((f) => fs.statSync(f).isFile());
  for (const f of files) assert.ok(!fs.readFileSync(f, "latin1").includes(chunk), `photo found in ${f}`);
  assert.ok(!S.logs.includes(chunk), "photo in the server log");
  assert.equal(S.mails().length, 0);
  assert.equal(S.attempts().length, 0);
  const h = await (await fetch(`${S.BASE}/health`)).json();
  assert.deepEqual([h.vision.configured, h.vision.model, h.vision.usedToday, h.vision.dailyMax], [true, "qwen/qwen3.8-27b", 1, 60]);
});

test("3 · no es un producto, Groq ocupado (429), respuesta dañada, sin clave o apagado: no se inventa nada", async () => {
  const A = await start(14400, { FAKE_GROQ_VISION: JSON.stringify({ isProduct: false, productEs: "persona sonriendo", productEn: "person", visibleSpecs: ["x"], confidence: "high" }) });
  assert.deepEqual(await (await A.post("/api/suppliers/image-analyze", { image: PNG }, "10.150.0.2")).json(), { ok: true, isProduct: false, productEs: "", productEn: "", visibleSpecs: [], confidence: "high" });
  const B = await start(14600, { FAKE_GROQ_VISION_STATUS: "429" });
  const b = await B.post("/api/suppliers/image-analyze", { image: WEBP }, "10.150.0.3");
  assert.equal(b.status, 200);
  assert.deepEqual(await b.json(), { unavailable: true, reason: "busy" });
  const C = await start(14800, { FAKE_GROQ_VISION: "no es json" });
  assert.deepEqual(await (await C.post("/api/suppliers/image-analyze", { image: JPG }, "10.150.0.4")).json(), { unavailable: true, reason: "bad_answer" });
  const D = await start(15000, { GROQ_API_KEY: "", FAKE_GROQ_VISION: PUMP });
  assert.deepEqual(await (await D.post("/api/suppliers/image-analyze", { image: JPG }, "10.150.0.5")).json(), { unavailable: true, reason: "not_configured" });
  const E = await start(15200, { VISION_DISABLED: "1", FAKE_GROQ_VISION: PUMP });
  assert.deepEqual(await (await E.post("/api/suppliers/image-analyze", { image: JPG }, "10.150.0.6")).json(), { unavailable: true, reason: "disabled" });
});

test("4 · lo que devuelve la IA se limpia: sin HTML, textos cortos, máximo 6 datos", async () => {
  const S = await start(15400, { FAKE_GROQ_VISION: JSON.stringify({ isProduct: true, productEs: `<script>alert(1)</script> bomba ${"x".repeat(300)}`, productEn: "pump", visibleSpecs: ["1", "2", "3", "4", "5", "6", "7", "1"], confidence: "segurísimo" }) });
  const j = await (await S.post("/api/suppliers/image-analyze", { image: JPG }, "10.150.0.7")).json();
  assert.doesNotMatch(j.productEs, /[<>]/);
  assert.ok(j.productEs.length <= 120);
  assert.deepEqual(j.visibleSpecs, ["1", "2", "3", "4", "5", "6"]);
  assert.equal(j.confidence, "low");
});

test("5 · tope diario (plan gratuito) y límite por conexión", async () => {
  const S = await start(15600, { FAKE_GROQ_VISION: PUMP, VISION_DAILY_MAX: "2" });
  const call = (ip) => S.post("/api/suppliers/image-analyze", { image: JPG }, ip).then((r) => r.json());
  assert.equal((await call("10.150.1.1")).ok, true);
  assert.equal((await call("10.150.1.2")).ok, true);
  assert.deepEqual(await call("10.150.1.3"), { unavailable: true, reason: "daily_limit" });
  const T = await start(15800, { FAKE_GROQ_VISION: PUMP });
  const codes = [];
  for (let i = 0; i < 11; i++) codes.push((await T.post("/api/suppliers/image-analyze", { image: JPG }, "10.150.2.1")).status);
  assert.deepEqual(codes, [...Array(10).fill(200), 429]);
});

test("6 · entradas malas: GIF, campos que no son texto, cuerpo demasiado grande; la búsqueda sigue con 200 KB", async () => {
  const S = await start(16000, { FAKE_GROQ_VISION: PUMP });
  const gif = await S.post("/api/suppliers/image-analyze", { image: GIF }, "10.150.3.1");
  assert.deepEqual([gif.status, (await gif.json()).error], [400, "image_type"]);
  const obj = await S.post("/api/suppliers/image-analyze", { image: { url: JPG } }, "10.150.3.2");
  assert.deepEqual([obj.status, (await obj.json()).error], [400, "invalid_fields"]);
  const huge = await S.post("/api/suppliers/image-analyze", { image: `data:image/jpeg;base64,${"A".repeat(2_400_000)}` }, "10.150.3.3");
  assert.equal(huge.status, 413);
  // the larger limit is only for this route
  const search = await S.post("/api/suppliers/search", { productType: "machinery", userQuery: "x".repeat(300_000) }, "10.150.3.4");
  assert.equal(search.status, 413);
});
