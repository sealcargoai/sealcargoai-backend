import express from "express";
import NodeCache from "node-cache";
import { searchSuppliers } from "../services/alibaba.js";
import { scoreSuppliers, categorizeSuppliers } from "../services/scoring.js";
import { refineKeyword } from "./ai.js";

const searchTracker = new Map(); // email -> count
const SEARCH_LIMIT = 3;

function checkSearchLimit(email) {
  if (!email) return true; // No email = allow (guest)
  const count = searchTracker.get(email) || 0;
  return count < SEARCH_LIMIT;
}

function recordBackendSearch(email) {
  if (!email) return;
  const count = searchTracker.get(email) || 0;
  searchTracker.set(email, count + 1);
}

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
      userQuery,
      userEmail,   // ← Frontend will send this
    } = req.body;

    // ── SEARCH LIMIT CHECK ──────────────────────────────
    if (userEmail && !checkSearchLimit(userEmail)) {
      return res.status(429).json({
        error: "Search limit reached",
        message: "Has alcanzado el límite de búsquedas gratuitas.",
        limitReached: true,
      });
    }

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
    const keyword = await refineKeyword({
      userQuery,
      productType,
      material,
    });

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
    
    // ── RECORD SEARCH AT END (before cache.set) ─────────
    recordBackendSearch(userEmail);

    if (!result?.topSuppliers?.length) {
      console.log("⚠️ Not caching empty supplier result");
      return res.json({
        ...result,
        fromCache: false,
        searchKeyword: keyword,
        blocked: true,
        message: "Alibaba blocked the request (captcha). Try again.",
      });
    }

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