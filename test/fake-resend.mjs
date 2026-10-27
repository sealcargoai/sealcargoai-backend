// Test helper: Resend is replaced; every email goes to $MAIL_LOG (or fails with RESEND_FAIL=1)
import fs from "node:fs";
const real = globalThis.fetch;
globalThis.fetch = async (url, opt) => {
  if (String(url).includes("api.resend.com")) {
    if (process.env.RESEND_FAIL === "1") return new Response(JSON.stringify({ name: "validation_error", message: "fake failure", statusCode: 422 }), { status: 422, headers: { "content-type": "application/json" } });
    fs.appendFileSync(process.env.MAIL_LOG, opt.body + "\n");
    return new Response(JSON.stringify({ id: "fake" }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return real(url, opt);
};
