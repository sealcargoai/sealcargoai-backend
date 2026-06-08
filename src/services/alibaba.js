import axios from "axios";

/* ─────────────────────────────────────────────
   Build Alibaba Search URL
───────────────────────────────────────────── */
function buildAlibabaSearchUrl(keyword) {
    const plusFormatted = keyword.trim().split(" ").join("+");

    return `https://www.alibaba.com/trade/search?spm=a27aq.404error.the-new-header_fy23_pc_search_bar.keydown__Enter&tab=all&SearchText=${plusFormatted}&has4Tab=true`;
}

/* ─────────────────────────────────────────────
   Fetch HTML From Oxylabs
───────────────────────────────────────────── */
async function fetchAlibabaHtml(keyword) {
    const username = process.env.OXY_USER;
    const password = process.env.OXY_PASS;

    if (!username || !password) {
        console.log("⚠️ Missing Oxylabs credentials");
        return null;
    }

    const url = buildAlibabaSearchUrl(keyword);

    const response = await axios.post(
        "https://realtime.oxylabs.io/v1/queries",
        {
            source: "universal_ecommerce",
            url,
            geo_location: "United States",
            render: "html",
            user_agent_type: "desktop"
        },
        {
            auth: { username, password },
            timeout: 60000,
        }
    );

    return response.data?.results?.[0]?.content || null;
}

/* ─────────────────────────────────────────────
   Extract Hydration JSON (Brace Counter Safe)
───────────────────────────────────────────── */
function extractOfferList(html) {
    if (!html) return null;

    const marker = "window.__page__data_sse10._offer_list";
    const startIndex = html.indexOf(marker);

    if (startIndex === -1) {
        console.log("❌ Hydration marker not found");
        return null;
    }

    // Find first { after marker
    const firstBrace = html.indexOf("{", startIndex);
    if (firstBrace === -1) {
        console.log("❌ Opening brace not found");
        return null;
    }

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

    if (endIndex === -1) {
        console.log("❌ Closing brace not found");
        return null;
    }

    const jsonString = html.substring(firstBrace, endIndex + 1);

    try {
        return JSON.parse(jsonString);
    } catch (err) {
        console.log("❌ JSON parse failed:", err.message);
        return null;
    }
}

