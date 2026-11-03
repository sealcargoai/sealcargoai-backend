import path from "node:path";
import dotenv from "dotenv";
dotenv.config();   // ✅ MUST BE FIRST

import express from "express";
import cors from "cors";
import suppliersRouter from "./routes/suppliers.js";
import aiRouter from "./routes/ai.js";
import emailRoutes from "./routes/email.js";
import ratesRouter from "./routes/rates.js";
import leadsRouter, { learnBase } from "./routes/leads.js";
import { recipientConfig, emailDryRun, qaRouting, senderStatus, checkSenderDomain } from "./services/email.js";
import { corsOrigin, rateLimit } from "./middleware/security.js";
import { isQa, flushQuota } from "./services/quotaStore.js";
import { sessionVerifies, verifyStoreStatus } from "./services/verifyStore.js";
import { signingSecretSource } from "./services/quotaStore.js";
import { flushLeads } from "./services/leadStore.js";
import { flushFunnel } from "./services/funnelStore.js";


const app = express();
const PORT = process.env.PORT || 3001;

// Railway runs behind a proxy — needed to read the real client IP
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(cors({
  origin: corsOrigin,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "X-Verified-Session"],
}));

// 5 MB only where the PDF report (base64) travels; everything else stays small
app.use("/api/email/report", express.json({ limit: "5mb" }));
app.use(express.json({ limit: "200kb" }));

// Rate limits per IP
// QA / test accounts (QA_EMAILS) are not rate limited either
const searchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  // 02-11k: only a verified QA session (not a typed QA address) skips the limit
  skip: (req) => typeof req.body?.userEmail === "string" && isQa(req.body.userEmail) && sessionVerifies(req.body?.verifiedSession, req.body.userEmail),
});
const aiLimiter     = rateLimit({ windowMs: 10 * 60 * 1000, max: 40 });
const emailLimiter  = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });
// 02-11k (review): the code steps have their own limit, so a report (code + confirm + send) does not use up
// the budget of case and report sends of a shared office or mobile IP; per-address caps live in verifyStore
const verifyLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30 });
const eventLimiter  = rateLimit({ windowMs: 60 * 60 * 1000, max: 120 });
const followLimiter = rateLimit({ windowMs: 10 * 60 * 1000, max: 60 });

app.use(learnBase);

app.use("/api/suppliers/search", searchLimiter);
app.use("/api/suppliers", suppliersRouter);
app.use("/api/ai", aiLimiter, aiRouter);
app.use("/api/email/verify", verifyLimiter);
app.use("/api/email", (req, res, next) => (req.path.startsWith("/verify/") ? next() : emailLimiter(req, res, next)), emailRoutes);
app.use("/api/rates", ratesRouter);
app.use("/api/events", eventLimiter);
app.use("/api/leads", followLimiter);
app.use("/api", leadsRouter);


// Root route — no more "Cannot GET /"
app.get("/", (_req, res) => {
  res.json({
    name:    "SealCargo SmartTrade API",
    version: "1.0.0",
    status:  "running",
    endpoints: {
      health:    "GET  /health",
      suppliers: "POST /api/suppliers/search",
    },
  });
});

// the version actually running (the commit Railway built), to tell which code a test hit
// 02-11m: is DATA_DIR (and the verification store's folder) inside the mounted volume?
// Railway sets RAILWAY_VOLUME_MOUNT_PATH when a volume is attached to the service.
function onVolume(dir) {
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH || "";
  if (!dir) return "unset";
  if (!vol) return "no-volume-attached";
  const d = path.resolve(dir);
  const v = path.resolve(vol);
  return d === v || d.startsWith(v + path.sep) ? "on-volume" : "not-on-volume";
}
export function storageStatus() {
  return {
    dataDir: onVolume(process.env.DATA_DIR || ""),
    verifyDir: onVolume(process.env.VERIFY_DATA_DIR || process.env.DATA_DIR || ""),
    // the key file only survives a redeploy if it is on the volume (review 02-11m)
    verifyKey: process.env.VERIFY_SECRET ? "env" : signingSecretSource === "volume-file" && onVolume(process.env.DATA_DIR || "") !== "on-volume" ? "file-not-on-volume" : signingSecretSource,
  };
}

export const BACKEND_VERSION = "2026.11.03-n";
app.get("/health", (_req, res) => {
  res.json({
    status:          "ok",
    message:         "SealCargo Backend is running!",
    version:         BACKEND_VERSION,
    commit:          String(process.env.RAILWAY_GIT_COMMIT_SHA || "").slice(0, 7) || undefined,
    // true = this server cannot send email (staging / preview / tests)
    emailDryRun:     emailDryRun(),
    // 02-11c: whether test records have a safe destination (status only, never addresses)
    qaRouting:       qaRouting(),
    // 02-11l: where codes, sessions and report grants live: "persistent" (shared file on the volume) or "memory"
    verifyStore:     verifyStoreStatus(),
    // 02-11l: sender configuration and its domain status at Resend (read-only check, statuses only)
    emailSender:     senderStatus(),
    // 02-11m: whether the data folders are on the volume Railway attached (status only, never paths/secrets)
    storage:         storageStatus(),
    timestamp:       new Date().toISOString(),
  });
});

// Bad or oversized JSON and unexpected errors answer in JSON, without stack traces
app.use((err, _req, res, _next) => {
  // client errors from the body parser (bad JSON, bad encoding, too large) keep their 4xx
  const status = err?.type === "entity.too.large" ? 413 : err instanceof SyntaxError || err?.type === "entity.parse.failed" ? 400 : Number(err?.status) >= 400 && Number(err?.status) < 500 ? Number(err.status) : 500;
  if (status === 500) console.error("❌ Unhandled error:", err?.message);
  res.status(status).json({
    error: status === 413 ? "Request too large" : status === 400 ? "Invalid JSON body" : "Internal error",
  });
});

// a deploy stops the process: save the last counted searches first
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    flushQuota();
    flushLeads();
    flushFunnel();
    process.exit(0);
  });
}

app.listen(PORT, () => {
  // 02-11l: read-only check of the sender's domain at Resend (no email); repeated every 6 hours
  checkSenderDomain().then((st) => console.log(`   Email sender: ${st.from}, domain ${st.domain}`));
  setInterval(() => void checkSenderDomain(), 6 * 60 * 60 * 1000).unref();
  console.log(`\n✅ SealCargo Backend running at http://localhost:${PORT}`);
  console.log(`   Root:         http://localhost:${PORT}/`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Suppliers:    http://localhost:${PORT}/api/suppliers/test`);
  // counts only: no addresses in the logs
  const rc = recipientConfig();
  console.log(`   Recipients:   real → ${rc.commercial} commercial${rc.devGetsReal ? ` + ${rc.devCopies} dev (authorized)` : ""}; tests → ${rc.qaRouting === "ok" ? `QA inbox + ${rc.devCopies} dev` : "NOT SENT"}`);
  // 02-11c: startup check of the QA routing (status only, no addresses)
  if (rc.qaRouting !== "ok")
    console.warn(`⚠️  QA routing ${rc.qaRouting}: test records (QA_EMAILS) will be refused with 503 qa_routing_unavailable and never emailed. Set QA_LEADS_EMAIL to a QA inbox that is not a commercial address.\n`);
  else console.log("");
});