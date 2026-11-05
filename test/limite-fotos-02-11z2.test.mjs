// 02-11z2 — Revisión del tope diario de fotos: volumen ausente, disco lleno/sin permiso, bloqueo viejo con
// varios procesos, reloj adelantado de otra instancia y zona horaria. Imágenes ficticias, Groq simulado.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { server } from "./fixtures/qa-server.mjs";
import { reserveVision, visionUsage, takeOverForTests } from "../src/services/visionStore.js";

const JPG = `data:image/jpeg;base64,${fs.readFileSync(new URL("./fixtures/foto-producto.jpg", import.meta.url)).toString("base64")}`;
const PUMP = JSON.stringify({ isProduct: true, productEs: "bomba de agua", productEn: "water pump", visibleSpecs: [], confidence: "high" });
const root = fs.mkdtempSync(path.join(os.tmpdir(), "seal-z2-"));
const servers = [];
after(async () => {
  for (const s of servers) if (s.proc && s.proc.exitCode === null) await s.stop().catch(() => {});
  fs.rmSync(root, { recursive: true, force: true });
});
const fresh = (name) => fs.mkdtempSync(path.join(root, `${name}-`));
const groqCalls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length : 0);
const NOW = Date.parse("2026-11-05T15:00:00Z");
function inDir(dir, fn) {
  process.env.VISION_DATA_DIR = dir;
  try {
    return fn();
  } finally {
    delete process.env.VISION_DATA_DIR;
  }
}
const state = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "vision-usage.json"), "utf8"));
const leftovers = (dir) => fs.readdirSync(dir).filter((f) => f !== "vision-usage.json");

test("1 · en Railway, una carpeta fuera del volumen (o sin volumen) no se usa: falla cerrado y /health lo dice", async () => {
  const vol = fresh("volumen");
  const LOG = path.join(root, "groq-volumen.jsonl");
  const cases = [
    ["fuera del volumen", { RAILWAY_PROJECT_ID: "p-ficticio", RAILWAY_VOLUME_MOUNT_PATH: vol, DATA_DIR: fresh("efimero") }],
    ["sin volumen", { RAILWAY_PROJECT_ID: "p-ficticio", RAILWAY_VOLUME_MOUNT_PATH: "", DATA_DIR: path.join(root, "data-no-montado") }],
  ];
  let port = 18600;
  for (const [name, env] of cases) {
    const S = server(port, { GROQ_API_KEY: "fake-key", FAKE_GROQ_VISION: PUMP, FAKE_GROQ_LOG: LOG, ...env });
    servers.push(S);
    await S.start();
    const r = await S.post("/api/suppliers/image-analyze", { image: JPG }, `10.170.${port % 255}.1`).then((x) => x.json());
    assert.deepEqual(r, { unavailable: true, reason: "limit_unavailable" }, name);
    const h = await fetch(`${S.BASE}/health`).then((x) => x.json());
    assert.deepEqual([h.vision.store, h.vision.usedToday], ["not-on-volume", null], name);
    assert.notEqual(h.storage.visionDir, "on-volume", name);
    assert.ok(!fs.existsSync(path.join(env.DATA_DIR, "vision-usage.json")), `${name}: nothing written on the temporary disk`);
    await S.stop();
    port += 200;
  }
  assert.equal(groqCalls(LOG), 0, "the provider was never called");
  // inside the volume it works
  const S = server(port, { GROQ_API_KEY: "fake-key", FAKE_GROQ_VISION: PUMP, FAKE_GROQ_LOG: LOG, RAILWAY_PROJECT_ID: "p-ficticio", RAILWAY_VOLUME_MOUNT_PATH: vol, DATA_DIR: path.join(vol, "datos") });
  servers.push(S);
  await S.start();
  assert.equal((await S.post("/api/suppliers/image-analyze", { image: JPG }, "10.170.9.1").then((x) => x.json())).ok, true);
  const h = await fetch(`${S.BASE}/health`).then((x) => x.json());
  assert.deepEqual([h.vision.store, h.vision.usedToday, h.storage.visionDir], ["persistent", 1, "on-volume"]);
  assert.ok(!JSON.stringify(h).includes(vol), "no paths in /health");
  assert.equal(groqCalls(LOG), 1);
});

