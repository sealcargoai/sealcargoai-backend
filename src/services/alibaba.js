import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

// Ensure Node TLS unauthorized connections are allowed for Oxylabs proxies
if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
}

/* ─────────────────────────────────────────────
   Build Alibaba Search URL
───────────────────────────────────────────── */
function buildAlibabaSearchUrl(keyword) {
    const cleanKeyword = keyword
        .trim()
        .replace(/\s+/g, " ")
        .split(" ")
        .join("+");

    return `https://www.alibaba.com/trade/search?spm=a27aq.404error.the-new-header_fy23_pc_search_bar.keydown__Enter&tab=all&SearchText=${cleanKeyword}&has4Tab=true`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ─────────────────────────────────────────────
   Fetch HTML From Oxylabs
───────────────────────────────────────────── */
// Whole search must finish within this budget so the client never waits
// indefinitely (the frontend gives up a bit later and offers a way out).
const SEARCH_BUDGET_MS = parseInt(process.env.SEARCH_BUDGET_MS) || 75000;

async function fetchAlibabaHtml(keyword, budgetMs = SEARCH_BUDGET_MS) {
  const url = buildAlibabaSearchUrl(keyword);
  const deadline = Date.now() + Math.min(budgetMs, SEARCH_BUDGET_MS);
  const remaining = () => deadline - Date.now();

  // ✅ 1) Try Oxylabs Web Unblocker proxy first (up to 3 retries)
  const ubUser = process.env.OXY_UNBLOCK_USER;
  const ubPass = process.env.OXY_UNBLOCK_PASS;

  if (ubUser && ubPass) {
    console.log("🛡️ Attempting Oxylabs Web Unblocker Proxy");

    // Try both raw and URL-encoded credentials for maximum proxy auth compatibility
    const proxyUrls = [
      `https://${ubUser}:${ubPass}@unblock.oxylabs.io:60000`,
      `https://${encodeURIComponent(ubUser)}:${encodeURIComponent(ubPass)}@unblock.oxylabs.io:60000`,
      `http://${ubUser}:${ubPass}@unblock.oxylabs.io:60000`
    ];

    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (remaining() < 20000) break; // keep time for the Scraper API fallback
      const proxyUrl = proxyUrls[(attempt - 1) % proxyUrls.length];
      try {
        console.log(`🛡️ Web Unblocker attempt ${attempt}/${MAX_RETRIES}...`);
        
        const agent = new HttpsProxyAgent(proxyUrl);
        agent.options.rejectUnauthorized = false;

        const resp = await axios.get(url, {
          httpsAgent: agent,
          proxy: false,
          timeout: Math.max(5000, Math.min(30000, remaining() - 20000)),
          responseType: "text",
          transformResponse: (r) => r,
          headers: {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
            "Accept-Language": "en-US,en;q=0.9",
            Accept:
              "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            Referer: "https://www.alibaba.com/",
          },
        });

        const html = resp.data || "";
        const isCaptcha =
          html.length < 200000 ||
          html.includes("nocaptcha") ||
          html.includes("cf.aliyun.com/nocaptcha");

        console.log(`📄 HTML size (Unblocker attempt ${attempt}): ${html.length} bytes | Captcha: ${isCaptcha}`);

        if (!isCaptcha) {
          console.log("✅ Web Unblocker successfully retrieved full Alibaba page!");
          return html;
        }

        console.warn(`⚠️ Unblocker attempt ${attempt} returned CAPTCHA or short HTML.`);
      } catch (e) {
        const status = e.response?.status;
        console.error(`❌ Unblocker attempt ${attempt} failed:`, status || e.message);
        // Bad credentials won't fix themselves on retry: go straight to the fallback
        if (status === 401 || status === 407) {
          console.warn("🔑 Web Unblocker rejected the credentials (OXY_UNBLOCK_USER/PASS) — skipping retries");
          break;
        }
      }

      if (attempt < MAX_RETRIES && remaining() > 25000) {
        await sleep(1500 * attempt);
      }
    }

    console.warn("🛑 Web Unblocker exhausted all retries without clean HTML.");
  } else {
    console.log("⚠️ Missing OXY_UNBLOCK_USER/OXY_UNBLOCK_PASS (skipping Web Unblocker proxy)");
  }

  // ✅ 2) Fallback to Oxylabs Web Scraper API
  const username = process.env.OXY_USER;
  const password = process.env.OXY_PASS;

  if (!username || !password) {
    console.log("⚠️ Missing Oxylabs Scraper API credentials");
    return null;
  }

  // Test universal_ecommerce first (with residential proxy), then alibaba
  const scraperSources = [
    { source: "universal_ecommerce", proxy_type: "residential" },
    { source: "alibaba", proxy_type: undefined }
  ];

  for (const { source, proxy_type } of scraperSources) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (remaining() < 8000) {
        console.warn(`⏱️ Search time budget used up (${SEARCH_BUDGET_MS / 1000}s) — returning no results`);
        return null;
      }
      try {
        console.log(`🔄 Fallback: Oxylabs Web Scraper API (source: '${source}', attempt ${attempt}/2)`);
        
        const payload = {
          source,
          url,
          geo_location: "United States",
          render: "html",
          user_agent_type: "desktop"
        };

        if (proxy_type) {
          payload.proxy_type = proxy_type;
        }

        const response = await axios.post(
          "https://realtime.oxylabs.io/v1/queries",
          payload,
          {
            auth: { username, password },
            timeout: Math.min(60000, remaining()),
          }
        );

        const html = response.data?.results?.[0]?.content || "";
        const isCaptcha =
          html.length < 200000 ||
          html.includes("nocaptcha") ||
          html.includes("cf.aliyun.com/nocaptcha");

        console.log(`📄 Scraper API HTML size ('${source}' attempt ${attempt}): ${html.length} bytes | Captcha: ${isCaptcha}`);

        if (html && !isCaptcha) {
          console.log(`✅ Web Scraper API ('${source}') returned clean HTML!`);
          return html;
        }
      } catch (err) {
        console.error(`❌ Scraper API ('${source}' attempt ${attempt}) failed:`, err.response?.data?.error || err.message);
      }

      if (remaining() > 10000) await sleep(1000);
    }
  }

  return null;
}

