// Security checks on the real server (local, Resend replaced): injection, escaping,
// signed links, CORS, body limits, rate limits, forged Host header.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-sec-"));
const MAIL_LOG = path.join(dir, "mails.jsonl");
// 4045 is one of the ports fetch() refuses ("bad port", WHATWG Fetch §2.10): it made this file fail
// about once in 90 runs with "fetch failed". It is skipped.
const PORT = ((p) => (p === 4045 ? 4046 : p))(4000 + Math.floor(Math.random() * 90));
const BASE = `http://127.0.0.1:${PORT}`;
let srv;
before(async () => {
  srv = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ["--import", path.resolve("test/fake-resend.mjs"), "src/index.js"], {
      env: { ...process.env, PORT: String(PORT), DATA_DIR: dir, MAIL_LOG, RESEND_API_KEY: "re_test", LEADS_EMAIL: "ventas@seal.com.gt", ADMIN_EMAIL: "", ADMIN2_EMAIL: "", PUBLIC_API_URL: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    p.stdout.on("data", (d) => String(d).includes("running at") && resolve(p));
    p.on("exit", (c) => reject(new Error(`server exited ${c}`)));
  });
});
after(async () => {
  srv.removeAllListeners("exit");
  // the server saves the registry on SIGTERM: wait for it before removing the folder
  await new Promise((r) => { srv.on("exit", r); srv.kill("SIGTERM"); });
  fs.rmSync(dir, { recursive: true, force: true });
});
const mails = () => (fs.existsSync(MAIL_LOG) ? fs.readFileSync(MAIL_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
let ipN = 0;
const post = (p, body, headers = {}) => fetch(BASE + p, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.9.0.${++ipN}`, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
const XSS = `<img src=x onerror=alert(1)><script>alert("x")</script>"'`;

let caseUrl;
test("HTML and script in every field are escaped in SEAL's email and in the case page", async () => {
  const r = await post("/api/email/quote", { name: `Ana ${XSS}`, email: "ana@empresa.gt", product: `Termos ${XSS}`, message: XSS, supplierName: XSS, price: XSS, assumptions: [XSS], warnings: [XSS], chat: [XSS], requestType: XSS });
  assert.equal(r.status, 200);
  const j = await r.json();
  caseUrl = new URL(j.caseUrl);
  const html = mails().at(-1).html;
  assert.doesNotMatch(html, /<img src=x|<script>/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const page = await (await fetch(BASE + caseUrl.pathname + caseUrl.search)).text();
  assert.doesNotMatch(page, /<img src=x|<script>/);
});

test("line breaks in the name never reach the subject (no header injection)", async () => {
  await post("/api/email/quote", { name: "Ana\r\nBcc: victim@example.com", email: "ana2@empresa.gt", product: "Sillas\r\nX-Test: 1" });
  const m = mails().at(-1);
  assert.doesNotMatch(m.subject, /[\r\n]/);
  assert.equal(m.bcc, undefined);
});

// Replaced 2026-10-29 (cierre 29-b): this test used to accept { product: {…}, assumptions: "no-array",
// chat: [{…}] } with 200 and register the case WITHOUT the product (the object was dropped silently).
// The requirement is stricter: a malformed request is rejected before it is registered or emailed.
// The check below is equivalent in coverage (same malformed shapes) and stronger in effect.
test("objects or arrays where text is expected are rejected: nothing registered or emailed", async () => {
  assert.equal((await post("/api/email/quote", { name: { $gt: "" }, email: "ana@empresa.gt" })).status, 400);
  assert.equal((await post("/api/email/quote", { name: "Ana", email: ["ana@empresa.gt"] })).status, 400);
  const before = mails().length;
  for (const body of [
    { name: "Ana", email: "ana3@empresa.gt", product: { toString: 1 } },
    { name: "Ana", email: "ana3@empresa.gt", product: "Sillas", assumptions: "no-array" },
    { name: "Ana", email: "ana3@empresa.gt", product: "Sillas", chat: [{ a: 1 }, "texto"] },
    { name: "Ana", email: "ana3@empresa.gt", product: "Sillas", quantity: { n: 4 } },
    { name: "Ana", email: "ana3@empresa.gt", product: "Sillas", quantity: [4] },
    { name: "Ana", email: "ana3@empresa.gt", product: "Sillas", budget: { usd: 5000 } },
    { name: "Ana", email: "ana3@empresa.gt", product: "Sillas", budget: "5e3" },
    { name: "Ana", email: "ana3@empresa.gt", product: "Sillas", budget: "cinco mil" },
  ]) {
    const r = await post("/api/email/quote", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(mails().length, before);
  // the same request well formed is accepted
  const ok = await post("/api/email/quote", { name: "Ana", email: "ana3@empresa.gt", product: "Sillas", chat: ["texto"] });
  assert.equal(ok.status, 200);
});

test("bad JSON and oversized bodies are refused without details", async () => {
  const bad = await post("/api/email/quote", "{not json");
  assert.equal(bad.status, 400);
  assert.deepEqual(await bad.json(), { error: "Invalid JSON body" });
  const big = await post("/api/email/quote", { name: "A", email: "a@b.gt", message: "x".repeat(300_000) });
  assert.equal(big.status, 413);
});

test("signed links: wrong, truncated or another case's token → 404; pages carry protective headers", async () => {
  const p = caseUrl.pathname;
  const t = caseUrl.searchParams.get("t");
  for (const bad of ["", "x", t.slice(0, -1), t.slice(0, -1) + (t.at(-1) === "A" ? "B" : "A"), "a".repeat(t.length)])
    assert.equal((await fetch(`${BASE}${p}?t=${encodeURIComponent(bad)}`)).status, 404, bad);
  const other = new URL((await (await post("/api/email/quote", { name: "Eva", email: "eva@empresa.gt", product: "Otro" })).json()).caseUrl);
  assert.equal((await fetch(`${BASE}${p}?t=${other.searchParams.get("t")}`)).status, 404);
  const ok = await fetch(`${BASE}${p}?t=${t}`);
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-security-policy"), /default-src 'none'/);
  assert.equal(ok.headers.get("x-frame-options"), "DENY");
  assert.equal(ok.headers.get("referrer-policy"), "no-referrer");
  assert.equal(ok.headers.get("cache-control"), "no-store");
  assert.equal(ok.headers.get("x-powered-by"), null);
  // a follow-up page can't be opened with the client's case token
  assert.equal((await fetch(`${BASE}/api/leads/act/${encodeURIComponent(p.split("/").pop())}?s=cliente&t=${t}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/leads/funnel?t=${t}`)).status, 404);
});

test("CORS: only SEAL's site may call the API from a browser", async () => {
  const evil = await fetch(BASE + "/api/events", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  const good = await fetch(BASE + "/api/events", { method: "OPTIONS", headers: { origin: "https://seal-ai.sealcargo.com.gt", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
  assert.equal(good.headers.get("access-control-allow-origin"), "https://seal-ai.sealcargo.com.gt");
});

test("a forged Host header can't put another site in SEAL's email buttons", async () => {
  // Node's fetch won't forge Host: use a raw request
  const net = await import("node:net");
  const body = JSON.stringify({ name: "Host Test", email: "host@empresa.gt", product: "Host" });
  await new Promise((resolve) => {
    const sock = net.connect(PORT, "127.0.0.1", () => {
      sock.write(`POST /api/email/quote HTTP/1.1\r\nHost: evil.example\r\nContent-Type: application/json\r\nX-Real-IP: 10.9.9.9\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
    });
    sock.on("data", () => {});
    sock.on("end", resolve);
  });
  const html = mails().at(-1).html;
  assert.doesNotMatch(html, /evil\.example/);
  assert.match(html, /https:\/\/sealcargoai-backend-production\.up\.railway\.app\/api\/leads\/act\//);
});

test("rate limits: requests to SEAL and funnel events from one connection are capped", async () => {
  const ip = "10.77.0.1";
  let last;
  for (let i = 0; i < 11; i++) last = await post("/api/email/quote", { name: "Rate", email: `rate${i}@empresa.gt`, product: `P${i}` }, { "x-real-ip": ip });
  assert.equal(last.status, 429);
  let ev;
  for (let i = 0; i < 121; i++) ev = await post("/api/events", { event: "visita", vid: `vid-rate-${i}-xxxx` }, { "x-real-ip": "10.77.0.2" });
  assert.equal(ev.status, 429);
});

test("parallel identical sends make one case and one email (no race duplicates)", async () => {
  const before = mails().length;
  const rs = await Promise.all(Array.from({ length: 8 }, (_, i) => post("/api/email/quote", { name: "Par", email: "par@empresa.gt", product: "Paralelo" }, { "x-real-ip": `10.88.0.${i + 1}` })));
  const ids = new Set(await Promise.all(rs.map(async (r) => (await r.json()).id)));
  assert.equal(ids.size, 1);
  assert.equal(mails().length, before + 1);
});