test("2 · disco lleno o sin permiso: la reserva falla, el último conteo bueno queda y no deja archivos sueltos", () => {
  const dir = fresh("disco");
  inDir(dir, () => {
    assert.equal(reserveVision(10, NOW).used, 1);
    assert.equal(reserveVision(10, NOW).used, 2);
    const orig = { writeSync: fs.writeSync, openSync: fs.openSync };
    // (a) disk full while writing the new count
    fs.writeSync = () => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    };
    try {
      assert.throws(() => reserveVision(10, NOW), { code: "ENOSPC" });
    } finally {
      fs.writeSync = orig.writeSync;
    }
    assert.deepEqual(state(dir), { day: "2026-11-05", used: 2 }, "the last good count is intact");
    assert.deepEqual(leftovers(dir), [], "no temp file or lock left");
    // (b) no permission to create the lock
    fs.openSync = (p, ...rest) => {
      if (String(p).endsWith(".lock")) throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      return orig.openSync(p, ...rest);
    };
    try {
      assert.throws(() => reserveVision(10, NOW), { code: "EACCES" });
    } finally {
      fs.openSync = orig.openSync;
    }
    assert.deepEqual(state(dir), { day: "2026-11-05", used: 2 });
    // after the failure it continues from the good count
    assert.deepEqual(reserveVision(10, NOW), { ok: true, used: 3 });
    assert.deepEqual(leftovers(dir), []);
  });
});

test("3 · bloqueo viejo y seis procesos a la vez: solo uno lo toma, nadie pasa del tope y no quedan restos", async () => {
  for (let round = 0; round < 3; round++) {
    const DATA = fresh(`viejo-${round}`);
    const lock = path.join(DATA, "vision-usage.lock");
    fs.writeFileSync(lock, "");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
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
    assert.equal(runs.reduce((a, b) => a + b, 0), 7, `round ${round}: ${runs.join("+")}`);
    assert.equal(state(DATA).used, 7);
    assert.deepEqual(leftovers(DATA), [], "no lock or moved-aside lock left");
  }
});

test("4 · tomar un bloqueo viejo nunca borra el bloqueo nuevo de otro proceso", () => {
  const dir = fresh("toma");
  const lock = path.join(dir, "vision-usage.lock");
  fs.writeFileSync(lock, "viejo");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, old, old);
  const seen = "viejo"; // the token of the old lock this process examined
  // meanwhile another process took it over and created its own, fresh lock
  fs.rmSync(lock);
  fs.writeFileSync(lock, "nuevo");
  takeOverForTests(lock, seen);
  assert.equal(fs.readFileSync(lock, "utf8"), "nuevo", "the other process's lock is still in place");
  // same token but recent (re-created by a process that used the same text) → also put back
  fs.writeFileSync(lock, "viejo");
  takeOverForTests(lock, seen);
  assert.equal(fs.readFileSync(lock, "utf8"), "viejo");
  assert.deepEqual(fs.readdirSync(dir), ["vision-usage.lock"], "nothing moved aside is left");
  // the real old one is removed
  fs.utimesSync(lock, old, old);
  takeOverForTests(lock, seen);
  assert.ok(!fs.existsSync(lock));
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("5 · el día no retrocede: si otra instancia ya escribió el día siguiente, su conteo se respeta", () => {
  const dir = fresh("reloj");
  fs.writeFileSync(path.join(dir, "vision-usage.json"), JSON.stringify({ day: "2026-11-06", used: 3 }));
  inDir(dir, () => {
    const late = Date.parse("2026-11-05T23:59:58Z");
    assert.equal(visionUsage(late).usedToday, 3);
    assert.deepEqual(reserveVision(4, late), { ok: true, used: 4 });
    assert.deepEqual(reserveVision(4, late), { ok: false, reason: "daily_limit", used: 4 });
    assert.deepEqual(state(dir), { day: "2026-11-06", used: 4 }, "the later day was kept, not reset to 0");
  });
});

test("6 · la zona horaria del servidor no cambia el día: en Guatemala (UTC-6) el cupo reinicia a las 18:00", async () => {
  const dir = fresh("zona");
  const code = `import { reserveVision, utcDay } from ${JSON.stringify(new URL("../src/services/visionStore.js", import.meta.url).href)};
const t1 = Date.parse("2026-11-05T17:59:59-06:00"), t2 = Date.parse("2026-11-05T18:00:01-06:00");
const out = [utcDay(t1), reserveVision(1, t1).ok, reserveVision(1, t1).ok, utcDay(t2), reserveVision(1, t2).ok];
process.stdout.write(JSON.stringify(out));`;
  for (const TZ of ["America/Guatemala", "Asia/Tokyo"]) {
    fs.rmSync(path.join(dir, "vision-usage.json"), { force: true });
    const out = await new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, TZ, VISION_DATA_DIR: dir } });
      let o = "";
      p.stdout.on("data", (d) => (o += d));
      p.on("exit", (c) => (c === 0 ? resolve(JSON.parse(o)) : reject(new Error(`exit ${c}`))));
    });
    assert.deepEqual(out, ["2026-11-05", true, false, "2026-11-06", true], TZ);
  }
});
