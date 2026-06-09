import express from "express";
import NodeCache from "node-cache";
import { searchSuppliers } from "../services/alibaba.js";
import { scoreSuppliers, categorizeSuppliers } from "../services/scoring.js";
import { refineKeyword } from "./ai.js";

const router = express.Router();
const cache = new NodeCache({ stdTTL: 3600 });

router.get("/test", (_req, res) => {
  res.json({
    message: "✅ Suppliers route working",
    rapidApi: !!process.env.RAPIDAPI_KEY,
    grok: !!process.env.GROK_API_KEY,
  });
});

router.post("/search", async (req, res) => {
  try {
    const {
      productType,
      material,
      quantity,
      budget,
      destination,
      userQuery,        // ← NEW: original search bar query
    } = req.body;

    if (!productType) {
      return res.status(400).json({ error: "productType is required" });
    }

    const qty = parseInt(quantity) || 1000;
    const bdg = parseFloat(budget) || 50000;

    console.log(`\n🔍 Search request`);
    console.log(`   User Query:  "${userQuery || "(none)"}"`);
    console.log(`   ProductType: ${productType}`);
    console.log(`   Material:    ${material || "(none)"}`);
    console.log(`   Quantity:    ${qty}`);
    console.log(`   Budget:      $${bdg}`);
    console.log(`   Destination: ${destination || "not specified"}`);

    // ── STEP 1: Get smart keyword from Grok ─────────────────────────────────
    const keyword = userQuery && userQuery.trim()
      ? userQuery.trim()
      : productType;

    console.log(`   🎯 Final Search Keyword: "${keyword}"`);

    // ── Cache check (uses refined keyword) ──────────────────────────────────
    const cacheKey = `search_${keyword}_${qty}_${bdg}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log("⚡ Cache hit\n");
      return res.json({ ...cached, fromCache: true, searchKeyword: keyword });
    }

    // ── STEP 2: Fetch from Alibaba with refined keyword ─────────────────────
    const rawSuppliers = await searchSuppliers({
      keyword,
      pageSize: 20,
      quantity: qty,
    });

    // ── STEP 3: Score and categorize ────────────────────────────────────────
    const scored = scoreSuppliers(rawSuppliers, { budget: bdg, quantity: qty });
    const result = categorizeSuppliers(scored);

    console.log(`✅ Done: ${result.qualifiedCount} suppliers returned\n`);

    cache.set(cacheKey, result);
    res.json({
      ...result,
      fromCache: false,
      searchKeyword: keyword,   // ← return so frontend knows what was searched
    });

  } catch (error) {
    console.error("❌ /search error:", error.message);
    res.status(500).json({
      error: "Failed to search suppliers",
      details: error.message,
    });
  }
});

export default router;