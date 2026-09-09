
// diagnose.mjs
// Run: node diagnose.mjs "electric motorcycle"

import axios from "axios";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { HttpsProxyAgent } from "https-proxy-agent";
import { searchSuppliers } from "./src/services/alibaba.js";
import { refineKeyword } from "./src/routes/ai.js";

dotenv.config();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OXY_USER = process.env.OXY_USER;
const OXY_PASS = process.env.OXY_PASS;
const OXY_UNBLOCK_USER = process.env.OXY_UNBLOCK_USER;
const OXY_UNBLOCK_PASS = process.env.OXY_UNBLOCK_PASS;

const query = (process.argv[2] || "electric motorcycle").trim();
const SAVE_HTML = process.env.SAVE_HTML === "1";

function buildAlibabaSearchUrl(keyword) {
  const cleanKeyword = keyword.trim().replace(/\s+/g, " ").split(" ").join("+");
  return `https://www.alibaba.com/trade/search?tab=all&SearchText=${cleanKeyword}`;
}

async function testGroqRefine() {
  console.log("\n🤖 GROQ REFINEMENT TEST\n----------------------");
  if (!GROQ_API_KEY) {
    console.log("❌ GROQ_API_KEY missing");
    return query;
  }

  try {
    const refined = await refineKeyword({ userQuery: query, productType: "", material: "" });
    console.log(`Input: "${query}" -> Refined Keyword: "${refined}"`);
    return refined;
  } catch (e) {
    console.log("❌ refineKeyword error:", e.message);
    return query;
  }
}

async function testWebUnblocker(keyword) {
  console.log("\n🛡️ WEB UNBLOCKER PROXY TEST\n----------------------");
  if (!OXY_UNBLOCK_USER || !OXY_UNBLOCK_PASS) {
    console.log("⚠️ OXY_UNBLOCK_USER / OXY_UNBLOCK_PASS missing in env");
    return;
  }

  const proxyUrl = `https://${encodeURIComponent(OXY_UNBLOCK_USER)}:${encodeURIComponent(OXY_UNBLOCK_PASS)}@unblock.oxylabs.io:60000`;
  const agent = new HttpsProxyAgent(proxyUrl);
  agent.options.rejectUnauthorized = false;

  const url = buildAlibabaSearchUrl(keyword);
  console.log("Target URL:", url);

  try {
    const resp = await axios.get(url, {
      httpsAgent: agent,
      proxy: false,
      timeout: 60000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        Referer: "https://www.alibaba.com/",
      },
      responseType: "text",
      transformResponse: (r) => r,
    });

    const html = resp.data || "";
    const size = html.length;
    const hasCaptcha = html.length < 200000 || html.includes("nocaptcha") || html.includes("cf.aliyun.com/nocaptcha");
    const hasOfferMarkers = html.includes("offerResultData") || html.includes("_offer_list");

    console.log("Status:", resp.status);
    console.log("HTML Size:", size, "bytes");
    console.log("Captcha Detected:", hasCaptcha);
    console.log("Offer Markers Present:", hasOfferMarkers);

    if (SAVE_HTML) {
      const filename = path.join(process.cwd(), `_debug_unblocker.html`);
      fs.writeFileSync(filename, html, "utf8");
      console.log("💾 Saved HTML to:", filename);
    }
  } catch (e) {
    console.log("❌ Web Unblocker test failed:", e.response?.status || e.message);
  }
}

async function testFullSearchPipeline(keyword) {
  console.log("\n🧩 FULL searchSuppliers() PIPELINE TEST\n----------------------");
  try {
    const suppliers = await searchSuppliers({ keyword, pageSize: 5 });
    console.log("Returned suppliers count:", suppliers.length);
    if (suppliers.length > 0) {
      console.log("Top 3 Suppliers:");
      suppliers.slice(0, 3).forEach((s, idx) => {
        console.log(`  [${idx + 1}] ${s.name} - $${s.price} (${s.productName?.slice(0, 50)})`);
      });
    } else {
      console.log("⚠️ No suppliers returned (check captcha or keyword parsing)");
    }
  } catch (e) {
    console.log("❌ searchSuppliers error:", e.message);
  }
}

async function main() {
  console.log("🚦 DIAGNOSE START");
  console.log("Query:", JSON.stringify(query));
  console.log("Has GROQ_API_KEY:", !!GROQ_API_KEY);
  console.log("Has OXY_UNBLOCK_USER:", !!OXY_UNBLOCK_USER);
  console.log("Has OXY_USER:", !!OXY_USER);

  const refinedKeyword = await testGroqRefine();
  await testWebUnblocker(refinedKeyword);
  await testFullSearchPipeline(refinedKeyword);

  console.log("\n✅ DIAGNOSE END");
}

main().catch((e) => {
  console.error("❌ Fatal error:", e);
  process.exit(1);
});