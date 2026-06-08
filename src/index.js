import dotenv from "dotenv";
dotenv.config();   // ✅ MUST BE FIRST
console.log("RESEND KEY:", process.env.RESEND_API_KEY);

import express from "express";
import cors from "cors";
import suppliersRouter from "./routes/suppliers.js";
import aiRouter from "./routes/ai.js";
import emailRoutes from "./routes/email.js";


const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({
  origin: "*",
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json());

app.use("/api/suppliers", suppliersRouter);
app.use("/api/ai", aiRouter);
app.use("/api/email", emailRoutes);


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