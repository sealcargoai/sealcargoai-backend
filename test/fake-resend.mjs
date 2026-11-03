// Test helper: Resend is replaced; every email goes to $MAIL_LOG (or fails with RESEND_FAIL=1).
// GET /emails/:id answers with last_event = $FAKE_EVENT (default "delivered").
import fs from "node:fs";
const real = globalThis.fetch;
let n = 0;
globalThis.fetch = async (url, opt = {}) => {
  if (String(url).includes("api.resend.com")) {
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if ((opt.method || "GET").toUpperCase() === "GET" && /\/domains\/?$/.test(String(url))) {
      // 02-11l: read-only domain list (FAKE_DOMAINS = JSON array of {name,status}; FAKE_DOMAINS_DENIED=1 → 401)
      if (process.env.FAKE_DOMAINS_DENIED === "1") return json({ name: "restricted_api_key", message: "restricted", statusCode: 401 }, 401);
      return json({ object: "list", data: JSON.parse(process.env.FAKE_DOMAINS || "[]") });
    }
    if ((opt.method || "GET").toUpperCase() === "GET") {
      const id = String(url).split("/").pop();
      return json({ object: "email", id, last_event: process.env.FAKE_EVENT || "delivered" });
    }
    // every attempt (sent or refused) is logged too: a test can prove an address was never even tried
    if (process.env.MAIL_LOG) fs.appendFileSync(process.env.MAIL_LOG + ".attempts", opt.body + "\n");
    if (process.env.RESEND_FAIL === "1") return json({ name: "validation_error", message: "fake failure", statusCode: 422 }, 422);
    // RESEND_FAIL_TO=<regex>: refuse only the sends whose «to» matches (e.g. an unverified recipient)
    if (process.env.RESEND_FAIL_TO) {
      const msg = JSON.parse(opt.body);
      const to = [].concat(msg.to || []).join(",");
      // RESEND_FAIL_SUBJECT=<regex> (optional): only those messages (e.g. the report, not the verification code)
      const subjectOk = !process.env.RESEND_FAIL_SUBJECT || new RegExp(process.env.RESEND_FAIL_SUBJECT, "i").test(String(msg.subject || ""));
      if (subjectOk && new RegExp(process.env.RESEND_FAIL_TO, "i").test(to)) return json({ name: "validation_error", message: "fake recipient refused", statusCode: 422 }, 422);
    }
    fs.appendFileSync(process.env.MAIL_LOG, opt.body + "\n");
    return json({ id: `fake-${process.pid}-${++n}` });
  }
  return real(url, opt);
};
