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

// ── Free search limit, enforced on the server (services/quotaStore.js) ──────
import {
  SEARCH_LIMIT,
  normalizeEmail,
  isQa,
  limitReason,
  remainingSearches,
  reserveSearch,
} from "../services/quotaStore.js";

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
// who already saw which cached result (a repeat of one's own search is free)
const seen = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, at] of seen) if (now - at > 3600 * 1000) seen.delete(k);
}, 10 * 60 * 1000).unref();


// The form asks before offering a search, so it never shows a number the
// server would contradict. Read-only: nothing is counted here.

router.get("/quota", (req, res) => {
  const email = normalizeEmail(typeof req.query.email === "string" ? req.query.email : "");
  const ip = clientIp(req);
  res.set("Cache-Control", "no-store");
  res.json({
    limit: SEARCH_LIMIT,
    remaining: remainingSearches(email, ip),
    reason: limitReason(email, ip),
  });
});

router.post("/search", async (req, res) => {
  const startedAt = Date.now();
  let ticket = null;
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

    // ── SEARCH LIMIT CHECK: the slot is reserved now (parallel requests can't
    // pass the limit) and given back below if the search shows nothing ──
    ticket = reserveSearch(userEmail, ip);
    if (!ticket) {
      return res.status(429).json({
        error: "Search limit reached",
        message: "Has alcanzado el límite de búsquedas gratuitas.",
        limitReached: true,
        reason: limitReason(userEmail, ip),
        remainingSearches: 0,
        limit: SEARCH_LIMIT,
      });
    }

    if (!productType) {
      ticket.release();
      return res.status(400).json({ error: "productType is required" });
    }

    // Same rule as the frontend: the description must say what the product is.
    // Nothing is searched or counted ("abc" used to return unrelated products).
    if (!descriptionIsDetailed(userQuery)) {
      console.log(`⚠️ Description too vague: "${String(userQuery || "").slice(0, 60)}"`);
      ticket.release();
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
    const qtyNum = typeof quantity === "number" || typeof quantity === "string" ? Number(quantity) : NaN;
    const qty = Number.isFinite(qtyNum) && qtyNum >= 1 ? Math.min(Math.floor(qtyNum), 10_000_000) : 1000;
    const bdgNum = typeof budget === "number" || typeof budget === "string" ? Number(budget) : NaN;
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
      // repeating one's own search is free; someone else's (or a rephrased) one counts
      const seenKey = `${userEmail || ip}|${cacheKey}`;
      // a cached result with no supplier to show counts nothing, as on the first run
      if (seen.has(seenKey) || !cached.topSuppliers?.length) ticket.release();
      else {
        seen.set(seenKey, Date.now());
        ticket.commit();
      }
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
      ticket.release();
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
    if (result.topSuppliers?.length > 0) {
      ticket.commit();
      seen.set(`${userEmail || ip}|${cacheKey}`, Date.now());
    }
    else ticket.release();
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
    ticket?.release();
    console.error("❌ /search error:", error.message);
    res.status(500).json({
      error: "Failed to search suppliers",
    });
  }
});

export default router;