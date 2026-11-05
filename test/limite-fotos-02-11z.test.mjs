// 02-11z — El tope diario de análisis de fotos persiste (volumen), aguanta concurrencia y falla cerrado.
// Revisión 2026-11-05: el contador vivía en memoria; un reinicio o un despliegue lo ponía en 0.
// Imágenes ficticias y Groq simulado; nada sale a la red.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { server } from "./fixtures/qa-server.mjs";
import { reserveVision, visionUsage, utcDay } from "../src/services/visionStore.js";

const JPG = `data:image/jpeg;base64,${fs.readFileSync(new URL("./fixtures/foto-producto.jpg", import.meta.url)).toString("base64")}`;
const PUMP = JSON.stringify({ isProduct: true, productEs: "bomba de agua", productEn: "water pump", visibleSpecs: [], confidence: "high" });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "seal-limite-"));
const servers = [];
after(async () => {
  for (const s of servers) if (s.proc && s.proc.exitCode === null) await s.stop().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});
const fresh = (name) => fs.mkdtempSync(path.join(root, `${name}-`));
const groqCalls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0);
async function start(port, env) {
  const S = server(port, { GROQ_API_KEY: "fake-key", FAKE_GROQ_VISION: PUMP, ...env });
  servers.push(S);
  await S.start();
  return S;
}
const analyze = (S, ip, extra = {}) => S.post("/api/suppliers/image-analyze", { image: JPG, ...extra }, ip).then((r) => r.json());
const health = (S) => fetch(`${S.BASE}/health`).then((r) => r.json());

test("1 · el contador sobrevive al reinicio del proceso (mismo volumen)", async () => {
  const DATA = fresh("reinicio");
  const LOG = path.join(DATA, "..", "groq-reinicio.jsonl");
  const env = { DATA_DIR: DATA, VISION_DAILY_MAX: "3", FAKE_GROQ_LOG: LOG };
  const A = await start(16800, env);
  assert.equal((await analyze(A, "10.160.0.1")).ok, true);
  assert.equal((await analyze(A, "10.160.0.2")).ok, true);
  assert.deepEqual([(await health(A)).vision.usedToday, (await health(A)).vision.store], [2, "persistent"]);
  await A.stop();
  const B = await start(17000, env);
  assert.equal((await health(B)).vision.usedToday, 2, "the count came back after the restart");
  assert.equal((await analyze(B, "10.160.0.3")).ok, true);
  assert.deepEqual(await analyze(B, "10.160.0.4"), { unavailable: true, reason: "daily_limit" });
  assert.equal(groqCalls(LOG), 3, "the provider was called exactly 3 times in total");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA, "vision-usage.json"), "utf8")), { day: utcDay(), used: 3 });
});

test("2 · 25 solicitudes simultáneas con tope 5: exactamente 5 pasan y el proveedor recibe 5", async () => {
  const DATA = fresh("concurrencia");
  const LOG = path.join(DATA, "..", "groq-concurrencia.jsonl");
  const S = await start(17200, { DATA_DIR: DATA, VISION_DAILY_MAX: "5", FAKE_GROQ_LOG: LOG });
  const r = await Promise.all(Array.from({ length: 25 }, (_, i) => analyze(S, `10.161.${i}.1`)));
  assert.equal(r.filter((x) => x.ok).length, 5);
  assert.equal(r.filter((x) => x.reason === "daily_limit").length, 20);
  assert.equal(groqCalls(LOG), 5);
  assert.equal((await health(S)).vision.usedToday, 5);
});

