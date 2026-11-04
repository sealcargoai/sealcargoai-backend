import express from "express";
import NodeCache from "node-cache";
import { searchSuppliers } from "../services/alibaba.js";
import { scoreSuppliers, categorizeSuppliers } from "../services/scoring.js";
import { refineKeyword, shortenKeyword } from "./ai.js";
import { clientIp, clean, malformedFields, unsupportedEmail, QTY_MIN, QTY_MAX, BUDGET_MAX } from "../middleware/security.js";
import { sendSearchLead, scrubEmails } from "../services/email.js";
import { sessionVerifies } from "../services/verifyStore.js";
import { gateBySpecs, constrainKeyword } from "../services/specGate.js";

// Send the search to SEAL sales without delaying the user's response
function notifySearch(details) {
  sendSearchLead(details).catch((err) =>
    console.error("⚠️ Search lead email failed:", scrubEmails(err.message)),
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
  // 02-11k (review): a QA account's verified session (header, never in the URL) counts here too, so the
  // form does not stop it before the search that accepts the same session
  const qaVerified = isQa(email) && sessionVerifies(req.get("x-verified-session"), email);
  res.set("Cache-Control", "no-store");
  res.json({
    limit: SEARCH_LIMIT,
    remaining: remainingSearches(email, ip, qaVerified),
    reason: limitReason(email, ip, qaVerified),
  });
});

