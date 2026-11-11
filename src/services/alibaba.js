import axios from "axios";
import * as cheerio from "cheerio";
import { HttpsProxyAgent } from "https-proxy-agent";

// TLS stays verified for every service (Resend, Groq, Sheets…). Only the
// Oxylabs proxy agent below accepts its own certificate (rejectUnauthorized).

/* ─────────────────────────────────────────────
   Build Alibaba Search URL
───────────────────────────────────────────── */
function buildAlibabaSearchUrl(keyword) {
    const cleanKeyword = keyword
        .trim()
        .replace(/\s+/g, " ")
        .split(" ")
        .map(encodeURIComponent) // "&" or "#" in a keyword must not break the URL
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
const UNBLOCK_PAUSE_MS = parseInt(process.env.UNBLOCK_PAUSE_MS) || 6 * 3600 * 1000;
let unblockPausedUntil = 0;
/** For /health: which route answered the last live search, and whether the Web Unblocker is in use. */
export const searchRoute = { last: "", lastAt: null, unblocker: "unknown", parser: "" };

async function fetchAlibabaHtml(keyword, budgetMs = SEARCH_BUDGET_MS) {
  return fetchHtml(buildAlibabaSearchUrl(keyword), budgetMs, true);
}

// 10-11: the same route (Web Unblocker, then Scraper API) for any Alibaba page; `track` = a live search
// (only searches update the route shown in /health)
async function fetchHtml(url, budgetMs = SEARCH_BUDGET_MS, track = false) {
  const deadline = Date.now() + Math.min(budgetMs, SEARCH_BUDGET_MS);
  const remaining = () => deadline - Date.now();

  // ✅ 1) Try Oxylabs Web Unblocker proxy first (up to 3 retries)
  const ubUser = process.env.OXY_UNBLOCK_USER;
  const ubPass = process.env.OXY_UNBLOCK_PASS;
  // 02-11s: production logs show the Web Unblocker rejecting these credentials (401) on every search; the
  // Scraper API fallback answers. OXY_UNBLOCK_DISABLED=1 skips it, and after a 401/407 it is skipped for
  // UNBLOCK_PAUSE_MS so a rejected route adds no attempt or delay to each search.
  const unblockOff = process.env.OXY_UNBLOCK_DISABLED === "1" || Date.now() < unblockPausedUntil;

  if (ubUser && ubPass && !unblockOff) {
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
          if (track) Object.assign(searchRoute, { last: "web_unblocker", lastAt: new Date().toISOString(), unblocker: "ok" });
          console.log("✅ Web Unblocker successfully retrieved full Alibaba page!");
          return html;
        }

        console.warn(`⚠️ Unblocker attempt ${attempt} returned CAPTCHA or short HTML.`);
      } catch (e) {
        const status = e.response?.status;
        console.error(`❌ Unblocker attempt ${attempt} failed:`, status || e.message);
        // Bad credentials won't fix themselves on retry: go straight to the fallback
        if (status === 401 || status === 407) {
          unblockPausedUntil = Date.now() + UNBLOCK_PAUSE_MS;
          console.warn(`🔑 Web Unblocker rejected the credentials (OXY_UNBLOCK_USER/PASS) — skipped for ${Math.round(UNBLOCK_PAUSE_MS / 3600000)} h`);
          break;
        }
      }

      if (attempt < MAX_RETRIES && remaining() > 25000) {
        await sleep(1500 * attempt);
      }
    }

    console.warn("🛑 Web Unblocker exhausted all retries without clean HTML.");
  } else if (unblockOff) {
    console.log("⏭️ Web Unblocker skipped (disabled or credentials rejected recently) — using the Scraper API");
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
          if (track) Object.assign(searchRoute, { last: `scraper_api:${source}`, lastAt: new Date().toISOString(), unblocker: Date.now() < unblockPausedUntil ? "rejected_401" : process.env.OXY_UNBLOCK_DISABLED === "1" ? "disabled" : searchRoute.unblocker });
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
   02-11u: Rendered result cards (Alibaba's newer search page)
───────────────────────────────────────────── */
// Production logs (2026-11-04): the Scraper API returns the page (≈1 MB, no captcha) but the hydration JSON
// is gone ("Hydration marker not found"): the newer search page builds its cards in the browser. With
// render:"html" those cards come in the HTML, so they are read from the markup when the JSON is missing.
// Only what each card shows is read; a field the card doesn't show stays empty (never guessed). Class names
// are hashed and change, so nothing depends on them: a card is the smallest block whose product links all
// point to one product.
// The platform's "Verified" mark is an image without text; this is its file (seen 2026-11-04) or any image
// whose alt/title says "verified".
const VERIFIED_IMG = /H62868c75e7eb4fbba8f8eb600d749c2aR|verified/i;
export function extractOffersFromCards(html) {
    if (!html || typeof html !== "string") return null;
    let $;
    try {
        $ = cheerio.load(html);
    } catch {
        return null;
    }
    const groups = new Map();
    $('a[href*="/product-detail/"]').each((_i, a) => {
        const m = String($(a).attr("href") || "").match(/_(\d{6,})\.html/);
        if (!m) return;
        if (!groups.has(m[1])) groups.set(m[1], []);
        groups.get(m[1]).push(a);
    });
    const offers = [];
    for (const [productId, anchors] of groups) {
        // climb while the parent holds no other product's links
        let card = $(anchors[0]);
        for (;;) {
            const parent = card.parent();
            if (!parent.length || parent.is("body, html")) break;
            const other = parent.find('a[href*="/product-detail/"]').toArray().some((x) => !String($(x).attr("href") || "").includes(`_${productId}.html`));
            if (other) break;
            card = parent;
        }
        const text = (el) => $(el).text().replace(/\s+/g, " ").trim();
        // text with a space between elements ("Ltd." / "6 yrs" / "CN" are separate blocks)
        const spaced = (h) => cheerio.load(`<div>${String(h || "").replace(/></g, "> <")}</div>`).text().replace(/\s+/g, " ").trim();
        const PRICE = /(?:US\s?\$|\$)\s?[\d,]+(?:\.\d+)?(?:\s*-\s*(?:US\s?\$|\$)?\s?[\d,]+(?:\.\d+)?)?/;
        const MOQ = /(?:Min\.?\s*order|Pedido\s+m[ií]n(?:imo)?\.?)\s*:?\s*([\d,]+\s*[A-Za-zÀ-ÿ]+(?:\/[A-Za-z]+)?)/i;
        // title: the longest product link text that is not the price / order / rating line
        // 02-11v: only a link that STARTS with the price / order / rating / local price is that line; a title that
        // merely mentions "$99" or "min order" is still the title (before, such a card was dropped entirely).
        const isTitle = (t) => t.length > 12 && !/^(?:US\s?\$|\$)\s?\d/.test(t) && !/^(?:Min\.?\s*order|Pedido\s+m[ií]n)/i.test(t) && !/^\d(?:\.\d)?\s*\/\s*5/.test(t) && !/^(?:Q|GTQ)\s?[\d,]+/.test(t);
        const titleAnchor = anchors.filter((a) => isTitle(text(a))).sort((a, b) => text(b).length - text(a).length)[0];
        const title = titleAnchor ? text(titleAnchor) : "";
        if (!title) continue;
        // 02-11v: price, order, rating and reviews are read from the card WITHOUT the title ("2 years warranty",
        // "5/5 star", "$99" in a title are not the supplier's data), and the years only from the supplier block.
        $(titleAnchor).attr("data-sga-title", "1");
        const rest$ = cheerio.load(`<div>${card.html() || ""}</div>`);
        $(titleAnchor).removeAttr("data-sga-title");
        rest$("[data-sga-title]").remove();
        const all = spaced(rest$("div").first().html());
        const supplierLinks = card.find('a[href*=".en.alibaba.com"]').toArray();
        const supplierLink = supplierLinks.find((a) => text(a) && !/^\d+\s*(?:yrs?|years?|a[nñ]os?)\b/i.test(text(a)));
        const yearsText = supplierLinks.filter((a) => a !== supplierLink).map((a) => spaced($(a).html())).join(" ");
        const years = (yearsText.match(/(?:^|\s)(\d{1,2})\s*(?:yrs?|years?|a[nñ]os?)\b/i) || [])[1] || "";
        const rm = all.match(/(?:^|\s)(\d(?:\.\d)?)\s*\/\s*5(?:\.0)?\b/);
        const rating = rm && parseFloat(rm[1]) <= 5 ? rm[1] : "";
        const reviews = rating ? (all.match(/\/\s*5(?:\.0)?\s*\((\d+)\)/) || [])[1] || "" : "";
        const verified = card.find("img").toArray().some((i) => VERIFIED_IMG.test(`${$(i).attr("src") || ""} ${$(i).attr("alt") || ""} ${$(i).attr("title") || ""}`));
        const img = card.find("img").toArray().map((i) => String($(i).attr("src") || "")).find((src) => /_\d+x\d+\.(?:jpe?g|png|webp)$|\.(?:jpe?g|webp)$/i.test(src)) || "";
        const href = String($(anchors[0]).attr("href") || "");
        offers.push({
            productId,
            title,
            companyName: supplierLink ? text(supplierLink) : "",
            // only US$ prices: a price in another currency (a localized page) is left out, never read as dollars
            price: (all.match(PRICE) || [""])[0],
            moq: (all.match(MOQ) || [])[1] ? `${(all.match(MOQ) || [])[1]}` : "",
            goldSupplierYears: years ? `${years} yrs` : "",
            reviewScore: rating,
            reviewCount: reviews,
            mainImage: img.replace(/^https?:/, ""),
            productUrl: href.replace(/[?#].*$/, ""),
            supplierHref: supplierLink ? String($(supplierLink).attr("href") || "").replace(/[?#].*$/, "") : "",
            badges: verified ? [{ name: "Verified" }] : [],
            certifications: [],
        });
    }
    return offers.length ? { offerResultData: { offers } } : null;
}

/* ─────────────────────────────────────────────
   Normalize Price (Range → Average)
───────────────────────────────────────────── */
function normalizePrice(priceText) {
    // Reads "$0.02-0.05", "US$0.02 - 0.05", "$1,200.00"… (midpoint of a range)
    const nums = String(priceText || "")
        .replace(/,/g, "")
        .match(/\d+(?:\.\d+)?/g)
        ?.map(Number)
        .filter((n) => n > 0) ?? [];
    if (!nums.length) return 0;
    if (nums.length >= 2) return (nums[0] + nums[1]) / 2;
    return nums[0];
}

/* ─────────────────────────────────────────────
   Extract MOQ
───────────────────────────────────────────── */
// Sale unit from the minimum-order text ("Min. order: 100 sets" → "set").
// Alibaba prices are per this unit, which is not always one piece.
const SALE_UNITS = [
    ["set", /\bsets?\b/i], ["box", /\bbox(es)?\b/i], ["pack", /\bpacks?\b|\bpk\b/i],
    ["carton", /\bcartons?\b|\bctns?\b/i], ["dozen", /\bdozens?\b/i], ["pair", /\bpairs?\b/i],
    ["bag", /\bbags?\b/i], ["roll", /\brolls?\b/i], ["meter", /\bmeters?\b|\bm\b/i],
    ["kilogram", /\bkilograms?\b|\bkgs?\b/i], ["ton", /\btons?\b|\btonnes?\b/i],
    ["piece", /\bpieces?\b|\bpcs?\b|\bunits?\b/i],
];
function extractSaleUnit(text) {
    const t = String(text || "");
    for (const [unit, re] of SALE_UNITS) if (re.test(t)) return unit;
    return "";
}

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
            if (!product || typeof product !== "object") return null;
            // upstream fields can come as numbers, arrays or objects: text only from here
            const str = (v) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
            const rawTitle = decodeEntities(str(product.title));
            const cleanTitle = rawTitle.replace(/<[^>]+>/g, "").toLowerCase();

            const rel = calculateRelevance(rawTitle, keyword);
            if (!rel.ok) return null;
            const relevance = Math.round(rel.score * 100) / 100;

            return {
                id: index + 1,
                itemId: product.productId,
                name: decodeEntities(str(product.companyName)),
                productName: cleanTitle,
                productImage: str(product.mainImage).startsWith("//")
                    ? `https:${product.mainImage}`
                    : str(product.mainImage),
                images: (Array.isArray(product.multiImage) ? product.multiImage : [])
                    .map(str)
                    .filter(Boolean)
                    .map((img) => (img.startsWith("//") ? `https:${img}` : img)),
                // Real values only — null when Alibaba doesn't publish them
                rating: parseFloat(product.reviewScore) || null,
                reviews: parseInt(product.reviewCount) || 0,
                moq: extractMOQ(str(product.moq)),
                moqText: str(product.moq).slice(0, 60),
                saleUnit: extractSaleUnit(str(product.moq)),
                price: normalizePrice(str(product.price)),
                priceRange: str(product.price),
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
                productUrl: str(product.productUrl)
                    ? (str(product.productUrl).startsWith("http") ? str(product.productUrl) : `https:${str(product.productUrl)}`)
                    : "",
                storeUrl: str(product.supplierHref)
                    ? (str(product.supplierHref).startsWith("http") ? str(product.supplierHref) : `https:${str(product.supplierHref)}`)
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
async function searchAlibabaScraper({ keyword, relevanceKeyword, pageSize = 20, budgetMs }) {
    const html = await fetchAlibabaHtml(keyword, budgetMs);

    if (!html || html.length < 10000) {
        console.log("❌ HTML invalid or empty");
        return [];
    }

    // 02-11u: the hydration JSON first; the rendered cards when the page no longer has it
    let offerList = extractOfferList(html);
    if (offerList) searchRoute.parser = "hydration_json";
    if (!offerList) {
        offerList = extractOffersFromCards(html);
        if (offerList) searchRoute.parser = "result_cards";
        if (offerList) console.log(`🧩 Read ${offerList.offerResultData.offers.length} offers from the rendered result cards (no hydration JSON)`);
    }
    if (!offerList) {
        searchRoute.parser = "none"; // 02-11v: /health must not keep the reader of an earlier search
        console.log("❌ Hydration extraction failed (and no result cards in the page)");
        return [];
    }

    // 02-11s: titles are compared with the product words; the client's requirements added to the
    // platform query ("220v", "latex free") are checked separately (services/specGate.js)
    const suppliers = mapOffersToSuppliers(offerList, relevanceKeyword || keyword);
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
export async function searchSuppliers({ keyword, relevanceKeyword, pageSize = 20, budgetMs }) {
    return await searchAlibabaScraper({ keyword, relevanceKeyword, pageSize, budgetMs });
}

/* ─────────────────────────────────────────────
   10-11: packing size and weight of a listing
───────────────────────────────────────────── */
// The product page carries the supplier's «Packaging and delivery» data in its JSON:
//   "logisticInfo":{…"unitSize":"200X200X225","unitVolume":"","unitWeight":"2500.0"}  (cm, m³, kg; per selling unit)
// and, when that is empty, the spec attributes «Dimension (L*W*H)» (id 100008286) and «Weight (KG)» (id 225593355),
// which are the equipment's size (not packed). Language-independent: the ids and keys do not change.
function jsonStr(v) {
  try { return JSON.parse(`"${v}"`); } catch { return v; }
}

export function parseDims(raw, defaultUnit = "cm") {
  const str = String(raw || "").toLowerCase().replace(/,/g, ".");
  const nums = (str.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => n > 0);
  if (nums.length < 3) return 0;
  const [a, b, c] = nums;
  const unit = /mm/.test(str) ? "mm" : /cm/.test(str) ? "cm" : /\d\s*m\b|\bm$/.test(str) ? "m" : defaultUnit;
  const f = unit === "mm" ? 1000 : unit === "cm" ? 100 : 1;
  return (a / f) * (b / f) * (c / f);
}

const kgOf = (raw) => {
  const str = String(raw || "").toLowerCase().replace(/,/g, "");
  const n = parseFloat((str.match(/\d+(?:\.\d+)?/) || [""])[0]);
  if (!(n > 0)) return 0;
  return /\btons?\b|\bt\b|toneladas?/.test(str) ? n * 1000 : /\bg\b|gramos?/.test(str) && !/kg/.test(str) ? n / 1000 : n;
};

export function parsePackaging(html) {
  const h = String(html || "");
  const li = h.match(/"logisticInfo":\{[^{}]*\}/);
  const field = (k) => (li ? (li[0].match(new RegExp(`"${k}":"([^"]*)"`)) || [])[1] || "" : "");
  const batch = parseInt((h.match(/"tradeInfo":\{[^{}]*?"batchNum":(\d+)/) || [])[1]) || 1;
  const sizeTxt = jsonStr(field("unitSize"));
  let cbm = parseFloat(field("unitVolume")) || parseDims(sizeTxt, "cm");
  let kg = kgOf(field("unitWeight"));
  let source = "package";
  let text = sizeTxt ? `${sizeTxt} cm` : "";
  if (!(cbm > 0) && !(kg > 0)) {
    const attr = (id) => jsonStr((h.match(new RegExp(`"attrNameId":${id},"attrValue":"([^"]+)"`)) || [])[1] || "");
    const dim = attr(100008286);
    cbm = parseDims(dim, "mm");
    kg = kgOf(attr(225593355));
    source = "specs";
    text = dim;
  }
  const okCbm = cbm >= 0.0001 && cbm <= 500;
  const okKg = kg >= 0.01 && kg <= 100000;
  if (!okCbm && !okKg) return null;
  return {
    source,                                             // "package" = packed (supplier), "specs" = equipment size
    cbm: okCbm ? Math.round(cbm * 10000) / 10000 : 0,   // per selling batch
    kg: okKg ? Math.round(kg * 100) / 100 : 0,
    batch: batch > 0 && batch < 100000 ? batch : 1,      // units per package (1 unless the listing says so)
    text: String(text).slice(0, 60),
  };
}

const PRODUCT_URL = /^https:\/\/(?:www\.)?alibaba\.com\/product-detail\/[A-Za-z0-9._%-]+_(\d{6,20})\.html$/;
export function productIdFromUrl(raw) {
  let u = String(raw || "").trim().replace(/[?#].*$/, "");
  if (u.startsWith("//")) u = `https:${u}`;
  const m = u.match(PRODUCT_URL);
  return m ? { url: u, id: m[1] } : null;
}

export async function fetchProductPackaging(url, budgetMs = 45000) {
  const html = await fetchHtml(url, budgetMs, false);
  return html ? parsePackaging(html) : null;
}