/* ─────────────────────────────────────────────
   Extract Hydration JSON
───────────────────────────────────────────── */
function extractOfferList(html) {
    if (!html) return null;

    const markers = [
        "window.__page__data_sse10._offer_list",
        "window.__page__data_sse._offer_list",
        "window.__page__data._offer_list",
        "_offer_list"
    ];

    let startIndex = -1;
    let matchedMarker = "";

    for (const m of markers) {
        const idx = html.indexOf(m);
        if (idx !== -1) {
            startIndex = idx;
            matchedMarker = m;
            break;
        }
    }

    if (startIndex === -1) {
        console.log("❌ Hydration marker not found in HTML");
        return null;
    }

    console.log(`🔍 Hydration marker found: "${matchedMarker}"`);

    const firstBrace = html.indexOf("{", startIndex);
    if (firstBrace === -1) return null;

    let braceCount = 0;
    let endIndex = -1;

    for (let i = firstBrace; i < html.length; i++) {
        if (html[i] === "{") braceCount++;
        if (html[i] === "}") braceCount--;
        if (braceCount === 0) {
            endIndex = i;
            break;
        }
    }

    if (endIndex === -1) return null;

    const jsonString = html.substring(firstBrace, endIndex + 1);

    try {
        return JSON.parse(jsonString);
    } catch (e) {
        console.error("❌ Hydration JSON parse failed:", e.message);
        return null;
    }
}

/* ─────────────────────────────────────────────
   Normalize Price (Range → Average)
───────────────────────────────────────────── */
function normalizePrice(priceText) {
    if (!priceText) return 0;

    const clean = priceText.replace(/\$/g, "").replace(/,/g, "").trim();

    if (clean.includes("-")) {
        const parts = clean.split("-").map(p => parseFloat(p));
        if (parts.length === 2) {
            return (parts[0] + parts[1]) / 2;
        }
        return parts[0] || 0;
    }

    return parseFloat(clean) || 0;
}

/* ─────────────────────────────────────────────
   Extract MOQ
───────────────────────────────────────────── */
function extractMOQ(text) {
    if (!text) return 1;
    const match = text.replace(/,/g, "").match(/\d+/);
    return match ? parseInt(match[0]) : 1;
}

