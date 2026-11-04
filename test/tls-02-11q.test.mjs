// 02-11q — NODE_TLS_REJECT_UNAUTHORIZED=0 (set in production) must not switch off certificate checks.
// A local HTTPS server with a self-signed certificate plays the man in the middle. Nothing leaves this machine.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { server } from "./fixtures/qa-server.mjs";

const run = promisify(execFile);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "seal-tls-"));
execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(dir, "k.pem"), "-out", path.join(dir, "c.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
const srv = https.createServer({ key: fs.readFileSync(path.join(dir, "k.pem")), cert: fs.readFileSync(path.join(dir, "c.pem")) }, (_q, r) => r.end("secreto"));
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const URL_ = `https://127.0.0.1:${srv.address().port}/`;
const S = server(12100, { NODE_TLS_REJECT_UNAUTHORIZED: "0" });
after(async () => {
  srv.close();
  if (S.proc) await S.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

// the same start sequence as src/index.js, then one fetch to the impostor
const probe = (env) =>
  run(process.execPath, ["--input-type=module", "-e", `import { guardTls } from "./src/tlsGuard.js"; guardTls(); try { const r = await fetch(${JSON.stringify(URL_)}); console.log("OPEN " + (await r.text())); } catch (e) { console.log("REFUSED " + (e.cause?.code || e.message)); }`], { env: { ...process.env, ...env } }).then((r) => r.stdout.trim());

test("1 · con NODE_TLS_REJECT_UNAUTHORIZED=0 el servidor igual rechaza un certificado falso", async () => {
  assert.match(await probe({ NODE_TLS_REJECT_UNAUTHORIZED: "0" }), /^REFUSED .*SELF_SIGNED/);
});

test("2 · la prueba detectaría el fallo: sin la protección (ALLOW_INSECURE_TLS=1) el certificado falso pasa", async () => {
  assert.equal(await probe({ NODE_TLS_REJECT_UNAUTHORIZED: "0", ALLOW_INSECURE_TLS: "1" }), "OPEN secreto");
});

test("3 · /health dice que la variable está puesta pero no tiene efecto", async () => {
  await S.start();
  const h = await fetch(`${S.BASE}/health`).then((r) => r.json());
  assert.equal(h.tls, "verified-override-ignored");
  assert.match(S.logs, /NODE_TLS_REJECT_UNAUTHORIZED=0 ignored/);
});
