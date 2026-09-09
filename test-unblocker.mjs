import axios from "axios";
import { HttpsProxyAgent } from "https-proxy-agent";

const user = process.env.OXY_UNBLOCK_USER;
const pass = process.env.OXY_UNBLOCK_PASS;

if (!user || !pass) {
  console.error("Missing OXY_UNBLOCK_USER / OXY_UNBLOCK_PASS");
  process.exit(1);
}

// Equivalent to curl -k
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const proxyUrl = `https://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@unblock.oxylabs.io:60000`;
const agent = new HttpsProxyAgent(proxyUrl);

// extra safety
agent.options.rejectUnauthorized = false;

async function main() {
  // 1) IP test
  const ip = await axios.get("https://ip.oxylabs.io/location", {
    httpsAgent: agent,
    proxy: false,
    timeout: 30000,
    responseType: "text",
    transformResponse: (r) => r,
  });

  console.log("\n✅ IP LOCATION:");
  console.log(String(ip.data).slice(0, 300));

  // 2) Alibaba test
  const url = "https://www.alibaba.com/trade/search?tab=all&SearchText=wooden+chair";
  const res = await axios.get(url, {
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
    },
  });

  const html = String(res.data || "");
  console.log("\n✅ ALIBABA RESULT:");
  console.log("status:", res.status);
  console.log("html_size:", html.length);
  console.log("hasCaptcha:", html.includes("nocaptcha") || html.includes("cf.aliyun.com/nocaptcha"));
  console.log("hasOfferMarkers:", html.includes("offerResultData") || html.includes("_offer_list"));
  console.log("first200:", JSON.stringify(html.slice(0, 200)));
}

main().catch((e) => {
  console.error("❌ Error:", e.response?.status, e.response?.data || e.message);
  process.exit(1);
});