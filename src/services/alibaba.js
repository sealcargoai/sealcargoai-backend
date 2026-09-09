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
async function fetchAlibabaHtml(keyword) {
  const url = buildAlibabaSearchUrl(keyword);

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
      const proxyUrl = proxyUrls[(attempt - 1) % proxyUrls.length];
      try {
        console.log(`🛡️ Web Unblocker attempt ${attempt}/${MAX_RETRIES}...`);
        
        const agent = new HttpsProxyAgent(proxyUrl);
        agent.options.rejectUnauthorized = false;

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
        console.error(
          `❌ Unblocker attempt ${attempt} failed:`,
          e.response?.status || e.message
        );
      }

      if (attempt < MAX_RETRIES) {
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
            timeout: 60000,
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

      await sleep(1000);
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
function calculateRelevance(title, keyword) {
    const cleanTitle = title.replace(/<[^>]+>/g, "").toLowerCase();
    const keywordWords = keyword.toLowerCase().split(/\s+/).filter(Boolean);

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
        console.log("❌ HTML invalid or empty");
        return [];
    }

    const offerList = extractOfferList(html);
    if (!offerList) {
        console.log("❌ Hydration extraction failed");
        return [];
    }

    const suppliers = mapOffersToSuppliers(offerList, keyword);
    console.log(`✅ Scraped and mapped ${suppliers.length} suppliers for keyword "${keyword}"`);

    return suppliers.slice(0, pageSize);
}

/* ─────────────────────────────────────────────
   Export
───────────────────────────────────────────── */
export async function searchSuppliers({ keyword, pageSize = 20 }) {
    return await searchAlibabaScraper({ keyword, pageSize });
}