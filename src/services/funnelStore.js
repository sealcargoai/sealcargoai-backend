// Top of the funnel, counted on the server (no personal data): visits, started
// queries, results shown, WhatsApp clicks and contact forms opened, per day.
// Each browser (an anonymous random id) counts once per event per day, so a
// reload doesn't inflate the numbers. A WhatsApp click is NOT a lead: leads are
// the requests registered in leadStore.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export const EVENTS = ["visita", "consulta_iniciada", "resultados", "contacto_abierto", "whatsapp_clic", "solicitud_enviada"];
const DATA_DIR = process.env.DATA_DIR || "";
const FILE = DATA_DIR ? path.join(DATA_DIR, "funnel.json") : "";
const KEEP_DAYS = 400;

let days = {}; // "YYYY-MM-DD" -> { event: count }
let seenDay = "";
let seen = new Set(); // hashes of vid|event for seenDay

const dayOf = (now) => new Date(now).toISOString().slice(0, 10);

/** Counts one event; false when this browser already counted it today or it's unknown. */
export function recordEvent(event, vid, now = Date.now(), qa = false) {
  if (!EVENTS.includes(event)) return false;
  const v = typeof vid === "string" && /^[a-z0-9-]{8,64}$/i.test(vid) ? vid : "";
  if (!v) return false;
  const day = dayOf(now);
  if (day !== seenDay) {
    seenDay = day;
    seen = new Set();
  }
  const h = crypto.createHash("sha256").update(`${v}|${event}|${qa ? 1 : 0}`).digest("base64url").slice(0, 16);
  if (seen.has(h)) return false;
  seen.add(h);
  // QA sessions go to their own counter, never to the commercial funnel
  const key = qa ? `qa:${event}` : event;
  days[day] = days[day] || {};
  days[day][key] = (days[day][key] || 0) + 1;
  scheduleSave();
  return true;
}

/** Totals per event from `sinceDay` (inclusive). */
export function eventTotals(sinceDay = "0000-00-00", qa = false) {
  const out = Object.fromEntries(EVENTS.map((e) => [e, 0]));
  for (const [d, counts] of Object.entries(days)) {
    if (d < sinceDay) continue;
    for (const [k, n] of Object.entries(counts)) {
      const isQa = k.startsWith("qa:");
      if (isQa !== qa) continue;
      const e = isQa ? k.slice(3) : k;
      out[e] = (out[e] || 0) + n;
    }
  }
  return out;
}

let saveTimer = null;
function writeNow() {
  if (!FILE) return;
  try {
    const cut = dayOf(Date.now() - KEEP_DAYS * 86400000);
    for (const d of Object.keys(days)) if (d < cut) delete days[d];
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify({ days, seenDay, seen: [...seen] }));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (err) {
    console.error("⚠️ funnel save failed:", err.message);
  }
}
function scheduleSave() {
  if (!FILE || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 3000);
  saveTimer.unref?.();
}
export function flushFunnel() {
  if (!FILE) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  writeNow();
}
if (FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    days = data.days || {};
    if (data.seenDay === dayOf(Date.now())) {
      seenDay = data.seenDay;
      seen = new Set(data.seen || []);
    }
  } catch (err) {
    if (err.code !== "ENOENT") console.error("⚠️ funnel load failed:", err.message);
  }
}

/** Tests only. */
export function _resetFunnel() {
  days = {};
  seenDay = "";
  seen = new Set();
}
