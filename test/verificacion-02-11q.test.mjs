// 02-11q — /health reports what Resend answered to real sends (counts and times only), and a send-only
// key is shown as "not checkable", never as a verified domain. Resend simulated; fictitious data.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { server } from "./fixtures/qa-server.mjs";

const CASE = { requestType: "Cotización", source: "formulario", name: "Ana Ficticia", email: "ana@cliente-ficticio.test", product: "sillas plásticas apilables para eventos", quantity: "40", budget: "US$800", lang: "es" };
const OK = server(11500, {});
const FAIL = server(11700, { RESEND_FAIL_TO: "ventas@example\\.test" });
const DRY = server(11900, { EMAIL_DRY_RUN: "1" });
const health = (s) => fetch(`${s.BASE}/health`).then((r) => r.json());
after(async () => {
  for (const s of [OK, FAIL, DRY]) if (s.proc) await s.stop();
});

test("1 · un caso enviado: /health cuenta 1 aceptado por Resend, sin direcciones ni asunto", async () => {
  await OK.start();
  const before = (await health(OK)).emailSends;
  assert.deepEqual([before.accepted, before.refused, before.lastAcceptedAt], [0, 0, null]);
  const r = await OK.post("/api/email/quote", CASE, "10.120.0.1");
  assert.equal(r.status, 200);
  const h = await health(OK);
  assert.equal(h.emailSends.accepted, 1);
  assert.equal(h.emailSends.refused, 0);
  assert.match(h.emailSends.lastAcceptedAt, /^\d{4}-\d\d-\d\dT/);
  assert.doesNotMatch(JSON.stringify(h), /@|sillas|Ana|fake-/);
});

test("2 · Resend rechaza el envío: el caso queda guardado sin avisar, /health cuenta el rechazo y su tipo", async () => {
  await FAIL.start();
  const r = await FAIL.post("/api/email/quote", CASE, "10.121.0.1");
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.match(j.id, /^SEAL-/, "el caso se registra aunque falle el aviso");
  assert.equal(j.notified, false);
  const h = await health(FAIL);
  assert.equal(h.emailSends.accepted, 0);
  assert.equal(h.emailSends.refused, 1);
  assert.equal(h.emailSends.lastRefusal, "validation_error");
  assert.doesNotMatch(JSON.stringify(h), /@|recipient refused|ventas/);
});

test("3 · modo sin envíos (EMAIL_DRY_RUN): nada cuenta como aceptado por Resend", async () => {
  await DRY.start();
  assert.equal((await DRY.post("/api/email/quote", CASE, "10.122.0.1")).status, 200);
  const h = await health(DRY);
  assert.equal(h.emailDryRun, true);
  assert.deepEqual([h.emailSends.accepted, h.emailSends.refused], [0, 0]);
});
