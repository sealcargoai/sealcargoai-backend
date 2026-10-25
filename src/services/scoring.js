// ── Índice de Confianza SEAL ─────────────────────────────────────────────────
// Supplier scorecard: written criteria, weights by risk, fixed 0-100 scale.
// 1) Mandatory filters (knock-out) — failing suppliers are not listed, with the reason.
// 2) Trust score 0-100 from five criteria. Price is NOT part of trust.
//    A criterion Alibaba doesn't publish is never invented: it is marked
//    unavailable and its weight is spread over the criteria that do exist.
// 3) Order: trust level first (A, then B, then C), then lowest unit price inside each level.
// Thresholds can be tuned with env vars without touching code.

export const FILTERS = {
  minRating:       parseFloat(process.env.FILTER_MIN_RATING) || 4.0, // applied only with enough reviews
  minReviewsForRating: parseInt(process.env.FILTER_MIN_REVIEWS) || 5,
  minGoldYears:    parseInt(process.env.FILTER_MIN_YEARS) || 3,      // Gold Supplier needs 3+ years (Verified passes)
  minTrust:        parseInt(process.env.FILTER_MIN_TRUST) || 50,     // below this: not shown
  levelA:          parseInt(process.env.TRUST_LEVEL_A) || 80,        // A: alta
  levelB:          parseInt(process.env.TRUST_LEVEL_B) || 65,        // B: buena · C (50-64): media, verificación recomendada
};

export const TRUST_WEIGHTS = {
  verification: 30, // third-party audited Verified Supplier vs Gold membership
  track:        20, // years on Alibaba
  performance:  25, // on-time delivery, response rate, reorder rate (when published)
  reputation:   15, // rating adjusted by number of reviews (Bayesian average)
  protection:   10, // Trade Assurance
};

const LABELS = {
  verification: "Verificación",
  track:        "Trayectoria",
  performance:  "Desempeño comercial",
  reputation:   "Reputación",
  protection:   "Protección de pago",
};

