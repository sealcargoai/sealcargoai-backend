import express from "express";
import NodeCache from "node-cache";
import { searchSuppliers } from "../services/alibaba.js";
import { scoreSuppliers, categorizeSuppliers } from "../services/scoring.js";
import { refineKeyword, shortenKeyword } from "./ai.js";
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

// A description needs at least 10 characters and 2 real words (one of 4+ letters)
function descriptionIsDetailed(text) {
  const v = String(text || "").trim();
  if (v.length < 10) return false;
  const words = v.toLowerCase().match(/[a-záéíóúüñ]{3,}/g) || [];
  const real = words.filter((w) => /[aeiouáéíóúü]/.test(w) && !/^(.)\1+$/.test(w));
  return real.length >= 2 && real.some((w) => w.length >= 4);
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
  const startedAt = Date.now();
  try {
    // Text fields always as text, with the form's limits (arrays or objects never reach the search)
    const body = req.body && typeof req.body === "object" ? req.body : {};
    for (const k of ["userQuery", "productType", "material", "destination"]) {
      const v = body[k];
      body[k] = typeof v === "string" ? v.slice(0, 1500) : v == null ? "" : String(Array.isArray(v) ? v.join(" ") : "").slice(0, 1500);
    }
    req.body = body;
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

    // Same rule as the frontend: the description must say what the product is.
    // Nothing is searched or counted ("abc" used to return unrelated products).
    if (!descriptionIsDetailed(userQuery)) {
      console.log(`⚠️ Description too vague: "${String(userQuery || "").slice(0, 60)}"`);
      return res.json({
        needsMoreDetail: true,
        noRelevantMatches: true,
        topSuppliers: [],
        filteredOut: [],
        totalAnalyzed: 0,
        qualifiedCount: 0,
        remainingSearches: remainingSearches(userEmail, ip),
        message: "Description too vague to search.",
      });
    }
    // Same limits as the form: whole units 1–10,000,000; budget a finite positive amount
    const qtyNum = parseInt(quantity, 10);
    const qty = Number.isFinite(qtyNum) && qtyNum >= 1 ? Math.min(qtyNum, 10_000_000) : 1000;
    const bdgNum = parseFloat(budget);
    const bdg = Number.isFinite(bdgNum) && bdgNum > 0 ? Math.min(bdgNum, 100_000_000) : 50000;

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
      // a repeated search served from cache does not use a free search (same rule as the page)
      notifySearch({
        email: userEmail,
        userQuery: clean(userQuery, 1500),
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
    let rawSuppliers = await searchSuppliers({
      keyword,
      pageSize: 20,
      quantity: qty,
    });

    // ── STEP 3: Score and categorize ────────────────────────────────────────
    let result = categorizeSuppliers(scoreSuppliers(rawSuppliers, { budget: bdg, quantity: qty }));
    let usedKeyword = keyword;

    // ── STEP 3b: one retry with a shorter keyword ───────────────────────────
    // Very specific keywords (from long descriptions) sometimes return nothing.
    // If the first try was quick enough, retry with the core product name.
    // The page waits ~95 s, so the retry only runs with time to spare.
    if (!result?.totalAnalyzed && Date.now() - startedAt < 55000) {
      const shorter = await shortenKeyword(keyword);
      const budgetMs = 88000 - (Date.now() - startedAt);
      if (shorter && shorter.toLowerCase() !== keyword.toLowerCase() && budgetMs > 20000) {
        console.log(`🔁 No usable results for "${keyword}" — retrying with "${shorter}" (${Math.round(budgetMs / 1000)}s left)`);
        const raw2 = await searchSuppliers({ keyword: shorter, pageSize: 20, quantity: qty, budgetMs });
        const r2 = categorizeSuppliers(scoreSuppliers(raw2, { budget: bdg, quantity: qty }));
        if (r2?.totalAnalyzed) {
          rawSuppliers = raw2;
          result = r2;
          usedKeyword = shorter;
        } else if ((raw2?.offerCount || 0) > (rawSuppliers?.offerCount || 0)) {
          rawSuppliers = raw2;
        }
      }
    }

    console.log(`✅ Done: ${result.qualifiedCount} suppliers returned\n`);
    
    // No results at all (Alibaba blocked / nothing related) are not counted,
    // and neither are results where every supplier failed the filters.
    if (!result?.totalAnalyzed) {
      const noRelevantMatches = (rawSuppliers?.offerCount || 0) > 0;
      console.log(noRelevantMatches
        ? `⚠️ ${rawSuppliers.offerCount} offers, none related to "${keyword}" — asking client for more detail`
        : "⚠️ Not caching empty supplier result");
      return res.json({
        ...result,
        fromCache: false,
        searchKeyword: usedKeyword,
        blocked: !noRelevantMatches,
        noRelevantMatches,
        message: noRelevantMatches
          ? "Results did not match the described product."
          : "No live results from Alibaba (blocked or no matches).",
        remainingSearches: remainingSearches(userEmail, ip),
      });
    }

    // Only searches that showed options use a free search
    if (result.topSuppliers?.length > 0) recordBackendSearch(userEmail, ip);
    cache.set(cacheKey, result);
    notifySearch({
      email: userEmail,
      userQuery: clean(userQuery, 1500),
      productType: clean(productType, 120),
      material: clean(material, 120),
      quantity: qty,
      budget: bdg,
      destination: clean(destination, 60),
      searchKeyword: usedKeyword,
      qualifiedCount: result.qualifiedCount,
      topSupplier: result.topSuppliers?.[0]?.name,
    });
    res.json({
      ...result,
      fromCache: false,
      searchKeyword: usedKeyword,   // ← return so frontend knows what was searched
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