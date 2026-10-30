import net from "node:net";
// ── Security helpers (no external dependencies) ──────────────────────────────

// Origins allowed to call the API. Override with ALLOWED_ORIGINS (comma separated).
const DEFAULT_ORIGINS = [
  "https://seal-ai.sealcargo.com.gt",
  "http://localhost:5173",
  "http://localhost:3000",
];

export const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean)
  .concat(DEFAULT_ORIGINS);

// Vercel preview deployments of this project (e.g. *-sealai-project-guatemala.vercel.app)
const VERCEL_PREVIEW = /^https:\/\/[a-z0-9-]+-sealai-project-guatemala\.vercel\.app$/i;

export function corsOrigin(origin, callback) {
  // Requests without Origin (curl, server-to-server, health checks) are allowed
  if (!origin) return callback(null, true);
  if (allowedOrigins.includes(origin) || VERCEL_PREVIEW.test(origin)) {
    return callback(null, true);
  }
  return callback(null, false);
}

// Client IP. Railway's edge overwrites X-Real-IP with the real client address
// (values sent by the client never reach the app), while the rightmost
// X-Forwarded-For entry (what req.ip gives with trust proxy 1) can be an
// internal hop shared by many users. So: X-Real-IP first, then req.ip.
// TRUST_X_REAL_IP=0 turns the header off for deployments without such an edge.
// IPv6 addresses are grouped by /64 (one user can rotate inside their own block).
const TRUST_X_REAL_IP = process.env.TRUST_X_REAL_IP !== "0";
function ipKey(ip) {
  if (net.isIPv6(ip) && !/^::ffff:/i.test(ip)) {
    const full = ip.includes("::")
      ? (() => {
          const [a, b] = ip.split("::");
          const left = a ? a.split(":") : [];
          const right = b ? b.split(":") : [];
          return [...left, ...Array(8 - left.length - right.length).fill("0"), ...right];
        })()
      : ip.split(":");
    return `${full.slice(0, 4).map((x) => x.toLowerCase()).join(":")}::/64`;
  }
  return ip.replace(/^::ffff:/i, "");
}
export function clientIp(req) {
  const real = String(req.headers?.["x-real-ip"] || "").trim();
  if (TRUST_X_REAL_IP && net.isIP(real)) return ipKey(real);
  const ip = req.ip || req.socket?.remoteAddress || "";
  return net.isIP(ip) ? ipKey(ip) : "unknown";
}

// What the server sees for the caller's own connection (no one else's data).
export function connectionInfo(req) {
  return {
    ip: clientIp(req),
    reqIp: req.ip || "",
    xRealIp: String(req.headers?.["x-real-ip"] || ""),
    xForwardedFor: String(req.headers?.["x-forwarded-for"] || ""),
    peer: req.socket?.remoteAddress || "",
  };
}

// Simple in-memory rate limiter: max requests per IP per window
export function rateLimit({ windowMs, max, message, skip }) {
  const hits = new Map(); // ip -> { count, resetAt }

  setInterval(() => {
    const now = Date.now();
    for (const [ip, entry] of hits) if (entry.resetAt <= now) hits.delete(ip);
  }, windowMs).unref();

  return (req, res, next) => {
    if (skip && skip(req)) return next();
    const ip = clientIp(req);
    const now = Date.now();
    let entry = hits.get(ip);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + windowMs };
      hits.set(ip, entry);
    }
    entry.count += 1;
    if (entry.count > max) {
      res.set("Retry-After", Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({
        error: "Too many requests",
        message: message || "Demasiadas solicitudes. Intente de nuevo más tarde.",
        // not the free-search limit: too many requests in a short time
        rateLimited: true,
        retryAfterSeconds: Math.ceil((entry.resetAt - now) / 1000),
      });
    }
    next();
  };
}

// Escape user input before putting it into HTML emails
export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function isEmail(value) {
  return typeof value === "string" && value.length <= 254 &&
    /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[a-z]{2,}$/i.test(value.trim());
}

// Trim and cap the length of free-text fields
export function clean(value, max = 500) {
  // only text and numbers are accepted; objects/arrays never reach emails or logs
  const v = typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "";
  return v.trim().slice(0, max);
}

// Order limits, the same the site applies (form and chat): the quantity is a whole number
// of units from 1 to 10,000,000 and the purchase budget goes up to US$100,000,000.
export const QTY_MIN = 1;
export const QTY_MAX = 10_000_000;
export const BUDGET_MAX = 100_000_000;

