import express from "express";
import NodeCache from "node-cache";
import { searchSuppliers } from "../services/alibaba.js";
import { scoreSuppliers, categorizeSuppliers } from "../services/scoring.js";
import { refineKeyword } from "./ai.js";
import { clientIp, clean } from "../middleware/security.js";
import { sendSearchLead } from "../services/email.js";

// Send the search to SEAL sales without delaying the user's response
function notifySearch(details) {
  sendSearchLead(details).catch((err) =>
    console.error("⚠️ Search lead email failed:", err.message),
  );
}

// ── Free search limit, enforced on the server ───────────────────────────────
// Per email (3 free searches) and per IP (stops people switching emails or
// using incognito). In memory: counters reset when the service restarts.
const SEARCH_LIMIT = parseInt(process.env.SEARCH_LIMIT) || 3;
const IP_SEARCH_LIMIT = parseInt(process.env.IP_SEARCH_LIMIT) || 6;
const IP_WINDOW_MS = 24 * 60 * 60 * 1000;

const emailTracker = new Map(); // email -> count
const ipTracker = new Map();    // ip -> { count, resetAt }

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function ipEntry(ip) {
  const now = Date.now();
  let entry = ipTracker.get(ip);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + IP_WINDOW_MS };
    ipTracker.set(ip, entry);
  }
  return entry;
}

function checkSearchLimit(email, ip) {
  if (email && (emailTracker.get(email) || 0) >= SEARCH_LIMIT) return false;
  if (ipEntry(ip).count >= IP_SEARCH_LIMIT) return false;
  return true;
}

function recordBackendSearch(email, ip) {
  if (email) emailTracker.set(email, (emailTracker.get(email) || 0) + 1);
  ipEntry(ip).count += 1;
}

function remainingSearches(email, ip) {
  const byEmail = email ? SEARCH_LIMIT - (emailTracker.get(email) || 0) : SEARCH_LIMIT;
  const byIp = IP_SEARCH_LIMIT - ipEntry(ip).count;
  return Math.max(0, Math.min(byEmail, byIp));
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
    } = req.body;
    const userEmail = normalizeEmail(req.body.userEmail);
    const ip = clientIp(req);

    // ── SEARCH LIMIT CHECK ──────────────────────────────
    if (!checkSearchLimit(userEmail, ip)) {
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
      recordBackendSearch(userEmail, ip);
      notifySearch({
        email: userEmail,
        userQuery: clean(userQuery, 300),
        productType: clean(productType, 120),
        material: clean(material, 120),
        quantity: qty,
        budget: bdg,
        destination: clean(destination, 60),
        searchKeyword: keyword,
        qualifiedCount: cached.qualifiedCount,
        topSupplier: cached.topSuppliers?.[0]?.name,
      });
      return res.json({
        ...cached,
        fromCache: true,
        searchKeyword: keyword,
        remainingSearches: remainingSearches(userEmail, ip),
      });
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
    
    // Empty / blocked results are not counted against the user
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

    recordBackendSearch(userEmail, ip);
    cache.set(cacheKey, result);
    notifySearch({
      email: userEmail,
      userQuery: clean(userQuery, 300),
      productType: clean(productType, 120),
      material: clean(material, 120),
      quantity: qty,
      budget: bdg,
      destination: clean(destination, 60),
      searchKeyword: keyword,
      qualifiedCount: result.qualifiedCount,
      topSupplier: result.topSuppliers?.[0]?.name,
    });
    res.json({
      ...result,
      fromCache: false,
      searchKeyword: keyword,   // ← return so frontend knows what was searched
      remainingSearches: remainingSearches(userEmail, ip),
    });

  } catch (error) {
    console.error("❌ /search error:", error.message);
    res.status(500).json({
      error: "Failed to search suppliers",
    });
  }
});

export default router;