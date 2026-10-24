import express from "express";
import {
  sendLeadNotification,
  sendQuoteRequest,
  sendReportToUser,
} from "../services/email.js";
import { isEmail, clean } from "../middleware/security.js";

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

    // Frontend sends the PDF as base64 (pdfBase64)
    let pdfBuffer = null;
    if (typeof b.pdfBase64 === "string" && b.pdfBase64.length > 0) {
      pdfBuffer = Buffer.from(b.pdfBase64, "base64");
      // Must really be a PDF
      if (pdfBuffer.subarray(0, 4).toString() !== "%PDF") {
        return res.status(400).json({ error: "invalid PDF" });
      }
    }

    const result = await sendReportToUser({
      recipientEmail,
      recipientName: clean(b.recipientName, 120),
      pdfBuffer,
      supplierName: clean(b.supplierName, 200),
      totalCost: Number(b.totalCost) || 0,
    });
    res.json({ success: true, delivered: result.delivered, forwarded: !!result.forwarded });
  } catch (err) {
    console.error("❌ /email/report:", err.message);
    res.status(500).json({ error: "Could not send email" });
  }
});

export default router;