test("3 · varios procesos sobre la misma carpeta (despliegue con dos contenedores) tampoco pasan del tope", async () => {
  const DATA = fresh("procesos");
  const worker = `import { reserveVision } from ${JSON.stringify(new URL("../src/services/visionStore.js", import.meta.url).href)};
let ok = 0; for (let i = 0; i < 10; i++) if (reserveVision(7).ok) ok++; process.stdout.write(String(ok));`;
  const runs = await Promise.all(
    Array.from({ length: 6 }, () =>
      new Promise((resolve, reject) => {
        const p = spawn(process.execPath, ["--input-type=module", "-e", worker], { env: { ...process.env, VISION_DATA_DIR: DATA } });
        let out = "";
        p.stdout.on("data", (d) => (out += d));
        p.on("exit", (c) => (c === 0 ? resolve(Number(out)) : reject(new Error(`worker exit ${c}`))));
      }),
    ),
  );
  assert.equal(runs.reduce((a, b) => a + b, 0), 7, `6 processes × 10 tries → ${runs.join("+")}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(DATA, "vision-usage.json"), "utf8")).used, 7);
  assert.ok(!fs.existsSync(path.join(DATA, "vision-usage.lock")), "no lock left behind");
});

test("4 · el cambio de día UTC reinicia el cupo (el día anterior no cuenta)", async () => {
  const DATA = fresh("dia");
  process.env.VISION_DATA_DIR = DATA;
  try {
    const d1 = Date.parse("2026-11-05T23:59:59.900Z");
    const d2 = Date.parse("2026-11-06T00:00:00.100Z");
    assert.deepEqual(reserveVision(1, d1), { ok: true, used: 1 });
    assert.deepEqual(reserveVision(1, d1), { ok: false, reason: "daily_limit", used: 1 });
    assert.equal(visionUsage(d1).usedToday, 1);
    assert.equal(visionUsage(d2).usedToday, 0, "a new UTC day starts at 0");
    assert.deepEqual(reserveVision(1, d2), { ok: true, used: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA, "vision-usage.json"), "utf8")), { day: "2026-11-06", used: 1 });
  } finally {
    delete process.env.VISION_DATA_DIR;
  }
  // server: a full count from another day does not block today
  const DATA2 = fresh("dia-servidor");
  fs.writeFileSync(path.join(DATA2, "vision-usage.json"), JSON.stringify({ day: "2026-01-01", used: 999 }));
  const S = await start(17400, { DATA_DIR: DATA2, VISION_DAILY_MAX: "2" });
  assert.equal((await health(S)).vision.usedToday, 0);
  assert.equal((await analyze(S, "10.162.0.1")).ok, true);
  assert.equal((await health(S)).vision.usedToday, 1);
});

test("5 · si el almacenamiento falla, respuesta controlada y el proveedor NO se llama", async () => {
  const blocker = path.join(root, "soy-un-archivo");
  fs.writeFileSync(blocker, "x");
  const LOG = path.join(root, "groq-falla.jsonl");
  // (a) the folder can't be created (a file is in its place)
  const A = await start(17600, { DATA_DIR: path.join(blocker, "datos"), FAKE_GROQ_LOG: LOG });
  const a = await A.post("/api/suppliers/image-analyze", { image: JPG }, "10.163.0.1");
  assert.equal(a.status, 200);
  assert.deepEqual(await a.json(), { unavailable: true, reason: "limit_unavailable" });
  assert.deepEqual([(await health(A)).vision.store, (await health(A)).vision.usedToday], ["error", null]);
  // (b) a damaged counter file
  const DATA = fresh("danado");
  fs.writeFileSync(path.join(DATA, "vision-usage.json"), "{no es json");
  const B = await start(17800, { DATA_DIR: DATA, FAKE_GROQ_LOG: LOG });
  assert.deepEqual(await analyze(B, "10.163.0.2"), { unavailable: true, reason: "limit_unavailable" });
  // (c) the lock is held (fresh) by someone else: after ~2 s it gives up, without calling the provider
  const DATA3 = fresh("bloqueo");
  fs.writeFileSync(path.join(DATA3, "vision-usage.lock"), "");
  const C = await start(18000, { DATA_DIR: DATA3, FAKE_GROQ_LOG: LOG });
  const t0 = Date.now();
  assert.deepEqual(await analyze(C, "10.163.0.3"), { unavailable: true, reason: "limit_unavailable" });
  assert.ok(Date.now() - t0 < 6000);
  assert.equal(groqCalls(LOG), 0, "the provider was never called");
  assert.match(A.logs, /daily counter could not be read or written/);
  // (d) an old lock (crashed process, > 10 s) is taken over
  const DATA4 = fresh("bloqueo-viejo");
  const lock = path.join(DATA4, "vision-usage.lock");
  fs.writeFileSync(lock, "");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  process.env.VISION_DATA_DIR = DATA4;
  try {
    assert.equal(reserveVision(3).ok, true);
  } finally {
    delete process.env.VISION_DATA_DIR;
  }
});

test("6 · /health muestra solo conteos (sin IP, correo, descripción ni foto)", async () => {
  const DATA = fresh("health");
  const S = await start(18200, { DATA_DIR: DATA, VISION_DAILY_MAX: "4" });
  await analyze(S, "10.164.7.7", { description: "DESCRIPCION-FICTICIA-QX9 contacto qa.ficticio@prueba.test" });
  const h = await health(S);
  assert.deepEqual(Object.keys(h.vision).sort(), ["configured", "dailyMax", "model", "store", "usedToday"]);
  assert.deepEqual([h.vision.usedToday, h.vision.dailyMax, h.vision.store], [1, 4, "persistent"]);
  const all = JSON.stringify(h);
  for (const leak of ["10.164.7.7", "QX9", "qa.ficticio", JPG.split(",")[1].slice(40, 100)]) assert.ok(!all.includes(leak), leak);
});

test("7 · registros y respuestas: nunca la foto, el base64, la descripción ni un correo (aunque el proveedor los repita)", async () => {
  const DATA = fresh("privacidad");
  const S = await start(18400, { DATA_DIR: DATA, FAKE_GROQ_VISION_STATUS: "400", FAKE_GROQ_ERROR_ECHO: "1" });
  const desc = "bomba ficticia DESCRIPCION-SENTINELA-77 escribir a cliente.ficticio@prueba.test";
  const r = await S.post("/api/suppliers/image-analyze", { image: JPG, description: desc }, "10.165.0.1");
  const body = await r.text();
  assert.deepEqual(JSON.parse(body), { unavailable: true, reason: "error" });
  const chunk = JPG.split(",")[1].slice(40, 100);
  for (const leak of [chunk, "SENTINELA-77", "cliente.ficticio@prueba.test"]) {
    assert.ok(!S.logs.includes(leak), `log contains ${leak}`);
    assert.ok(!body.includes(leak), `response contains ${leak}`);
  }
  assert.match(S.logs, /Photo analysis unavailable \(400\)/);
  // a bad request answers with the field name only, never its content
  const bad = await (await S.post("/api/suppliers/image-analyze", { image: { secreto: "QX-SECRETO" }, description: desc }, "10.165.0.2")).text();
  assert.ok(!bad.includes("QX-SECRETO") && !bad.includes("SENTINELA-77"), bad);
});
