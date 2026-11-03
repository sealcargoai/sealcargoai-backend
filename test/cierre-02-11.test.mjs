// Cierre 02-11 (regresión): avisos de búsqueda, informe y caso dicen lo que realmente son, sin datos
// inventados ni duplicados. Servidor real en un puerto libre; Resend reemplazado (test/fake-resend.mjs);
// la búsqueda de Alibaba es un fixture ficticio (test/fixtures). Nada sale de esta máquina.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { refineKeyword } from "../src/routes/ai.js";

function server(portBase, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-0211-"));
  const MAIL_LOG = path.join(dir, "mails.jsonl");
  const s = { dir, MAIL_LOG, BASE: "", proc: null };
  const once = (PORT) =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ["--import", path.resolve("test/fixtures/stub-register.mjs"), "--import", path.resolve("test/fake-resend.mjs"), "src/index.js"], {
        env: {
          ...process.env,
          PORT: String(PORT),
          DATA_DIR: dir,
          MAIL_LOG,
          RESEND_API_KEY: "re_test",
          LEADS_EMAIL: "ventas@example.test",
          QA_LEADS_EMAIL: "qa-inbox@example.test",
          QA_NOTIFY_EMAILS: "qa-dev@example.test",
          QA_EMAILS: "qa1@prueba.test",
          ADMIN_EMAIL: "",
          ADMIN2_EMAIL: "",
          PUBLIC_API_URL: "",
          GROQ_API_KEY: "",
          EMAIL_DRY_RUN: "",
          ...extraEnv,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      p.stdout.on("data", (d) => {
        if (String(d).includes("running at")) {
          p.removeAllListeners("exit");
          resolve(p);
        }
      });
      let err = "";
      p.stderr.on("data", (d) => (err += String(d)));
      p.on("exit", (c) => reject(new Error(`server exited ${c}: ${err.slice(-300)}`)));
    });
  s.start = async () => {
    let last;
    for (let i = 0; i < 6; i++) {
      const PORT = portBase + Math.floor(Math.random() * 190);
      try {
        s.proc = await once(PORT);
        s.BASE = `http://127.0.0.1:${PORT}`;
        return;
      } catch (e) {
        last = e;
      }
    }
    throw last;
  };
  s.stop = async () => {
    await new Promise((r) => {
      s.proc.removeAllListeners("exit");
      s.proc.on("exit", r);
      s.proc.kill("SIGTERM");
    });
    fs.rmSync(dir, { recursive: true, force: true });
  };
  s.mails = () =>
    fs.existsSync(MAIL_LOG)
      ? fs
          .readFileSync(MAIL_LOG, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  s.post = (p, body, ip) => fetch(s.BASE + p, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
  return s;
}
const S = server(4700);
before(() => S.start());
after(() => S.stop());
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const SEARCH = { productType: "machinery", userQuery: "compresores industriales de tornillo 220 V, tanque de 500 litros", quantity: "4", destination: "GT", userEmail: "qa1@prueba.test" };

test("aviso de búsqueda: coincidencias (no «calificados» ni «mejor»), categoría en español, destino Guatemala, sin presupuesto inventado; repetir la misma búsqueda no duplica el aviso", async () => {
  const before0 = S.mails().length;
  const r = await S.post("/api/suppliers/search", SEARCH, "10.0.0.1");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.ok(j.topSuppliers.length >= 1);
  await wait(300);
  const m = S.mails().slice(before0);
  assert.equal(m.length, 1, "un aviso por la búsqueda");
  const t = plain(m[0].html);
  assert.doesNotMatch(t, /calificad|mejor proveedor|verificad/i);
  assert.match(t, /Coincidencias que pasaron los filtros 1/);
  assert.match(t, /no confirman existencia, identidad, capacidad, calidad, oferta vigente ni idoneidad/);
  assert.match(t, /Categoría inferida Maquinaria \/ equipo/);
  assert.doesNotMatch(t, /\bmachinery\b|\bother\b/);
  assert.match(t, /Destino Guatemala/);
  assert.doesNotMatch(t, /Presupuesto|50000/, "sin presupuesto del cliente no se muestra el valor interno de 50,000");
  assert.deepEqual(m[0].to, ["qa-inbox@example.test", "qa-dev@example.test"], "registro de prueba: solo QA");
  // the same person repeats the same search (retry / reload): no second notice
  const r2 = await S.post("/api/suppliers/search", SEARCH, "10.0.0.1");
  assert.equal(r2.status, 200);
  await wait(300);
  assert.equal(S.mails().length - before0, 1, "la repetición propia no envía otro aviso");
});

test("categoría «other» llega traducida al equipo", async () => {
  const before0 = S.mails().length;
  await S.post("/api/suppliers/search", { ...SEARCH, productType: "other", userQuery: "artículos decorativos de cerámica para jardín", budget: "800" }, "10.0.0.2");
  await wait(300);
  const t = plain(S.mails().slice(before0)[0].html);
  assert.match(t, /Categoría inferida Otro \(sin categoría\)/);
  assert.match(t, /Presupuesto \(US\$\) 800/);
});

test("aviso de consulta iniciada: conserva la descripción completa hasta 1,500 caracteres (antes se cortaba en 1,000)", async () => {
  const tail = " y el final único de la descripción: válvula QA-1500";
  const q = "compresores industriales de tornillo para taller ".repeat(40).slice(0, 1500 - tail.length) + tail;
  assert.equal(q.length, 1500);
  const before0 = S.mails().length;
  const r = await S.post("/api/email/lead", { name: "Ana Prueba", email: "qa1@prueba.test", query: q }, "10.0.0.3");
  assert.equal(r.status, 200);
  const t = S.mails().slice(before0)[0];
  assert.ok(t.html.includes("válvula QA-1500"), "el final de la descripción llega");
  assert.match(t.subject, /^\[PRUEBA\] Consulta iniciada \(aún sin solicitud\)/);
});

test("informe por correo: una estimación sin flete se dice así, sin coma suelta", async () => {
  const r0 = await S.post("/api/suppliers/search", { ...SEARCH, userEmail: "qa1@prueba.test", userQuery: "compresores de tornillo industriales 220 V tanque 500 litros" }, "10.0.0.4");
  const j = await r0.json();
  assert.ok(j.reportToken);
  const before0 = S.mails().length;
  const r = await S.post(
    "/api/email/report",
    { recipientEmail: "qa2@prueba.test", requesterEmail: "qa1@prueba.test", reportToken: j.reportToken, supplierName: "[PRUEBA] Ficticia", totalCostText: "Q64,140 (US$8,119), sin flete", lang: "es" },
    "10.0.0.4",
  );
  assert.equal(r.status, 200);
  const m = S.mails()
    .slice(before0)
    .find((x) => /Su informe SEAL/.test(x.subject));
  const t = plain(m.html);
  assert.match(t, /Costo estimado preliminar, sin flete: Q64,140 \(US\$8,119\) /);
  assert.doesNotMatch(t, /Costo total estimado|\) ,/);
  assert.match(t, /Hola:/, "sin nombre no queda «Hola » colgando");
  assert.deepEqual(m.bcc, ["qa-inbox@example.test", "qa-dev@example.test"]);
});

test("caso enviado: el costo sin flete se rotula como preliminar, sin «total»", async () => {
  const before0 = S.mails().length;
  const r = await S.post(
    "/api/email/quote",
    {
      requestType: "QA",
      source: "costos",
      name: "Ana Prueba",
      email: "qa1@prueba.test",
      product: "compresores [PRUEBA]",
      quantity: "4",
      budget: "US$5,000",
      totalCostText: "Q64,140 (US$8,119), sin flete",
      lang: "es",
    },
    "10.0.0.5",
  );
  assert.equal(r.status, 200);
  const m = S.mails().slice(before0)[0];
  const t = plain(m.html);
  assert.match(t, /Costo estimado preliminar \(sin flete\) Q64,140/);
  assert.doesNotMatch(t, /Costo total estimado/);
  assert.match(m.subject, /^\[PRUEBA\] Caso /);
  assert.deepEqual(m.to, ["qa-inbox@example.test", "qa-dev@example.test"]);
});

test("palabra clave de respaldo (sin IA): sin letras sueltas de unidades («220 V» no deja «v»)", async () => {
  const k = await refineKeyword({ userQuery: "compresores industriales de tornillo 220 V, tanque de 500 L" });
  assert.doesNotMatch(` ${k} `, / [a-z] /i);
  assert.match(k, /compresores industriales tornillo/);
});