router.post("/search", async (req, res) => {
  const startedAt = Date.now();
  let ticket = null;
  try {
    // Text fields always as text, with the form's limits (arrays or objects never reach the search)
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    // an object or an array where text goes is a malformed request: rejected before anything is
    // counted or searched (it used to be joined or dropped silently)
    const malformed = malformedFields(body, ["userQuery", "productType", "material", "destination", "userEmail", "quantity", "budget", "volumeCbm", "weightKg", "verifiedSession"]);
    if (malformed.length) return res.status(400).json({ error: "invalid_fields", fields: malformed.slice(0, 10) });
    for (const k of ["userQuery", "productType", "material", "destination"]) {
      const v = body[k];
      body[k] = typeof v === "string" ? v.slice(0, 1500) : v == null ? "" : String(v).slice(0, 1500);
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
    // 02-11h: an unsupported (non-ASCII / invisible-character) email is refused, not dropped or folded:
    // nothing is searched, counted, recorded or emailed
    if (unsupportedEmail(req.body.userEmail)) {
      return res.status(400).json({ error: "email_not_supported", message: "Escriba el correo solo con letras sin tilde, números y signos comunes. / Write the email with plain letters, numbers and common signs only." });
    }
    const userEmail = normalizeEmail(req.body.userEmail);
    const ip = clientIp(req);
    // 02-11k: QA privileges (no search limits) only for a verified session of that same QA address
    const qaVerified = isQa(userEmail) && sessionVerifies(req.body.verifiedSession, userEmail);

    if (!productType) {
      return res.status(400).json({ error: "productType is required" });
    }

    // Same rule as the frontend: the description must say what the product is.
    // Nothing is searched or counted ("abc" used to return unrelated products).
    if (!descriptionIsDetailed(userQuery)) {
      console.log(`⚠️ Description too vague (${String(userQuery || "").length} chars)`);
      return res.json({
        needsMoreDetail: true,
        noRelevantMatches: true,
        topSuppliers: [],
        filteredOut: [],
        totalAnalyzed: 0,
        qualifiedCount: 0,
        remainingSearches: remainingSearches(userEmail, ip, qaVerified),
        message: "Description too vague to search.",
      });
    }
    // Same limits as the form: whole units 1–10,000,000; budget a finite positive amount up to
    // US$100,000,000. A value that was sent but is out of those limits is rejected, never rounded
    // or clamped (3.5 used to become 3 and 10,000,001 became 10,000,000 without saying so).
    const given = (v) => v !== undefined && v !== null && v !== "";
    // only a plain whole number ("4", 4): "5e2", "0x10", " 12 ", "4.0" are malformed, never converted
    const qtyNum = typeof quantity === "number" ? quantity : typeof quantity === "string" && /^\d+$/.test(quantity) ? Number(quantity) : NaN;
    if (given(quantity) && !(Number.isInteger(qtyNum) && qtyNum >= QTY_MIN && qtyNum <= QTY_MAX)) {
      return res.status(400).json({ error: typeof quantity === "string" && /^\s*-?\d+[.,]\d+\s*$/.test(quantity) ? "quantity_not_integer" : !Number.isFinite(qtyNum) ? "quantity_invalid" : !Number.isInteger(qtyNum) ? "quantity_not_integer" : qtyNum < QTY_MIN ? "quantity_below_min" : "quantity_above_max" });
    }
    const qty = given(quantity) ? qtyNum : 1000;
    const bdgNum = typeof budget === "number" ? budget : typeof budget === "string" && /^\d+(?:\.\d{1,2})?$/.test(budget) ? Number(budget) : NaN;
    if (given(budget) && !(Number.isFinite(bdgNum) && bdgNum > 0 && bdgNum <= BUDGET_MAX)) {
      return res.status(400).json({ error: Number.isFinite(bdgNum) && bdgNum > BUDGET_MAX ? "budget_above_max" : "budget_invalid" });
    }
    const bdg = given(budget) ? bdgNum : 50000;

    // Validation passed: only now is a search slot reserved (an invalid request never spends a free search)
    // ── SEARCH LIMIT CHECK: the slot is reserved now (parallel requests can't
    // pass the limit) and given back below if the search shows nothing ──
    ticket = reserveSearch(userEmail, ip, qaVerified);
    if (!ticket) {
      return res.status(429).json({
        error: "Search limit reached",
        message: "Has alcanzado el límite de búsquedas gratuitas.",
        limitReached: true,
        reason: limitReason(userEmail, ip, qaVerified),
        remainingSearches: 0,
        limit: SEARCH_LIMIT,
      });
    }

    console.log(`\n🔍 Search request`);
    // the client's own words are not logged (they can carry names, phones or emails)
    console.log(`   User Query:  ${String(userQuery || "").length} chars`);
    // 02-11j: fields typed by the client are logged as a category or a length only (no text, no line breaks)
    console.log(`   ProductType: ${/^[a-z_-]{1,30}$/i.test(String(productType)) ? productType : `${String(productType).length} chars`}`);
    console.log(`   Material:    ${material ? `${String(material).length} chars` : "(none)"}`);
    console.log(`   Quantity:    ${qty}`);
    console.log(`   Budget:      $${bdg}`);
    console.log(`   Destination: ${/^[a-z]{2}$/i.test(String(destination || "")) ? destination : destination ? `${String(destination).length} chars` : "not specified"}`);

    // ── STEP 1: Get smart keyword from Grok ─────────────────────────────────
    const keyword = await refineKeyword({
      userQuery,
      productType,
      material,
    });

    // 02-11s: the client's requirements survive translation and shortening ("sin látex" → "latex free")
    const ck = constrainKeyword(keyword, userQuery);
    console.log(`   🎯 Final Search Keyword: "${ck.searchKeyword}"`);

    // ── Cache check (uses refined keyword; the gate depends on the description) ─
    const cacheKey = `search_${ck.searchKeyword}_${qty}_${bdg}_${String(userQuery).toLowerCase().replace(/\s+/g, " ").trim()}`;
    const cached = cache.get(cacheKey);
    if (cached) {
      console.log("⚡ Cache hit\n");
      // repeating one's own search is free; someone else's (or a rephrased) one counts
      const seenKey = `${userEmail || ip}|${cacheKey}`;
      // a cached result with no supplier to show counts nothing, as on the first run
      const ownRepeat = seen.has(seenKey);
      if (ownRepeat || !cached.topSuppliers?.length) ticket.release();
      else {
        seen.set(seenKey, Date.now());
        ticket.commit();
      }
      // 02-11: the same person repeating the same search (a retry, a reload) is not a new search:
      // the team already got that notice, so no duplicate email
      if (!ownRepeat) notifySearch({
        email: userEmail,
        userQuery: clean(userQuery, 1500),
        productType: clean(productType, 120),
        material: clean(material, 120),
        quantity: qty,
        budget: given(budget) ? bdg : "", // only the budget the client gave (not the internal default)
        destination: clean(destination, 60),
        searchKeyword: keyword,
        qualifiedCount: cached.qualifiedCount,
        topSupplier: cached.topSuppliers?.[0]?.name,
      });
      return res.json({
        ...cached,
        fromCache: true,
        searchKeyword: keyword,
        remainingSearches: remainingSearches(userEmail, ip, qaVerified),
      });
    }

    // ── STEP 2: Fetch from Alibaba with refined keyword ─────────────────────
    // 02-11s: explicit contradictions with the description leave BEFORE scoring and ordering
    let rawSuppliers = gateBySpecs(await searchSuppliers({
      keyword: ck.searchKeyword,
      relevanceKeyword: ck.relevanceKeyword,
      pageSize: 20,
      quantity: qty,
    }), userQuery);

    // ── STEP 3: Score and categorize ────────────────────────────────────────
    let result = categorizeSuppliers(scoreSuppliers(rawSuppliers, { budget: bdg, quantity: qty }));
    let usedKeyword = ck.searchKeyword;

    // ── STEP 3b: one retry with a shorter keyword ───────────────────────────
    // Very specific keywords (from long descriptions) sometimes return nothing.
    // If the first try was quick enough, retry with the core product name.
    // The page waits ~95 s, so the retry only runs with time to spare.
    if (!result?.totalAnalyzed && Date.now() - startedAt < 55000) {
      const short = constrainKeyword(await shortenKeyword(keyword), userQuery);
      const shorter = short.searchKeyword;
      const budgetMs = 88000 - (Date.now() - startedAt);
      if (shorter && shorter.toLowerCase() !== ck.searchKeyword.toLowerCase() && budgetMs > 20000) {
        console.log(`🔁 No usable results for "${ck.searchKeyword}" — retrying with "${shorter}" (${Math.round(budgetMs / 1000)}s left)`);
        const raw2 = gateBySpecs(await searchSuppliers({ keyword: shorter, relevanceKeyword: short.relevanceKeyword, pageSize: 20, quantity: qty, budgetMs }), userQuery);
        const r2 = categorizeSuppliers(scoreSuppliers(raw2, { budget: bdg, quantity: qty }));
        if (r2?.totalAnalyzed) {
          rawSuppliers = raw2;
          result = r2;
          usedKeyword = shorter;
        } else if ((raw2?.offerCount || 0) > (rawSuppliers?.offerCount || 0) || (raw2?.specExcluded || 0) > (rawSuppliers?.specExcluded || 0)) {
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
        ? `⚠️ ${rawSuppliers.offerCount} offers, none related to "${usedKeyword}" (${rawSuppliers.specExcluded || 0} contradicted the request) — asking client for more detail`
        : "⚠️ Not caching empty supplier result");
      return res.json({
        ...result,
        fromCache: false,
        searchKeyword: usedKeyword,
        specExcluded: rawSuppliers?.specExcluded || 0,
        specReasons: rawSuppliers?.specReasons || [],
        blocked: !noRelevantMatches,
        noRelevantMatches,
        message: noRelevantMatches
          ? "Results did not match the described product."
          : "No live results from Alibaba (blocked or no matches).",
        remainingSearches: remainingSearches(userEmail, ip, qaVerified),
      });
    }

    // Only searches that showed options use a free search; a client that already left
    // (closed the page, started another case) never saw them: it costs nothing. The
    // result stays cached, so asking again is answered at once.
    const clientGone = req.socket?.destroyed || res.writableEnded || req.aborted;
    if (result.topSuppliers?.length > 0 && !clientGone) {
      ticket.commit();
      seen.set(`${userEmail || ip}|${cacheKey}`, Date.now());
    }
    else ticket.release();
    result.specExcluded = rawSuppliers?.specExcluded || 0;
    result.specReasons = rawSuppliers?.specReasons || [];
    cache.set(cacheKey, result);
    notifySearch({
      email: userEmail,
      userQuery: clean(userQuery, 1500),
      productType: clean(productType, 120),
      material: clean(material, 120),
      quantity: qty,
      budget: given(budget) ? bdg : "", // only the budget the client gave (not the internal default)
      destination: clean(destination, 60),
      searchKeyword: usedKeyword,
      qualifiedCount: result.qualifiedCount,
      topSupplier: result.topSuppliers?.[0]?.name,
    });
    res.json({
      ...result,
      fromCache: false,
      searchKeyword: usedKeyword,   // ← return so frontend knows what was searched
      remainingSearches: remainingSearches(userEmail, ip, qaVerified),

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