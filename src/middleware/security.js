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

// Client IP (Railway sits behind a proxy; app.set("trust proxy", 1) is required)
export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || "unknown";
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