/* ─────────────────────────────────────────────
   Convert Price Range → Average Number
───────────────────────────────────────────── */
function normalizePrice(priceText) {
    if (!priceText) return 0;

    const clean = priceText.replace(/\$/g, "").replace(/,/g, "").trim();

    if (clean.includes("-")) {
        const parts = clean.split("-").map(p => parseFloat(p));
        const valid = parts.filter(n => !isNaN(n));
        if (valid.length === 2) {
            return (valid[0] + valid[1]) / 2;
        }
        return valid[0] || 0;
    }

    const single = parseFloat(clean);
    return isNaN(single) ? 0 : single;
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
   Map Offers → Suppliers
───────────────────────────────────────────── */
function mapOffersToSuppliers(offerList, keyword) {
    const offers = offerList?.offerResultData?.offers || [];
    const keywordWords = keyword.toLowerCase().split(" ");

    return offers
        .map((product, index) => {
            const rawTitle = product.title || "";
            const cleanTitle = rawTitle.replace(/<[^>]+>/g, "").toLowerCase();

            let relevance = 0;
            keywordWords.forEach(word => {
                if (cleanTitle.includes(word)) relevance++;
            });

            if (relevance === 0) return null;

            const price = normalizePrice(product.price);
            const moq = extractMOQ(product.moq);

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
                moq,
                price,
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
    console.log("🟡 STEP 1: Fetching HTML...");

    const html = await fetchAlibabaHtml(keyword);

    if (!html) {
        console.log("❌ HTML not returned");
        return [];
    }

    const offerList = extractOfferList(html);

    if (!offerList) {
        console.log("❌ Hydration extraction failed");
        return [];
    }

    const offers = offerList?.offerResultData?.offers || [];

    console.log("🟡 Sample first 3 titles:");
    offers.slice(0, 3).forEach((o, i) => {
        console.log(`   ${i + 1}.`, o.title);
    });


    const suppliers = mapOffersToSuppliers(offerList, keyword);


    if (suppliers.length > 0) {
        console.log("🟢 First relevant title:", suppliers[0].productName);
    }

    return suppliers.slice(0, pageSize);
}


// ── Mock fallback ─────────────────────────────────────────────────────────────
function getMockData() {
    console.log("📦 Using mock supplier data");
    return [
        {
            id: 1,
            name: "Guangzhou Premium Furniture Co., Ltd",
            productName: "Premium Solid Wood Furniture Collection",
            rating: 4.8,
            reviews: 1247,
            moq: 500,
            price: 45.5,
            verified: true,
            location: "China",
            yearsInBusiness: 12,
            responseRate: 98,
            tags: ["Gold Supplier", "Verified", "Trade Assurance"],
            tradeAssurance: true,
            goldSupplier: true,
            contactEmail: "",
            contactPhone: "",
            productImage:
                "https://images.unsplash.com/photo-1503602642458-232111445657?w=400&h=300&fit=crop",
            images: [
                "https://images.unsplash.com/photo-1503602642458-232111445657?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1519947486511-46149fa0a254?w=400&h=300&fit=crop",
            ],
            productUrl: "",
            storeUrl: "",
        },
        {
            id: 2,
            name: "Shanghai Wooden Products Factory",
            productName: "Eco-Friendly Wood Products",
            rating: 4.6,
            reviews: 892,
            moq: 300,
            price: 42.0,
            verified: true,
            location: "China",
            yearsInBusiness: 8,
            responseRate: 95,
            tags: ["Verified", "Trade Assurance"],
            tradeAssurance: true,
            goldSupplier: false,
            contactEmail: "",
            contactPhone: "",
            productImage:
                "https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400&h=300&fit=crop",
            images: [
                "https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1503602642458-232111445657?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=400&h=300&fit=crop",
            ],
            productUrl: "",
            storeUrl: "",
        },
        {
            id: 3,
            name: "Foshan Elite Furniture Manufacturing",
            productName: "Elite Custom Furniture",
            rating: 4.9,
            reviews: 2134,
            moq: 1000,
            price: 38.75,
            verified: true,
            location: "China",
            yearsInBusiness: 15,
            responseRate: 99,
            tags: ["Gold Supplier", "Verified", "Audited"],
            tradeAssurance: true,
            goldSupplier: true,
            contactEmail: "",
            contactPhone: "",
            productImage:
                "https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400&h=300&fit=crop",
            images: [
                "https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1517705008128-361805f42e86?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1519947486511-46149fa0a254?w=400&h=300&fit=crop",
            ],
            productUrl: "",
            storeUrl: "",
        },
        {
            id: 4,
            name: "Shenzhen Modern Chairs Ltd",
            productName: "Modern Ergonomic Chairs",
            rating: 4.5,
            reviews: 567,
            moq: 200,
            price: 48.2,
            verified: true,
            location: "China",
            yearsInBusiness: 6,
            responseRate: 92,
            tags: ["Verified"],
            tradeAssurance: false,
            goldSupplier: false,
            contactEmail: "",
            contactPhone: "",
            productImage:
                "https://images.unsplash.com/photo-1519947486511-46149fa0a254?w=400&h=300&fit=crop",
            images: [
                "https://images.unsplash.com/photo-1519947486511-46149fa0a254?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1503602642458-232111445657?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=400&h=300&fit=crop",
            ],
            productUrl: "",
            storeUrl: "",
        },
        {
            id: 5,
            name: "Dongguan Quality Furniture Group",
            productName: "Quality Hardwood Furniture",
            rating: 4.7,
            reviews: 1456,
            moq: 800,
            price: 40.3,
            verified: true,
            location: "China",
            yearsInBusiness: 10,
            responseRate: 96,
            tags: ["Gold Supplier", "Trade Assurance"],
            tradeAssurance: true,
            goldSupplier: true,
            contactEmail: "",
            contactPhone: "",
            productImage:
                "https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=400&h=300&fit=crop",
            images: [
                "https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1517705008128-361805f42e86?w=400&h=300&fit=crop",
            ],
            productUrl: "",
            storeUrl: "",
        },
        {
            id: 6,
            name: "Hangzhou Premium Wood Products",
            productName: "Premium Wood Range",
            rating: 4.8,
            reviews: 1089,
            moq: 600,
            price: 44.8,
            verified: true,
            location: "China",
            yearsInBusiness: 9,
            responseRate: 97,
            tags: ["Verified", "Audited"],
            tradeAssurance: false,
            goldSupplier: false,
            contactEmail: "",
            contactPhone: "",
            productImage:
                "https://images.unsplash.com/photo-1517705008128-361805f42e86?w=400&h=300&fit=crop",
            images: [
                "https://images.unsplash.com/photo-1517705008128-361805f42e86?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1503602642458-232111445657?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1519947486511-46149fa0a254?w=400&h=300&fit=crop",
            ],
            productUrl: "",
            storeUrl: "",
        },
        {
            id: 7,
            name: "Ningbo Furniture Export Center",
            productName: "Export Grade Furniture",
            rating: 4.6,
            reviews: 734,
            moq: 350,
            price: 46.5,
            verified: true,
            location: "China",
            yearsInBusiness: 7,
            responseRate: 94,
            tags: ["Gold Supplier", "Verified"],
            tradeAssurance: false,
            goldSupplier: true,
            contactEmail: "",
            contactPhone: "",
            productImage:
                "https://images.unsplash.com/photo-1503602642458-232111445657?w=400&h=300&fit=crop",
            images: [
                "https://images.unsplash.com/photo-1503602642458-232111445657?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400&h=300&fit=crop",
            ],
            productUrl: "",
            storeUrl: "",
        },
        {
            id: 8,
            name: "Suzhou Classic Furniture Manufacturing",
            productName: "Classic Style Furniture",
            rating: 4.7,
            reviews: 981,
            moq: 450,
            price: 43.2,
            verified: true,
            location: "China",
            yearsInBusiness: 11,
            responseRate: 96,
            tags: ["Gold Supplier", "Trade Assurance", "Verified"],
            tradeAssurance: true,
            goldSupplier: true,
            contactEmail: "",
            contactPhone: "",
            productImage:
                "https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400&h=300&fit=crop",
            images: [
                "https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1517705008128-361805f42e86?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1503602642458-232111445657?w=400&h=300&fit=crop",
            ],
            productUrl: "",
            storeUrl: "",
        },
        {
            id: 9,
            name: "Xiamen Wooden Chair Specialists",
            productName: "Specialist Wooden Chairs",
            rating: 4.5,
            reviews: 612,
            moq: 250,
            price: 47.9,
            verified: true,
            location: "China",
            yearsInBusiness: 6,
            responseRate: 93,
            tags: ["Verified", "Trade Assurance"],
            tradeAssurance: true,
            goldSupplier: false,
            contactEmail: "",
            contactPhone: "",
            productImage:
                "https://images.unsplash.com/photo-1519947486511-46149fa0a254?w=400&h=300&fit=crop",
            images: [
                "https://images.unsplash.com/photo-1519947486511-46149fa0a254?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1598300042247-d088f8ab3a91?w=400&h=300&fit=crop",
                "https://images.unsplash.com/photo-1506439773649-6e0eb8cfb237?w=400&h=300&fit=crop",
            ],
            productUrl: "",
            storeUrl: "",
        },
    ];
}

/* ─────────────────────────────────────────────
   Export
───────────────────────────────────────────── */
export async function searchSuppliers({ keyword, pageSize = 20 }) {
    const results = await searchAlibabaScraper({ keyword, pageSize });
    return results.length > 0 ? results : getMockData();
}