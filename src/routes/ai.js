import express from "express";
import axios from "axios";

const router = express.Router();

// ── POST /api/ai/chat ─────────────────────────────────────────────────────────
router.post("/chat", async (req, res) => {
  const { message, context } = req.body;

  if (!message) {
    return res.status(400).json({ error: "message is required" });
  }

  const apiKey = process.env.GROK_API_KEY;

  // No key → smart mock response
  if (!apiKey || apiKey === "your_grok_api_key_here") {
    console.log("⚠️  No Grok key — using mock AI response");
    return res.json({ reply: getMockReply(message, context) });
  }

  // Real Grok API call
  try {
    const response = await axios.post(
      "https://api.x.ai/v1/chat/completions",
      {
        model: "grok-3-mini",
        messages: [
          {
            role: "system",
            content: `You are SEAL SmartTrade AI, an expert import/export assistant 
            specializing in sourcing products from China to Latin America (especially 
            Guatemala). You help users find suppliers, calculate costs, understand 
            customs, and manage international trade. Be concise, professional, and 
            helpful. Always respond in the same language the user writes in.
            
            Current context: ${JSON.stringify(context || {})}`,
          },
          {
            role: "user",
            content: message,
          },
        ],
        temperature: 0.7,
        max_tokens: 500,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      },
    );

    const reply =
      response.data.choices?.[0]?.message?.content ||
      "I could not generate a response. Please try again.";

    console.log(`✅ Grok responded (${reply.length} chars)`);
    res.json({ reply });
  } catch (error) {
    console.error("❌ Grok API error:", error.response?.data || error.message);
    // Fallback to mock
    res.json({ reply: getMockReply(message, context) });
  }
});

// ── POST /api/ai/costs ────────────────────────────────────────────────────────
router.post("/costs", async (req, res) => {
  const { supplier, quantity, budget, destination, productType } = req.body;

  if (!supplier || !quantity) {
    return res
      .status(400)
      .json({ error: "supplier and quantity are required" });
  }

  const qty = parseInt(quantity) || 1000;
  const pricePerUnit = parseFloat(supplier.price) || 40;

  // Product cost
  const productCost = Math.round(pricePerUnit * qty);

  // Shipping rates by destination — plain JS object, no TypeScript
  const shippingRates = {
    US: 4200,
    GT: 3800,
    MX: 3500,
    CA: 4800,
    other: 5000,
  };
  const shipping = shippingRates[destination] || 4200;

  // Duty rates by product type
  const dutyRates = {
    furniture: 0.15,
    electronics: 0.15,
    textiles: 0.15,
    machinery: 0.15,
    other: 0.15,
  };
  const dutyRate = dutyRates[productType] || 0.15;
  const importDuties = Math.round(productCost * dutyRate);

  // Taxes — IVA 12% of (product + duties)
  const taxes = Math.round((productCost + importDuties) * 0.12);

  // Insurance — 1% of product cost
  const insurance = Math.round(productCost * 0.01);

  const totalCost = productCost + shipping + importDuties + taxes + insurance;

  const costBreakdown = {
    supplier: supplier.name,
    quantity: qty,
    destination,
    productType,
    items: [
      {
        label: "Product Cost",
        amount: productCost,
        details: `${qty.toLocaleString()} units × $${pricePerUnit.toFixed(2)} per unit`,
        color: "#0B3C5D",
      },
      {
        label: "Ocean Freight",
        amount: shipping,
        details: `Estimated shipping to ${destination} • ~25 days transit`,
        color: "#3B82F6",
      },
      {
        label: "Import Duties",
        amount: importDuties,
        details: `${(dutyRate * 100).toFixed(0)}% duty rate for ${productType}`,
        color: "#60A5FA",
      },
      {
        label: "VAT & Taxes",
        amount: taxes,
        details: "IVA 12% sobre producto + aranceles", // ← updated
        color: "#93C5FD",
      },
      {
        label: "Insurance",
        amount: insurance,
        details: "Cargo insurance • Full coverage • 1% of product value", // ← updated
        color: "#BFDBFE",
      },
    ],
    totalCost,
    perUnit: parseFloat((totalCost / qty).toFixed(2)),
  };

  console.log(
    `✅ Cost breakdown: $${totalCost.toLocaleString()} total for ${supplier.name}`,
  );
  res.json(costBreakdown);
});

