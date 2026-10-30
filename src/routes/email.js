import express from "express";
import {
  sendLeadNotification,
  sendReportToUser,
  sendCaseToSeal,
  testTag,
  isTestRecord,
  scrubEmails,
} from "../services/email.js";
import { registerLead, markNotified, leadsPersistent } from "../services/leadStore.js";
import { linksFor, baseUrl, caseLink } from "./leads.js";
import { isEmail, clean, quantityError, budgetError, malformedFields } from "../middleware/security.js";
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
    if (malformedFields(req.body, ["name", "email", "query"]).length) return res.status(400).json({ error: "invalid_fields" });
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

// A request to SEAL (quote, contact, supplier check…): registered as a case with
// a number, without duplicates, with the whole context the client saw, and
// emailed to SEAL with the links a person uses to record the follow-up.
const list = (v, max = 12, len = 300) =>
  (Array.isArray(v) ? v : []).map((x) => clean(x, len)).filter(Boolean).slice(0, max);
router.post("/quote", async (req, res) => {
  try {
    const b = req.body || {};
    // a malformed request (objects or arrays where text goes, a budget or quantity that is not a
    // plain amount) is rejected FIRST: nothing is registered, emailed or counted
    const malformed = malformedFields(
      b,
      ["name", "email", "phone", "company", "product", "productDescription", "productType", "quantity", "supplierName", "supplierUrl", "price", "priceSource", "publishedPrice", "totalCostText", "totalCost", "budget", "destination", "message", "caseRef", "source", "intent", "requestType", "lang"],
      ["assumptions", "warnings", "chat", "earlier"],
    );
    if (malformed.length) return res.status(400).json({ error: "invalid_fields", fields: malformed.slice(0, 10) });
    if (b.totalCost !== undefined && b.totalCost !== null && b.totalCost !== "" && !Number.isFinite(Number(b.totalCost))) return res.status(400).json({ error: "invalid_fields", fields: ["totalCost"] });
    const preInvalid = quantityError(b.quantity) || budgetError(b.budget);
    if (preInvalid) return res.status(400).json({ error: preInvalid });
    const contact = {
      name: clean(b.name, 120),
      email: clean(b.email, 254),
      phone: clean(b.phone, 40),
      company: clean(b.company, 160),
    };
    if (!contact.name || !isEmail(contact.email)) {
      return res.status(400).json({ error: "name and a valid email are required" });
    }
    const caseData = {
      // the client's own words first; the category ("ppe") only as a last resort
      // the whole description the client wrote (voltage, capacity, material… are part of the case)
      product: clean(b.product, 600) || clean(b.productDescription, 600) || clean(b.productType, 160),
      description: clean(b.productDescription, 1500),
      quantity: clean(b.quantity, 60),
      supplierName: clean(b.supplierName, 200),
      supplierUrl: clean(b.supplierUrl, 500),
      price: clean(b.price, 80),
      // the price used: from the listing, or typed by the client
      priceSource: b.priceSource === "usuario" ? "usuario" : b.price ? "publicado" : "",
      publishedPrice: clean(b.publishedPrice, 80),
      totalCostText: clean(b.totalCostText, 80),
      budget: clean(b.budget, 40),
      destination: clean(b.destination, 60),
      message: clean(b.message, 2000),
      caseRef: clean(b.caseRef, 40),
      // whole sentences: an assumption cut in half changes its meaning
      assumptions: list(b.assumptions, 12, 1000),
      warnings: list(b.warnings, 12, 1000),
      chat: list(b.chat, 8, 500),
      // data of an earlier product of the same case: history, not the current request
      earlier: list(b.earlier, 5, 300),
    };
    // the same limits the site applies: an invalid quantity or budget never reaches SEAL as data
    // of the case (nothing is registered or emailed; the page shows the reason)
    const invalid = quantityError(caseData.quantity) || budgetError(caseData.budget);
    if (invalid) return res.status(400).json({ error: invalid });
    if (!caseData.totalCostText && Number(b.totalCost) > 0) caseData.totalCostText = `US$${Math.round(Number(b.totalCost)).toLocaleString("en-US")}`;
    for (const k of Object.keys(caseData)) if (caseData[k] === "") delete caseData[k];
    const { lead, duplicate, changes } = registerLead({
      contact,
      case: caseData,
      source: clean(b.source, 40),
      intent: clean(b.intent, 60),
      requestType: clean(b.requestType, 80) || "Solicitud de cotización",
      lang: b.lang,
      test: isTestRecord(contact.name, contact.email),
    });
    // an identical repeat of an open case is not emailed again (unless the first email
    // failed); a repeat with new information goes to SEAL as an update of the same case
    let notified = lead.notified;
    const update = duplicate && lead.notified !== false && changes.length ? changes : null;
    if (!duplicate || lead.notified === false || update) {
      try {
        const sent = await sendCaseToSeal(lead, linksFor(lead, baseUrl(req)), update);
        markNotified(lead.id, true, "", Date.now(), sent?.id, sent?.to);
        notified = true;
      } catch (err) {
        console.error("❌ case email failed:", lead.id, scrubEmails(err.message));
        markNotified(lead.id, false, scrubEmails(err.message));
        notified = false;
        // without a saved registry an unsent email would lose the case
        if (!leadsPersistent) return res.status(500).json({ error: "Could not send email" });
      }
    }
    // the client can see what SEAL received and the case status (signed link)
    // test: the site doesn't count it as a commercial lead (analytics)
    res.json({ success: true, id: lead.id, duplicate, notified: notified !== false, test: !!lead.test, caseUrl: caseLink(lead, baseUrl(req)) });
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
