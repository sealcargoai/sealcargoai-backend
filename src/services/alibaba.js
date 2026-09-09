import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

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

/* ─────────────────────────────────────────────
   Fetch HTML From Oxylabs
───────────────────────────────────────────── */
async function fetchAlibabaHtml(keyword) {
  const url = buildAlibabaSearchUrl(keyword);

  // ✅ 1) Try Web Unblocker proxy first
  const ubUser = process.env.OXY_UNBLOCK_USER;
  const ubPass = process.env.OXY_UNBLOCK_PASS;

  if (ubUser && ubPass) {
    console.log("🛡️ Using Oxylabs Web Unblocker");

    const proxyUrl = `https://${encodeURIComponent(ubUser)}:${encodeURIComponent(
      ubPass
    )}@unblock.oxylabs.io:60000`;

    const agent = new HttpsProxyAgent(proxyUrl);

    // extra safety (still recommend NODE_TLS_REJECT_UNAUTHORIZED=0 in env)
    agent.options.rejectUnauthorized = false;

    try {
      const resp = await axios.get(url, {
        httpsAgent: agent,
        proxy: false,
        timeout: 60000,
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
        html.includes("nocaptcha") ||
        html.includes("cf.aliyun.com/nocaptcha") ||
        html.length < 200000;

      console.log(`📄 HTML size (unblocker): ${html.length}`);
      console.log(`🧪 Captcha? ${isCaptcha}`);

      if (!isCaptcha) return html;

      console.log("🛑 Unblocker returned captcha HTML (will fallback).");
    } catch (e) {
      console.error(
        "❌ Unblocker fetch failed:",
        e.response?.status,
        e.response?.data || e.message
      );
    }
  } else {
    console.log("⚠️ Missing OXY_UNBLOCK_USER/OXY_UNBLOCK_PASS (skipping unblocker)");
  }

  // ✅ 2) Fallback to your old Web Scraper API (might captcha)
  const username = process.env.OXY_USER;
  const password = process.env.OXY_PASS;

  if (!username || !password) {
    console.log("⚠️ Missing Oxylabs Scraper API credentials");
    return null;
  }

  console.log("🔄 Falling back to Oxylabs Web Scraper API");
  const response = await axios.post(
    "https://realtime.oxylabs.io/v1/queries",
    {
      source: "universal_ecommerce",
      url,
      geo_location: "United States",
      render: "html",
      user_agent_type: "desktop",
      proxy_type: "residential",
    },
    {
      auth: { username, password },
      timeout: 60000,
    }
  );

  return response.data?.results?.[0]?.content || null;
}

/* ─────────────────────────────────────────────
   Extract Hydration JSON
───────────────────────────────────────────── */
function extractOfferList(html) {
    if (!html) return null;

    const marker = "window.__page__data_sse10._offer_list";
    const startIndex = html.indexOf(marker);

    if (startIndex === -1) {
        console.log("❌ Hydration marker not found");
        return null;
    }

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
    } catch {
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
function calculateRelevance(title, keyword) {
    const cleanTitle = title.replace(/<[^>]+>/g, "").toLowerCase();
    const keywordWords = keyword.toLowerCase().split(" ");

    let score = 0;

    keywordWords.forEach(word => {
        if (cleanTitle.includes(word)) score += 1;
    });

    return score;
}

/* ─────────────────────────────────────────────
   Map Offers → Suppliers
───────────────────────────────────────────── */
function mapOffersToSuppliers(offerList, keyword) {
    const offers = offerList?.offerResultData?.offers || [];

    return offers
        .map((product, index) => {
            const rawTitle = product.title || "";
            const cleanTitle = rawTitle.replace(/<[^>]+>/g, "").toLowerCase();

            const relevance = calculateRelevance(rawTitle, keyword);

            if (relevance === 0) return null;

            return {
                id: index + 1,
                itemId: product.productId,
                name: product.companyName,
                productName: cleanTitle,
                productImage: product.mainImage?.startsWith("//")
                    ? `https:${product.mainImage}`
                    : product.mainImage,
                images: product.multiImage?.map(img =>
                    img.startsWith("//") ? `https:${img}` : img
                ) || [],
                rating: parseFloat(product.reviewScore) || 4.3,
                reviews: parseInt(product.reviewCount) || 0,
                moq: extractMOQ(product.moq),
                price: normalizePrice(product.price),
                priceRange: product.price,
                verified: !!product.goldSupplierYears,
                location: product.countryCode || "CN",
                yearsInBusiness:
                    parseInt(product.goldSupplierYears?.match(/\d+/)?.[0]) || 1,
                responseRate: 85,
                tags: [],
                tradeAssurance: false,
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
async function searchAlibabaScraper({ keyword, pageSize = 20 }) {
    const html = await fetchAlibabaHtml(keyword);

    if (!html || html.length < 10000) {
        console.log("❌ HTML invalid");
        return [];
    }

    const offerList = extractOfferList(html);
    if (!offerList) {
        console.log("❌ Hydration extraction failed");
        return [];
    }

    const suppliers = mapOffersToSuppliers(offerList, keyword);

    return suppliers.slice(0, pageSize);
}

/* ─────────────────────────────────────────────
   Export
───────────────────────────────────────────── */
export async function searchSuppliers({ keyword, pageSize = 20 }) {
    return await searchAlibabaScraper({ keyword, pageSize });
}