// A separate process using the verification store on a shared folder (= another instance on the volume).
// usage: node verify-worker.mjs <dir> <op> <json args>   → prints the result as JSON
import { createVerifyStore } from "../../src/services/verifyStore.js";
const [dir, op, raw] = process.argv.slice(2);
const a = JSON.parse(raw || "{}");
const vs = createVerifyStore({ dir, secret: Buffer.from("secreto-compartido-de-prueba"), env: a.env || process.env });
// start together: wait until the given moment so the processes really overlap
if (a.at) while (Date.now() < a.at) await new Promise((r) => setTimeout(r, 1));
let out;
try {
  if (op === "consume") out = vs.consumeGrant(a.token, a.email);
  else if (op === "start") out = vs.start(a.email, a.ip).ok;
  else if (op === "startSolving") {
    const { startSolving } = await import("./pow.mjs");
    out = startSolving(vs, a.email, a.ip).ok;
  } else if (op === "report") out = vs.consumeGrantAndCount(a.token, a.email, a.to, a.by, { to: 3, by: 10 });
  else out = "unknown op";
} catch (e) {
  out = `error:${e.code}`;
}
process.stdout.write(JSON.stringify(out));
