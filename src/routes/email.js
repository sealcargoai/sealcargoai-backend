import express from "express";
import {
  sendLeadNotification,
  sendQuoteRequest,
  sendReportToUser,
} from "../services/email.js";

const router = express.Router();

router.post("/lead", async (req, res) => {
  try {
    const { name, email, query } = req.body;
    if (!name || !email || !query) {
      return res.status(400).json({ error: "name, email, and query are required" });
    }

    await sendLeadNotification({ name, email, query });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/quote", async (req, res) => {
  try {
    await sendQuoteRequest(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/report", async (req, res) => {
  try {
    await sendReportToUser(req.body);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;