/* ─────────────────────────────────────────────
   Fuzzy Relevance Scoring
───────────────────────────────────────────── */
// Generic words appear in almost every Alibaba title ("machine", "industrial"…),
// so they don't prove the product is the one the client described.
const GENERIC_WORDS = new Set([
    "machine", "machines", "machinery", "industrial", "industry", "equipment", "equipments",
    "product", "products", "supplier", "suppliers", "manufacturer", "factory", "wholesale",
    "high", "quality", "new", "best", "hot", "sale", "selling", "automatic", "auto", "full",
    "commercial", "professional", "custom", "customized", "small", "large", "mini", "big",
    "multi", "function", "multifunctional", "type", "model", "for", "and", "the", "of", "with",
    "in", "a", "an", "to", "use", "used", "price", "cheap", "china", "chinese", "good",
]);

// Light stemming so "processing" / "processor" / "processors" compare as "process"
const normWord = (w) => {
    let x = w.replace(/[^a-z0-9]/g, "");
    if (x.length > 4) x = x.replace(/ies$/, "y").replace(/(es|s)$/, "");
    if (x.length > 5) x = x.replace(/(ing|ion|ors|or|ers|er|ed)$/, "");
    return x;
};

/**
 * Share of the meaningful keyword terms found in the product title (0..1).
 * ok = enough of the meaningful terms appear to call it the same product:
 * all of them when there are 1-2, at least 60% when there are more.
 */