const clamp = (n, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// Bayesian average: few reviews pull the rating toward the average of the search
const BAYES_M = 20;

function criteria(s, meanRating) {
  const years = s.yearsInBusiness || 0;
  const gold = !!s.goldSupplier;
  const audited = s.verifiedSupplier === true; // only when Alibaba really says so

  // 1. Verification (always known: we can tell if it has a badge or not)
  const verification = audited
    ? { score: 100, detail: "Proveedor verificado (auditoría de tercero)" }
    : gold
      ? { score: 33, detail: "Miembro Gold (membresía, sin auditoría en planta)" }
      : { score: 0, detail: "Sin insignia de verificación" };

  // 2. Track record (years published by Alibaba)
  const track = years > 0
    ? { score: clamp(years * 10), detail: `${years} ${years === 1 ? "año" : "años"} en Alibaba` }
    : { score: null, detail: "N/D" };

  // 3. Commercial performance — average of whatever Alibaba publishes
  const perf = [];
  const perfTxt = [];
  if (isNum(s.onTimeDeliveryRate)) { perf.push(clamp(s.onTimeDeliveryRate)); perfTxt.push(`${s.onTimeDeliveryRate}% entregas a tiempo`); }
  if (isNum(s.responseRate))       { perf.push(clamp(s.responseRate));       perfTxt.push(`${s.responseRate}% respuesta`); }
  if (isNum(s.reorderRate))        { perf.push(clamp(s.reorderRate * 2.5));  perfTxt.push(`${s.reorderRate}% recompra`); }
  const performance = perf.length
    ? { score: Math.round(perf.reduce((a, b) => a + b, 0) / perf.length), detail: perfTxt.join(" · ") }
    : { score: null, detail: "N/D" };

  // 4. Reputation — product rating adjusted by review count + supplier service score
  const reviews = s.reviews || 0;
  const repParts = [];
  const repTxt = [];
  if (s.rating && reviews > 0) {
    const adj = (reviews / (reviews + BAYES_M)) * s.rating + (BAYES_M / (reviews + BAYES_M)) * meanRating;
    repParts.push(clamp(((adj - 3) / 2) * 100));
    repTxt.push(`${s.rating.toFixed(1)} con ${reviews} ${reviews === 1 ? "reseña" : "reseñas"} (ajustado ${adj.toFixed(2)})`);
  }
  if (isNum(s.storeRating) && s.storeRating > 0) {
    repParts.push(clamp(((s.storeRating - 3) / 2) * 100));
    repTxt.push(`servicio del proveedor ${s.storeRating.toFixed(1)}/5`);
  }
  const reputation = repParts.length
    ? { score: Math.round(repParts.reduce((a, b) => a + b, 0) / repParts.length), detail: repTxt.join(" · ") }
    : { score: null, detail: "Sin reseñas" };

  // 5. Payment protection — only when the field is known
  const protection = s.tradeAssurance === true
    ? { score: 100, detail: "Protección de pedidos" }
    : s.tradeAssurance === false
      ? { score: 0, detail: "Sin protección de pedidos" }
      : { score: null, detail: "N/D" };

  return { verification, track, performance, reputation, protection };
}

// Numbers may arrive as text or be missing: normalize before scoring
const num = (v) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
function normalizeSupplier(s) {
  const rating = num(s?.rating);
  return {
    ...s,
    name: String(s?.name ?? ""),
    rating: rating > 0 && rating <= 5 ? rating : null,
    reviews: Math.max(0, Math.round(num(s?.reviews))),
    moq: Math.max(0, Math.round(num(s?.moq))),
    price: Math.max(0, num(s?.price)),
    yearsInBusiness: Math.max(0, Math.round(num(s?.yearsInBusiness))),
    storeRating: num(s?.storeRating) > 0 ? num(s?.storeRating) : null,
    certifications: Array.isArray(s?.certifications) ? s.certifications : [],
    badges: Array.isArray(s?.badges) ? s.badges : [],
  };
}

export function scoreSuppliers(rawSuppliers, userRequirements = {}) {
  const suppliers = (Array.isArray(rawSuppliers) ? rawSuppliers : []).map(normalizeSupplier);
  const quantity = num(userRequirements.quantity);

  const rated = suppliers.filter((s) => s.rating && (s.reviews || 0) > 0).map((s) => s.rating);
  const meanRating = rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : 4.0;

  const scored = suppliers.map((supplier) => {
    const c = criteria(supplier, meanRating);
    let wSum = 0;
    let total = 0;
    const breakdown = Object.keys(TRUST_WEIGHTS).map((key) => {
      const { score, detail } = c[key];
      if (score !== null) {
        wSum += TRUST_WEIGHTS[key];
        total += TRUST_WEIGHTS[key] * score;
      }
      return { key, label: LABELS[key], weight: TRUST_WEIGHTS[key], score, detail };
    });
    const trustScore = wSum ? Math.round(total / wSum) : 0;
    const available = breakdown.filter((b) => b.score !== null).length;
    const trustLevel =
      trustScore >= FILTERS.levelA ? "A" : trustScore >= FILTERS.levelB ? "B" : trustScore >= FILTERS.minTrust ? "C" : "D";

    // Short reasons shown on the card (strongest available signals)
    const reasons = breakdown
      .filter((b) => b.score !== null && b.score >= 50)
      .sort((a, b) => b.weight * b.score - a.weight * a.score)
      .slice(0, 3)
      .map((b) => b.detail);

    const rejectReason = getRejectReason(supplier, { trustScore, quantity });

    return {
      ...supplier,
      trustScore,
      trustLevel,
      trustBreakdown: breakdown,
      trustCoverage: { available, total: breakdown.length },
      trustReasons: reasons,
      aiScore: trustScore, // kept for older screens/caches
      isQualified: !rejectReason,
      rejectReason,
    };
  });

  // Order: trust level, then closeness to the client's product, then price
  const levelRank = { A: 3, B: 2, C: 1, D: 0 };
  return scored.sort(
    (a, b) =>
      levelRank[b.trustLevel] - levelRank[a.trustLevel] ||
      (b.relevance ?? 0) - (a.relevance ?? 0) ||
      (a.price > 0 ? a.price : Infinity) - (b.price > 0 ? b.price : Infinity) ||
      b.trustScore - a.trustScore,
  );
}

// First mandatory filter the supplier fails, in Spanish (shown to the user), or null
function getRejectReason(s, { trustScore, quantity }) {
  const audited = s.verifiedSupplier === true;
  const years = s.yearsInBusiness || 0;
  if (!audited && !s.goldSupplier) {
    return "Sin verificación (no es proveedor verificado ni miembro Gold)";
  }
  if (!audited && years < FILTERS.minGoldYears) {
    return `Miembro Gold con menos de ${FILTERS.minGoldYears} años`;
  }
  if (s.rating && (s.reviews || 0) >= FILTERS.minReviewsForRating && s.rating < FILTERS.minRating) {
    return `Calificación ${s.rating.toFixed(1)} por debajo de ${FILTERS.minRating.toFixed(1)}`;
  }
  if (quantity > 0 && s.moq > quantity) {
    return `Pedido mínimo de ${s.moq.toLocaleString("en-US")} unidades, mayor a tu cantidad`;
  }
  if (trustScore < FILTERS.minTrust) {
    return `Índice referencial ${trustScore}/100, debajo del mínimo de ${FILTERS.minTrust}`;
  }
  return null;
}

// Alibaba lists every product separately, so one factory can appear many times.
// Keep only the first product per company (list is already in final order).
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
    // up to 20: the page re-orders by the specs the client asked for and shows the top 9
    topSuppliers:   qualified.slice(0, 20),
    filteredOut:    rejected.slice(0, 20).map((s) => ({
      name:   s.name,
      reason: s.rejectReason,
      rating: s.rating,
      aiScore: s.trustScore,
      trustScore: s.trustScore,
    })),
    totalAnalyzed:  scoredSuppliers.length,
    qualifiedCount: qualified.length,
    filteredCount:  rejected.length,   // real count (filteredOut list is capped at 20)
    // listings from a company already counted (dedupe), so the counts add up
    duplicateCount: scoredSuppliers.length - qualified.length - rejected.length,
    filters:        FILTERS,
    trustWeights:   TRUST_WEIGHTS,
  };
}
