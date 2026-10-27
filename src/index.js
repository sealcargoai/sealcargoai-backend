import dotenv from "dotenv";
dotenv.config();   // ✅ MUST BE FIRST

import express from "express";
import cors from "cors";
import suppliersRouter from "./routes/suppliers.js";
import aiRouter from "./routes/ai.js";
import emailRoutes from "./routes/email.js";
import ratesRouter from "./routes/rates.js";
import { corsOrigin, rateLimit } from "./middleware/security.js";
import { isQa, flushQuota } from "./services/quotaStore.js";


const app = express();
const PORT = process.env.PORT || 3001;

// Railway runs behind a proxy — needed to read the real client IP
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(cors({
  origin: corsOrigin,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

// 5 MB only where the PDF report (base64) travels; everything else stays small
app.use("/api/email/report", express.json({ limit: "5mb" }));
app.use(express.json({ limit: "200kb" }));

// Rate limits per IP
// QA / test accounts (QA_EMAILS) are not rate limited either
const searchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  skip: (req) => typeof req.body?.userEmail === "string" && isQa(req.body.userEmail),
});
const aiLimiter     = rateLimit({ windowMs: 10 * 60 * 1000, max: 40 });
const emailLimiter  = rateLimit({ windowMs: 60 * 60 * 1000, max: 10 });

app.use("/api/suppliers/search", searchLimiter);
app.use("/api/suppliers", suppliersRouter);
app.use("/api/ai", aiLimiter, aiRouter);
app.use("/api/email", emailLimiter, emailRoutes);
app.use("/api/rates", ratesRouter);


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

app.get("/health", (_req, res) => {
  res.json({
    status:          "ok",
    message:         "SealCargo Backend is running!",
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
    process.exit(0);
  });
}

app.listen(PORT, () => {
  console.log(`\n✅ SealCargo Backend running at http://localhost:${PORT}`);
  console.log(`   Root:         http://localhost:${PORT}/`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Suppliers:    http://localhost:${PORT}/api/suppliers/test\n`);
});