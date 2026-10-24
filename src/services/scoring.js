// ── SEAL supplier filters ────────────────────────────────────────────────────
// These are the rules shown on the results page. Every supplier must pass all
// of them to be listed; the rest go to "filteredOut" with the reason.
// Thresholds can be tuned with env vars without touching code.
export const FILTERS = {
  minRating:   parseFloat(process.env.FILTER_MIN_RATING) || 4.0, // only when the product has reviews
  requireVerified: process.env.FILTER_REQUIRE_VERIFIED !== "false", // Gold Supplier on Alibaba
  minYears:    parseInt(process.env.FILTER_MIN_YEARS) || 2,       // years as Gold Supplier
  minAiScore:  parseInt(process.env.FILTER_MIN_SCORE) || 60,      // final weighted score
};

export function scoreSuppliers(suppliers, userRequirements) {
  const { budget = 50000, quantity = 1000 } = userRequirements;
  const budgetPerUnit = budget / quantity;

  // Price range for relative scoring
  const prices     = suppliers.map(s => s.price).filter(p => p > 0);
  const minPrice   = prices.length ? Math.min(...prices) : 0;
  const maxPrice   = prices.length ? Math.max(...prices) : 0;
  const priceRange = maxPrice - minPrice || 1;

  const scored = suppliers.map((supplier) => {

    // ── 1. Price Score (0-100) ────────────────────────────────────────────────
    let priceScore = 50;
    if (supplier.price > 0 && prices.length > 1) {
      const relativeScore = ((maxPrice - supplier.price) / priceRange) * 60;
      const budgetScore   = supplier.price <= budgetPerUnit
        ? 40
        : Math.max(0, 40 - ((supplier.price - budgetPerUnit) / budgetPerUnit) * 40);
      priceScore = Math.round(Math.min(100, relativeScore + budgetScore));
    } else if (supplier.price > 0) {
      priceScore = supplier.price <= budgetPerUnit ? 80 : 40;
    }

    // ── 2. Quality Score (0-100) ──────────────────────────────────────────────
    // No reviews → neutral 60, never an invented rating
    const reviews = supplier.reviews || 0;
    let qualityScore = 60;
    if (supplier.rating) {
      const ratingScore = (supplier.rating / 5) * 80;
      const reviewScore = Math.min(20, (reviews / 100) * 20);
      qualityScore = Math.round(ratingScore + reviewScore);
    }

    // ── 3. Reliability Score (0-100) ──────────────────────────────────────────
    const years            = supplier.yearsInBusiness || 0;
    const yearsScore       = Math.min(60, years * 6);
    const verifiedScore    = supplier.verified       ? 25 : 0;
    const tradeScore       = supplier.tradeAssurance ? 15 : 0;
    const reliabilityScore = Math.round(Math.min(100, yearsScore + verifiedScore + tradeScore));

    // ── 4. MOQ Score (0-100) ──────────────────────────────────────────────────
    const moq = supplier.moq || 1;
    const moqScore = moq <= quantity
      ? 100
      : Math.max(10, Math.round(100 - ((moq - quantity) / quantity) * 60));

    // ── 5. Final weighted AI Score ────────────────────────────────────────────
    const aiScore = Math.round(
      priceScore       * 0.35 +
      qualityScore     * 0.30 +
      reliabilityScore * 0.25 +
      moqScore         * 0.10
    );

    const rejectReason = getRejectReason({ ...supplier, aiScore });

    return {
      ...supplier,
      priceScore:       Math.round(priceScore),
      qualityScore:     Math.round(qualityScore),
      reliabilityScore: Math.round(reliabilityScore),
      moqScore:         Math.round(moqScore),
      aiScore,
      isQualified:      !rejectReason,
      rejectReason,
    };
  });

  return scored.sort((a, b) => b.aiScore - a.aiScore);
}

// First filter the supplier fails, in Spanish (shown to the user), or null
function getRejectReason(s) {
  if (s.rating && s.reviews > 0 && s.rating < FILTERS.minRating) {
    return `Calificación ${s.rating.toFixed(1)} por debajo de ${FILTERS.minRating.toFixed(1)}`;
  }
  if (FILTERS.requireVerified && !s.verified) {
    return "Proveedor no verificado (no es Gold Supplier)";
  }
  if ((s.yearsInBusiness || 0) < FILTERS.minYears) {
    return `Menos de ${FILTERS.minYears} años como proveedor verificado`;
  }
  if (s.aiScore < FILTERS.minAiScore) {
    return `Puntuación ${s.aiScore}/100, debajo del mínimo de ${FILTERS.minAiScore}`;
  }
  return null;
}

// Alibaba lists every product separately, so one factory can appear many times.
// Keep only the best-scored product per company (list is already sorted by score).
function companyKey(s) {
  return String(s.name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function dedupeByCompany(list, exclude = new Set()) {
  const seen = new Set(exclude);
  return list.filter((s) => {
    const key = companyKey(s);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function categorizeSuppliers(scoredSuppliers) {
  const qualified = dedupeByCompany(scoredSuppliers.filter((s) => s.isQualified));
  // A company already listed as qualified is not shown again as "filtered"
  const rejected  = dedupeByCompany(
    scoredSuppliers.filter((s) => !s.isQualified),
    new Set(qualified.map(companyKey)),
  );

  console.log(`Filters: ${qualified.length} qualified / ${rejected.length} filtered out`);

  return {
    topSuppliers:   qualified.slice(0, 9),
    filteredOut:    rejected.slice(0, 20).map((s) => ({
      name:   s.name,
      reason: s.rejectReason,
      rating: s.rating,
      aiScore: s.aiScore,
    })),
    totalAnalyzed:  scoredSuppliers.length,
    qualifiedCount: qualified.length,
    filters:        FILTERS,
  };
}