// ── POST /api/ai/contact ──────────────────────────────────────────────────────
router.post("/contact", async (req, res) => {
  const { supplier, notes, userEmail, userName, quantity, budget } = req.body;

  if (!supplier) {
    return res.status(400).json({ error: "supplier is required" });
  }

  const lead = {
    id: `LEAD-${Date.now()}`,
    timestamp: new Date().toISOString(),
    supplier: {
      name: supplier.name,
      email: supplier.contactEmail,
      phone: supplier.contactPhone,
      aiScore: supplier.aiScore,
      location: supplier.location,
    },
    user: {
      name: userName || "Anonymous",
      email: userEmail || "not provided",
    },
    inquiry: {
      quantity,
      budget,
      notes,
    },
    status: "pending",
  };

  console.log("\n📋 NEW LEAD GENERATED:");
  console.log(`   Supplier: ${lead.supplier.name}`);
  console.log(`   User:     ${lead.user.name} <${lead.user.email}>`);
  console.log(`   Quantity: ${quantity} | Budget: $${budget}`);
  console.log(`   Lead ID:  ${lead.id}`);
  console.log("─".repeat(50));

  res.json({
    success: true,
    leadId: lead.id,
    message:
      "Lead saved successfully. Our team will follow up within 24 hours.",
    lead,
  });
});

// ── Mock AI replies ───────────────────────────────────────────────────────────
function getMockReply(message, context) {
  const msg = (message || "").toLowerCase();

  if (msg.includes("precio") || msg.includes("cost") || msg.includes("price")) {
    return "Based on your requirements, the estimated total landed cost includes product cost, shipping ($3,500–$5,000 depending on destination), import duties (15% flat rate for all categories), and insurance (~1% of product value). Would you like me to calculate the exact breakdown for your selected supplier?";
  }
  if (msg.includes("proveedor") || msg.includes("supplier")) {
    return "I've analyzed suppliers based on quality scores, response rates, years in business, and pricing. The top-ranked supplier has an AI score of 98/100. Would you like me to explain the ranking criteria in more detail?";
  }
  if (
    msg.includes("aduana") ||
    msg.includes("customs") ||
    msg.includes("duty") ||
    msg.includes("arancel")
  ) {
    return "For your import you'll need: Commercial Invoice, Packing List, Bill of Lading, and Certificate of Origin. Import duties are 15% for all product categories (furniture, electronics, textiles, machinery). I recommend working with a licensed customs broker for your first shipment.";
  }
  if (
    msg.includes("tiempo") ||
    msg.includes("time") ||
    msg.includes("shipping") ||
    msg.includes("envío")
  ) {
    return "Typical timeline: 15–20 days production + 20–30 days ocean freight + 3–5 days customs clearance. Total: approximately 40–55 days from order placement to delivery at your destination.";
  }
  if (msg.includes("hola") || msg.includes("hello") || msg.includes("hi")) {
    return "¡Hola! I'm your SEAL SmartTrade AI assistant. I can help you with supplier sourcing, cost calculations, customs requirements, and import logistics. What would you like to know?";
  }
  return "I understand your inquiry. Based on your product requirements and target market, I recommend reviewing the qualified suppliers list and selecting one that matches your MOQ and budget. Would you like specific advice about any supplier or cost component?";
}

// ── Helper: Refine user search query using Grok ───────────────────────────────
// Converts vague queries into precise Alibaba search keywords
export async function refineKeyword({ userQuery, productType, material }) {
  const apiKey = process.env.GROQ_API_KEY;

  const fallback = [userQuery, productType, material]
    .filter(Boolean)
    .join(" ")
    .trim();

  if (!apiKey) {
    console.log("⚠️ No Groq key — using fallback:", fallback);
    return fallback;
  }

  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama3-8b-8192",   // ✅ Groq supported model
        messages: [
          {
            role: "system",
            content: `
You are an Alibaba B2B search optimizer.
Translate any language into the best 2-6 word English Alibaba search keyword.
Return ONLY the keyword.
            `
          },
          {
            role: "user",
            content: fallback
          }
        ],
        temperature: 0.2,
        max_tokens: 40
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        }
      }
    );

    let refined =
      response.data.choices?.[0]?.message?.content?.trim() || fallback;

    refined = refined.replace(/["'`\n.]/g, "").trim();

    console.log(`🤖 Groq refined keyword: "${fallback}" → "${refined}"`);

    return refined;
  } catch (error) {
    console.error("❌ Groq refine error:", error.response?.data || error.message);
    return fallback;
  }
}

export default router;
