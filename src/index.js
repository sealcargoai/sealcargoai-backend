import dotenv from "dotenv";
dotenv.config();   // ✅ MUST BE FIRST

import express from "express";
import cors from "cors";
import suppliersRouter from "./routes/suppliers.js";
import aiRouter from "./routes/ai.js";
import emailRoutes from "./routes/email.js";
import ratesRouter from "./routes/rates.js";
import { corsOrigin, rateLimit } from "./middleware/security.js";


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

// 5 MB so the PDF report (base64) fits; default is 100 KB
app.use(express.json({ limit: "5mb" }));

// Rate limits per IP
const searchLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
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
      chat:      "POST /api/ai/chat",
      costs:     "POST /api/ai/costs",
      contact:   "POST /api/ai/contact",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status:          "ok",
    message:         "SealCargo Backend is running!",
    timestamp:       new Date().toISOString(),
    environment:     process.env.NODE_ENV,
    alibabaEnabled:  !!process.env.ALIBABA_APP_KEY,
    grokEnabled:     !!process.env.GROK_API_KEY &&
                     process.env.GROK_API_KEY !== "your_grok_api_key_here",
    rapidApiEnabled: !!process.env.RAPIDAPI_KEY &&
                     process.env.RAPIDAPI_KEY !== "your_rapidapi_key_here",
  });
});

app.listen(PORT, () => {
  console.log(`\n✅ SealCargo Backend running at http://localhost:${PORT}`);
  console.log(`   Root:         http://localhost:${PORT}/`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Suppliers:    http://localhost:${PORT}/api/suppliers/test\n`);
});