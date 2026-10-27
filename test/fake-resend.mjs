// Test helper: Resend is replaced; every email goes to $MAIL_LOG (or fails with RESEND_FAIL=1).
// GET /emails/:id answers with last_event = $FAKE_EVENT (default "delivered").
import fs from "node:fs";
const real = globalThis.fetch;
let n = 0;
globalThis.fetch = async (url, opt = {}) => {
  if (String(url).includes("api.resend.com")) {
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if ((opt.method || "GET").toUpperCase() === "GET") {
      const id = String(url).split("/").pop();
      return json({ object: "email", id, last_event: process.env.FAKE_EVENT || "delivered" });
    }
    if (process.env.RESEND_FAIL === "1") return json({ name: "validation_error", message: "fake failure", statusCode: 422 }, 422);
    fs.appendFileSync(process.env.MAIL_LOG, opt.body + "\n");
    return json({ id: `fake-${process.pid}-${++n}` });
  }
  return real(url, opt);
};
