import express from "express";
import axios from "axios";

const router = express.Router();

// The old /chat, /costs and /contact endpoints are retired: the app does not
// use them, and they answered with figures that were not real (fixed shipping,
// a flat 15% duty, an invented supplier score). The chat runs on the page.
for (const path of ["/chat", "/costs", "/contact"]) {
  router.post(path, (_req, res) => res.status(410).json({ error: "This endpoint is no longer available." }));
}

export async function refineKeyword({ userQuery, productType, material }) {
  const apiKey = process.env.GROQ_API_KEY;

  // Primary input: userQuery if present, otherwise combine productType and material
  const rawInput = (userQuery && userQuery.trim()) 
    ? userQuery.trim()
    : [productType, material].filter(Boolean).join(" ").trim();

  // Used only if the AI fails: product words only (no commas, quantities or filler)
  const STOP = /^(de|del|la|las|el|los|un|una|unos|unas|para|por|con|sin|y|o|en|a|al|que|necesito|quiero|busco|importar|comprar|paquete|paquetes|caja|cajas|unidades?|piezas?|estudiantes?|ni[nñ]os?|escolares?|the|of|for|and|with|a|an|to|pack|units?|pieces?)$/i;
  // What the client rules out ("no para carne ni pintura") never goes into the keyword
  const productWords = (text) => text
    .replace(/["'`\n.,;:()!?¿¡]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !/\d/.test(w) && !STOP.test(w))
    .slice(0, 4)
    .join(" ")
    .trim();
  const withoutExclusions = rawInput.toLowerCase().replace(/\b(?:no|ni|excepto|salvo|not|nor|except)\b[^.,;:]*/g, " ");
  // if everything was an exclusion ("no para carne ni pintura"), keep the plain words
  const fallbackClean = productWords(withoutExclusions) || productWords(rawInput);

  if (!apiKey) {
    console.log("⚠️ No Groq key — using fallback keyword:", fallbackClean);
    return fallbackClean;
  }

  // groq/compound-mini was retired by Groq. The model can be changed with
  // GROQ_KEYWORD_MODEL without touching code; the qwen model is the fallback.
  const modelsToTry = [...new Set([process.env.GROQ_KEYWORD_MODEL, "qwen/qwen3.8-27b"].filter(Boolean))];

  for (const model of modelsToTry) {
    try {
      const response = await axios.post(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          model,
          messages: [
            {
              role: "system",
              content: `You are an Alibaba B2B search keyword optimizer.
Translate any language query into a clean 2 to 5 word English Alibaba product search keyword.
Rules:
- Return ONLY the search keyword text.
- Do NOT include thinking process, explanation, quotes, or punctuation.
- Keep it concise (2-5 words): the product name plus its key technical attribute (for example capacity or number of needles).
- Leave out quantities, packaging, who it is for (students, kids, restaurants) and phrases like "I need" or "to import".
- Never include what the user rules out ("no para carne ni pintura", "not for paint"): leave those words out entirely.
Examples: "lápices escolares de madera para estudiantes, paquete de 500 unidades" -> "wooden pencils"; "bordadora industrial de 15 agujas para gorras" -> "15 needle embroidery machine"; "molino para maíz y especias de 100 kg/h, no para carne ni pintura" -> "corn spice grinder 100kg/h".`
            },
            {
              role: "user",
              content: `${rawInput}\n/no_think`
            }
          ],
          temperature: 0.1,
          // reasoning models write <think>…</think> first; 30 tokens left nothing for the answer
          max_tokens: 300
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          timeout: 10000
        }
      );

      let text = response.data?.choices?.[0]?.message?.content || "";
      
      // Remove any <think>...</think> tags or unclosed <think>
      text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
      text = text.replace(/<think>[\s\S]*/gi, "");

      // Sanitize: strip quotes, backticks, linebreaks, punctuation
      let cleaned = text
        .replace(/["'`\r\n.,!?]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      // Take first line and limit to max 6 words
      cleaned = cleaned.split("\n")[0].split(/\s+/).slice(0, 6).join(" ").trim();

      if (cleaned.length > 0) {
        console.log(`🤖 Groq refined keyword (${model}): "${rawInput}" → "${cleaned}"`);
        return cleaned;
      }
      console.warn(`⚠️ Groq (${model}) returned no keyword (finish: ${response.data?.choices?.[0]?.finish_reason})`);
    } catch (error) {
      console.error(`⚠️ Groq refine failed with ${model}:`, error.response?.data?.error?.message || error.message);
    }
  }

  console.log("⚠️ All Groq models failed — using fallback keyword:", fallbackClean);
  return fallbackClean;
}

// Core product name (2-3 words, no numbers or specs) for a second search attempt
export async function shortenKeyword(keyword) {
  const heuristic = String(keyword || "")
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w && !/\d/.test(w) && !/^(needles?|heads?|kg|kgs|l|liters?|litres?|tons?|per|hour|batch|single|double|high|speed|automatic|industrial|commercial|for|with|and|of)$/.test(w))
    .slice(-3)
    .join(" ")
    .trim();
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return heuristic;
  const model = process.env.GROQ_KEYWORD_MODEL || "qwen/qwen3.8-27b";
  try {
    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model,
        messages: [
          {
            role: "system",
            content: `Shorten this Alibaba search keyword to the core product name in 2 or 3 English words.
Remove numbers, sizes, capacities and specifications. Return ONLY the keyword.`,
          },
          { role: "user", content: `${String(keyword || "")}\n/no_think` },
        ],
        temperature: 0,
        max_tokens: 300,
      },
      { headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, timeout: 6000 },
    );
    let text = response.data?.choices?.[0]?.message?.content || "";
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<think>[\s\S]*/gi, "");
    const cleaned = text.replace(/["'`\r\n.,!?]/g, " ").replace(/\s+/g, " ").trim().split(/\s+/).slice(0, 3).join(" ");
    return cleaned || heuristic;
  } catch (error) {
    console.error("⚠️ Groq shorten failed:", error.response?.data?.error?.message || error.message);
    return heuristic;
  }
}

export default router;
