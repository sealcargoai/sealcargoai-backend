import express from "express";
import {
  sendLeadNotification,
  sendQuoteRequest,
  sendReportToUser,
} from "../services/email.js";
import { isEmail, clean } from "../middleware/security.js";
import { hasSearched, emailKey, verifyReportToken } from "../services/quotaStore.js";

// Reports go out from SEAL's address: only someone who ran a search may send
// one, and each recipient gets a few per day (no open relay)
const DAY = 24 * 60 * 60 * 1000;
const sentTo = new Map(); // recipient key -> [timestamps]
const sentBy = new Map(); // requester key -> [timestamps]
function underCap(map, key, max) {
  const now = Date.now();
  const list = (map.get(key) || []).filter((t) => now - t < DAY);
  map.set(key, list);
  return list.length < max;
}
setInterval(() => {
  const now = Date.now();
  for (const m of [sentTo, sentBy]) for (const [k, list] of m) if (!list.some((t) => now - t < DAY)) m.delete(k);
}, 60 * 60 * 1000).unref();

const router = express.Router();

router.post("/lead", async (req, res) => {
  try {
    const name = clean(req.body.name, 120);
    const email = clean(req.body.email, 254);
    const query = clean(req.body.query, 1000);
    if (!name || !email || !query) {
      return res.status(400).json({ error: "name, email, and query are required" });
    }
    if (!isEmail(email)) {
      return res.status(400).json({ error: "invalid email" });
    }

    await sendLeadNotification({ name, email, query });
    res.json({ success: true });
  } catch (err) {
    console.error("❌ /email/lead:", err.message);
    res.status(500).json({ error: "Could not send email" });
  }
});

router.post("/quote", async (req, res) => {
  try {
    const b = req.body || {};
    const data = {
      name: clean(b.name, 120),
      email: clean(b.email, 254),
      phone: clean(b.phone, 40),
      company: clean(b.company, 160),
      message: clean(b.message, 2000),
      supplierName: clean(b.supplierName, 200),
      totalCost: Number(b.totalCost) || 0,
      totalCostText: clean(b.totalCostText, 80), // e.g. "Q278,041 (US$35,195)"
      productType: clean(b.productType, 120),
      quantity: clean(b.quantity, 40),
      destination: clean(b.destination, 60),
      budget: clean(b.budget, 40),
      requestType: clean(b.requestType, 80),           // e.g. "Búsqueda asistida", "Contactar proveedor"
      productDescription: clean(b.productDescription, 1500),
      supplierUrl: clean(b.supplierUrl, 500),
    };
    // Drop empty fields so the email stays clean
    for (const k of Object.keys(data)) if (data[k] === "" || data[k] === 0) delete data[k];
    if (!data.name || !isEmail(data.email)) {
      return res.status(400).json({ error: "name and a valid email are required" });
    }

    await sendQuoteRequest(data);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ /email/quote:", err.message);
    res.status(500).json({ error: "Could not send email" });
  }
});

router.post("/report", async (req, res) => {
  try {
    const b = req.body || {};
    const recipientEmail = clean(b.recipientEmail, 254);
    if (!isEmail(recipientEmail)) {
      return res.status(400).json({ error: "a valid recipientEmail is required" });
    }
    const requester = clean(b.requesterEmail, 254);
    // the requester must have searched AND hold the token that search returned
    if (!isEmail(requester) || !hasSearched(requester) || !verifyReportToken(requester, b.reportToken)) {
      return res.status(403).json({ error: "report_not_allowed", message: "Only the person who ran the search can send this report." });
    }
    const toKey = emailKey(recipientEmail);
    const byKey = emailKey(requester);
    if (!underCap(sentTo, toKey, 3) || !underCap(sentBy, byKey, 10)) {
      return res.status(429).json({ error: "report_limit", message: "Too many reports sent today." });
    }

    // Frontend sends the PDF as base64 (pdfBase64)
    let pdfBuffer = null;
    if (typeof b.pdfBase64 === "string" && b.pdfBase64.length > 0) {
      pdfBuffer = Buffer.from(b.pdfBase64, "base64");
      // Must really be a PDF (header and end marker), and a report-sized one
      const tail = pdfBuffer.subarray(Math.max(0, pdfBuffer.length - 1024)).toString("latin1");
      if (pdfBuffer.subarray(0, 5).toString() !== "%PDF-" || !tail.includes("%%EOF") || pdfBuffer.length > 3 * 1024 * 1024) {
        return res.status(400).json({ error: "invalid PDF" });
      }
    }

    sentTo.get(toKey).push(Date.now());
    sentBy.get(byKey).push(Date.now());
    const result = await sendReportToUser({
      recipientEmail,
      recipientName: clean(b.recipientName, 120),
      requesterEmail: requester,
      pdfBuffer,
      // no links or addresses in what goes into the subject and body
      supplierName: clean(b.supplierName, 200).replace(/https?:\/\/\S+|www\.\S+|\b[\w.-]+\.(?:com|net|org|io|xyz|info|top|ru|cn)\b\S*/gi, "").replace(/\s+/g, " ").trim().slice(0, 100),
      totalCost: Number(b.totalCost) || 0,
      totalCostText: clean(b.totalCostText, 80).replace(/[^\dQUS$.,()\s]/g, "").slice(0, 60),
      lang: b.lang === "en" ? "en" : "es",
    });
    res.json({ success: true, delivered: result.delivered, forwarded: !!result.forwarded });
  } catch (err) {
    console.error("❌ /email/report:", err.message);
    res.status(500).json({ error: "Could not send email" });
  }
});

export default router;
