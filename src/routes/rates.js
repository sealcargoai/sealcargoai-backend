import express from "express";
import axios from "axios";

// ── Freight & cost rates ─────────────────────────────────────────────────────
// SEAL keeps its rates in code (DEFAULT_RATES below and the frontend calculator).
// Optional: set RATES_SHEET_ID in Railway to read them from a Google Sheet
// (tab "Tarifas": column A = key, column B = value; shared "Anyone with the link → Viewer").
const router = express.Router();

const SHEET_ID = process.env.RATES_SHEET_ID || ""; // no sheet unless explicitly configured
const SHEET_TAB = process.env.RATES_SHEET_TAB || "Tarifas";
const CACHE_MS = 60 * 60 * 1000; // 1 hour

export const DEFAULT_RATES = {
  container40: 6000,
  container20: 0,
  container40Cbm: 55,
  container20Cbm: 25,
  lclFactor: 1.8,
  lclMinCbm: 1,
  lclMaxCbm: 15,
  dutyRate: 0.15,
  vatRate: 0.12,
  insuranceRate: 0.01,
  insuranceMin: 250,
  customsFees: 200,
  localCharges: 450,
  // the same fixed amounts in quetzales and the exchange rate the frontend uses, so
  // the sheet can change them too (they used to be ignored: the keys were missing)
  customsFeesGTQ: 1200,
  localChargesGTQ: 9500,
  exchangeRate: 7.9,
  transitDays: "30-45",
};

const PERCENT_KEYS = new Set(["dutyRate", "vatRate", "insuranceRate"]);

let cache = { rates: DEFAULT_RATES, source: "default", at: 0 };

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') inQ = false;
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}

function parseValue(key, raw) {
  if (key === "transitDays") return String(raw);
  let str = String(raw).replace(/[$,\s]/g, "");
  const isPct = str.endsWith("%");
  let n = parseFloat(str.replace("%", ""));
  if (!Number.isFinite(n)) return undefined;
  // "15", "15%" and "0.15" are all 15%; "1" is 1% (a DAI of 1 would be 100% otherwise)
  if (PERCENT_KEYS.has(key) && (isPct || n >= 1)) n = n / 100;
  // a rate above 100% or a negative amount is a typo in the sheet: keep the default
  if (PERCENT_KEYS.has(key) && !(n >= 0 && n <= 1)) return undefined;
  if (!PERCENT_KEYS.has(key) && n < 0) return undefined;
  return n;
}

export async function getRates() {
  if (Date.now() - cache.at < CACHE_MS) return cache;
  if (!SHEET_ID) {
    cache = { rates: DEFAULT_RATES, source: "default", at: Date.now() };
    return cache;
  }
  try {
    const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_TAB)}`;
    const { data } = await axios.get(url, { timeout: 10000, responseType: "text" });
    const rates = { ...DEFAULT_RATES };
    for (const [key, value] of parseCsv(data)) {
      if (key in DEFAULT_RATES && value !== undefined && value !== "") {
        const v = parseValue(key, value);
        if (v !== undefined) rates[key] = v;
      }
    }
    cache = { rates, source: "sheet", at: Date.now() };
    console.log("✅ Rates loaded from Google Sheet");
  } catch (err) {
    console.error("⚠️ Could not read rates sheet, using last known values:", err.message);
    cache = { ...cache, at: Date.now() - CACHE_MS + 5 * 60 * 1000 }; // retry in 5 min
  }
  return cache;
}

router.get("/", async (_req, res) => {
  const { rates, source, at } = await getRates();
  res.set("Cache-Control", "public, max-age=300");
  res.json({ rates, source, updatedAt: new Date(at).toISOString() });
});

export default router;