// Alibaba titles come HTML-escaped ("&amp;", "&#39;")
function decodeEntities(t) {
    return String(t)
        .replace(/&nbsp;/g, " ")
        .replace(/&quot;/g, '"')
        .replace(/&#0*39;|&apos;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)))
        .replace(/&amp;/g, "&");
}

function calculateRelevance(title, keyword) {
    const cleanTitle = title.replace(/<[^>]+>/g, "").toLowerCase();
    const titleWords = new Set(cleanTitle.split(/[^a-z0-9]+/).filter(Boolean).map(normWord));
    const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
    let terms = [...new Set(words.filter((w) => !GENERIC_WORDS.has(w)).map(normWord).filter(Boolean))];
    if (!terms.length) terms = [...new Set(words.map(normWord).filter(Boolean))];
    if (!terms.length) return { score: 0, ok: false };

    const hits = terms.filter((t) => titleWords.has(t) || cleanTitle.includes(t)).length;
    const share = hits / terms.length;
    const needed = terms.length <= 2 ? 1 : 0.6;
    const phraseBonus = cleanTitle.includes(keyword.toLowerCase()) ? 0.1 : 0;
    return { score: Math.min(1, share + phraseBonus), ok: share >= needed };
}

/* ─────────────────────────────────────────────
   Map Offers → Suppliers
───────────────────────────────────────────── */
// Logs only the FIELD NAMES of the first offers (plus values of trust-related
// fields, which are public supplier data) so we can map Verified Supplier,
// Trade Assurance, on-time delivery, etc. Runs for the first 3 searches per boot.
let fieldLogsLeft = 5;
const TRUST_KEY = /verif|assess|audit|trade|assur|deliver|ontime|response|reorder|repurchase|level|star|gold|year|transaction|service|tag|badge|cert|crown|score|lyb/i;
function logOfferFields(offers) {
    if (fieldLogsLeft <= 0 || !offers.length) return;
    fieldLogsLeft -= 1;
    try {
        const o = offers[0];
        const describe = (obj) =>
            Object.keys(obj || {}).map((k) => {
                const v = obj[k];
                const t = Array.isArray(v) ? "array" : typeof v;
                return t === "object" && v ? `${k}{${Object.keys(v).slice(0, 25).join(",")}}` : `${k}:${t}`;
            }).join(" | ");
        console.log("🔎 Alibaba offer fields:", describe(o).slice(0, 4000));
        const trust = {};
        for (const off of offers.slice(0, 5)) {
            for (const [k, v] of Object.entries(off)) {
                if (TRUST_KEY.test(k) && (typeof v !== "object" || v === null || Array.isArray(v))) {
                    (trust[k] ||= []).push(Array.isArray(v) ? JSON.stringify(v).slice(0, 120) : v);
                }
            }
        }
        console.log("🔎 Alibaba trust-related values:", JSON.stringify(trust).slice(0, 4000));
    } catch (e) {
        console.log("🔎 field log failed:", e.message);
    }
}

// Collects every "name" found inside Alibaba's icon/badge structures
// (e.g. certifications: [{prefixIcons:[{name:"CE", url:...}]}])
function collectNames(value, out = new Set(), depth = 0) {
    if (depth > 5 || value == null) return out;
    if (typeof value === "string") {
        const tr = value.trim();
        if (tr.startsWith("[") || tr.startsWith("{")) {
            try { collectNames(JSON.parse(value), out, depth + 1); } catch { /* not JSON */ }
        }
        return out;
    }
    if (Array.isArray(value)) { value.forEach((v) => collectNames(v, out, depth + 1)); return out; }
    if (typeof value === "object") {
        for (const [k, v] of Object.entries(value)) {
            if ((k === "name" || k === "text" || k === "title") && typeof v === "string" && v.trim() && v.length < 60) out.add(v.trim());
            else collectNames(v, out, depth + 1);
        }
    }
    return out;
}

function mapOffersToSuppliers(offerList, keyword) {
    const offers = offerList?.offerResultData?.offers || [];
    logOfferFields(offers);

    return offers
        .map((product, index) => {
            const rawTitle = decodeEntities(product.title || "");
            const cleanTitle = rawTitle.replace(/<[^>]+>/g, "").toLowerCase();

            const rel = calculateRelevance(rawTitle, keyword);
            if (!rel.ok) return null;
            const relevance = Math.round(rel.score * 100) / 100;

            return {
                id: index + 1,
                itemId: product.productId,
                name: decodeEntities(product.companyName || ""),
                productName: cleanTitle,
                productImage: product.mainImage?.startsWith("//")
                    ? `https:${product.mainImage}`
                    : product.mainImage,
                images: product.multiImage?.map(img =>
                    img.startsWith("//") ? `https:${img}` : img
                ) || [],
                // Real values only — null when Alibaba doesn't publish them
                rating: parseFloat(product.reviewScore) || null,
                reviews: parseInt(product.reviewCount) || 0,
                moq: extractMOQ(product.moq),
                price: normalizePrice(product.price),
                priceRange: product.price,
                verified: !!product.goldSupplierYears,
                location: product.countryCode || "CN",
                yearsInBusiness:
                    parseInt(String(product.goldSupplierYears || "").match(/\d+/)?.[0]) || 0,
                responseRate: null, // not available in Alibaba search results
                tags: [],
                // Trust data published in the search result
                storeRating: parseFloat(product.supplierServiceScore) || null, // supplier service score (0-5)
                certifications: [...collectNames(product.certifications)].slice(0, 8), // declared by the supplier
                badges: [...collectNames(product.badges)].slice(0, 8),
                // Verified only when Alibaba's own badge says so; otherwise unknown
                verifiedSupplier: [...collectNames(product.badges)].some((b) => /verified/i.test(b)) ? true : null,
                tradeAssurance: null, // not published in search results
                goldSupplier: !!product.goldSupplierYears,
                contactEmail: "",
                contactPhone: "",
                productUrl: product.productUrl
                    ? `https:${product.productUrl}`
                    : "",
                storeUrl: product.supplierHref
                    ? `https:${product.supplierHref}`
                    : "",
                relevance
            };
        })
        .filter(Boolean)
        .sort((a, b) => b.relevance - a.relevance);
}

/* ─────────────────────────────────────────────
   Main Scraper
───────────────────────────────────────────── */
async function searchAlibabaScraper({ keyword, pageSize = 20, budgetMs }) {
    const html = await fetchAlibabaHtml(keyword, budgetMs);

    if (!html || html.length < 10000) {
        console.log("❌ HTML invalid or empty");
        return [];
    }

    const offerList = extractOfferList(html);
    if (!offerList) {
        console.log("❌ Hydration extraction failed");
        return [];
    }

    const suppliers = mapOffersToSuppliers(offerList, keyword);
    const offerCount = offerList?.offerResultData?.offers?.length || 0;
    console.log(`✅ Mapped ${suppliers.length} related suppliers of ${offerCount} offers for keyword "${keyword}"`);

    const result = suppliers.slice(0, pageSize);
    // The platform returned products, but none matched the client's product
    result.offerCount = offerCount;
    return result;
}

/* ─────────────────────────────────────────────
   Export
───────────────────────────────────────────── */
export async function searchSuppliers({ keyword, pageSize = 20, budgetMs }) {
    return await searchAlibabaScraper({ keyword, pageSize, budgetMs });
}