/**
 * Server-side check of the quantity a request carries ("4", "2,000 piezas", "1.000 unidades").
 * Returns "" when valid (or when there is no number at all), else the reason. The server never
 * rounds or fixes a quantity: an invalid one is rejected so SEAL never receives it as fact.
 */
export function quantityError(value) {
  // only text or a number: an object or an array is not a quantity (it used to be dropped silently)
  if (value !== undefined && value !== null && typeof value !== "string" && typeof value !== "number") return "quantity_invalid";
  if (typeof value === "number" && !Number.isFinite(value)) return "quantity_invalid";
  const v = String(value ?? "").trim();
  if (!v) return "";
  // a notation ("5e2", "10^3"), a range ("5-6", "5 o 6", "5 a 10") or an approximation is not an exact quantity
  if (/\d\s*(?:e[+-]?\d|\^|\*\*|[x×]\s*10\s*\^)/i.test(v)) return "quantity_invalid";
  if (/^\D*\d[\d.,]*\s*(?:-|–|\/|\bo\b|\bó\b|\bor\b|\ba\b|\bto\b|\by\b|\band\b)\s*\d/i.test(v)) return "quantity_invalid";
  if (/^\s*(?:unos|unas|aprox\w*|alrededor|about|around|approximately|entre|between|m[aá]s\s+o\s+menos|cerca\s+de)\b/i.test(v)) return "quantity_invalid";
  const m = v.match(/(?:^|[^\d])([-−]\s?)?(\d[\d.,]*\d|\d)/);
  if (!m) return "";
  if (m[1]) return "quantity_below_min";
  const raw = m[2];
  let n;
  if (/^\d{1,3}(?:([.,])\d{3})(?:\1\d{3})*$/.test(raw)) n = Number(raw.replace(/[.,]/g, ""));
  else if (/[.,]/.test(raw)) return "quantity_not_integer";
  else n = Number(raw);
  if (!Number.isInteger(n)) return "quantity_not_integer";
  if (n < QTY_MIN) return "quantity_below_min";
  if (n > QTY_MAX) return "quantity_above_max";
  return "";
}

/** The purchase budget ("US$5,000", "4500.01", "Q40,000"): "" when valid or absent. */
export function budgetError(value) {
  if (value !== undefined && value !== null && typeof value !== "string" && typeof value !== "number") return "budget_invalid";
  if (typeof value === "number") return !Number.isFinite(value) ? "budget_invalid" : value <= 0 ? "budget_below_min" : value > BUDGET_MAX ? "budget_above_max" : "";
  const v = String(value ?? "").trim();
  if (!v) return "";
  // the formats the site sends ("US$5,000", "5000", "4500.01", "Q40,000"): anything else is malformed
  // ("5e3", "5,00,0", "1.000,50", "12abc", "US$", "cinco mil") — never read partially
  const compact = v.replace(/\s+/g, "");
  if (!/^[-−]?(?:us\$|usd|\$|q\.?|gtq)?[-−]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?(?:usd|d[oó]lares|dollars|gtq|quetzales)?$/i.test(compact)) return "budget_invalid";
  const m = compact.match(/([-−])?(\d[\d,]*(?:\.\d+)?)/);
  if (!m) return "budget_invalid";
  if (m[1] || /^[^\d]*[-−]/.test(compact)) return "budget_below_min";
  const n = Number(m[2].replace(/,/g, ""));
  if (!(n > 0)) return "budget_below_min";
  if (n > BUDGET_MAX) return "budget_above_max";
  return "";
}

/**
 * Fields of a request that must be text (or a plain number): an object or an array in any of them
 * is a malformed request, rejected before anything is registered, counted or emailed (clean()
 * would otherwise turn it into "" and the case would travel without that field, silently).
 */
export function malformedFields(body, textFields, listFields = []) {
  const bad = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return ["body"];
  for (const k of textFields) {
    const v = body[k];
    if (v === undefined || v === null) continue;
    if (typeof v === "string") continue;
    if (typeof v === "number" && Number.isFinite(v)) continue;
    bad.push(k);
  }
  for (const k of listFields) {
    const v = body[k];
    if (v === undefined || v === null) continue;
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) bad.push(k);
  }
  return bad;
}
