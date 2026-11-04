// 02-11q: certificate checks stay ON for every outgoing HTTPS call (Resend, Groq, Oxylabs Scraper API…).
// Production had NODE_TLS_REJECT_UNAUTHORIZED=0, which turns them off for the whole process (a man in the
// middle could read the Resend key and every lead). Node reads that variable on each connection, so removing
// it here, before any request, restores verification. The Oxylabs Web Unblocker agent keeps its own explicit
// exception (services/alibaba.js). ALLOW_INSECURE_TLS=1 restores the old behaviour if ever needed.
let overrideSeen = false;
/** Call once at start, after .env is loaded and before any request. */
export function guardTls() {
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== "0") return;
  overrideSeen = true;
  if (process.env.ALLOW_INSECURE_TLS === "1") return;
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  console.warn("🔒 NODE_TLS_REJECT_UNAUTHORIZED=0 ignored: certificate checks stay on (ALLOW_INSECURE_TLS=1 would allow insecure TLS).");
}
/** For /health: "verified" | "verified-override-ignored" (the variable is set but has no effect) | "insecure" */
export const tlsStatus = () => (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0" ? "insecure" : overrideSeen ? "verified-override-ignored" : "verified");
