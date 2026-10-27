// Free-search quota per email and per IP.
// - The count is reserved when a search starts (so parallel requests can't pass
//   the limit) and given back when the search shows nothing or fails.
// - Emails are compared by a key: lowercase, no "+tag", no dots for Gmail, so
//   "Ana+1@gmail.com" and "a.na@gmail.com" share the same 3 searches.
// - Optional persistence: with DATA_DIR set (a Railway volume), counters are
//   saved to DATA_DIR/quota.json and survive deploys/restarts.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const SEARCH_LIMIT = parseInt(process.env.SEARCH_LIMIT) || 3;
const IP_SEARCH_LIMIT = parseInt(process.env.IP_SEARCH_LIMIT) || 6;
const IP_WINDOW_MS = 24 * 60 * 60 * 1000;
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i;

export { SEARCH_LIMIT, IP_SEARCH_LIMIT };

const QA = new Set(
  String(process.env.QA_EMAILS || "")
    .split(",")
    .map((e) => emailKey(e))
    .filter(Boolean),
);

/** A valid email (max 254 chars), lowercase and trimmed; "" otherwise. */
export function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  const v = value.trim().toLowerCase();
  return v.length <= 254 && EMAIL_RE.test(v) ? v : "";
}

/** The key the quota is counted by. */
export function emailKey(value) {
  const v = normalizeEmail(value);
  if (!v) return "";
  let [user, domain] = v.split("@");
  user = user.replace(/\+.*$/, "");
  if (domain === "gmail.com" || domain === "googlemail.com") {
    user = user.replace(/\./g, "");
    domain = "gmail.com";
  }
  return `${user}@${domain}`;
}

export const isQa = (email) => !!email && QA.has(emailKey(email));

// email key -> { count, pending }
const emails = new Map();
// ip -> { count, pending, resetAt }
const ips = new Map();
// email keys that ran a search (they may receive their report by email)
const searched = new Map(); // key -> lastAt

function ipEntry(ip, create = true) {
  const now = Date.now();
  let e = ips.get(ip);
  if (!e || e.resetAt <= now) {
    if (!create) return { count: 0, pending: 0, resetAt: now + IP_WINDOW_MS };
    e = { count: 0, pending: 0, resetAt: now + IP_WINDOW_MS };
    ips.set(ip, e);
  }
  return e;
}
function emailEntry(key, create = true) {
  let e = emails.get(key);
  if (!e) {
    if (!create) return { count: 0, pending: 0 };
    e = { count: 0, pending: 0 };
    emails.set(key, e);
  }
  return e;
}

/** Why a search can't run now: "email", "ip" or "" (counting searches in progress). */
export function limitReason(email, ip) {
  if (isQa(email)) return "";
  const key = emailKey(email);
  if (key) {
    const e = emailEntry(key, false);
    if (e.count + e.pending >= SEARCH_LIMIT) return "email";
  }
  const i = ipEntry(ip, false);
  if (i.count + i.pending >= IP_SEARCH_LIMIT) return "ip";
  return "";
}

export function remainingSearches(email, ip) {
  if (isQa(email)) return SEARCH_LIMIT;
  const key = emailKey(email);
  const e = key ? emailEntry(key, false) : { count: 0, pending: 0 };
  const i = ipEntry(ip, false);
  return Math.max(0, Math.min(SEARCH_LIMIT - e.count - e.pending, IP_SEARCH_LIMIT - i.count - i.pending));
}

/**
 * Reserves one search synchronously. Returns a ticket with commit() (the
 * search showed results: it counts) and release() (it didn't: give it back),
 * or null when the limit is reached.
 */
export function reserveSearch(email, ip) {
  if (limitReason(email, ip)) return null;
  const qa = isQa(email);
  const key = emailKey(email);
  // only a search that showed results lets this email send its report (see routes/email.js)
  const markSearched = () => {
    if (!key) return;
    searched.set(key, Date.now());
    scheduleSave();
  };
  if (qa) return { commit: markSearched, release() {} };
  const e = key ? emailEntry(key) : null;
  const i = ipEntry(ip);
  if (e) e.pending += 1;
  i.pending += 1;
  let done = false;
  const finish = (counted) => {
    if (done) return;
    done = true;
    if (e) {
      e.pending = Math.max(0, e.pending - 1);
      if (counted) e.count += 1;
      // searches that counted nothing leave no entry behind (memory and quota.json stay small)
      if (!e.count && !e.pending) emails.delete(key);
    }
    i.pending = Math.max(0, i.pending - 1);
    if (counted) i.count += 1;
    if (!i.count && !i.pending) ips.delete(ip);
    if (counted) {
      markSearched();
      scheduleSave();
    }
  };
  return { commit: () => finish(true), release: () => finish(false) };
}

/** The email ran at least one search in the last 7 days. */
export function hasSearched(email) {
  const at = searched.get(emailKey(email));
  return !!at && Date.now() - at < 7 * 24 * 60 * 60 * 1000;
}

// ── Report token: proof that this browser ran the search for this email ─────
// Knowing someone's email is not enough to send a "SEAL report" in their name: the
// search response carries a signed token and /api/email/report requires it.
// The secret comes from REPORT_SECRET, else is kept in DATA_DIR (survives deploys),
// else lives only in memory (tokens then expire with a restart).
let reportSecret = process.env.REPORT_SECRET || "";
if (!reportSecret) {
  const dir = process.env.DATA_DIR || "";
  const file = dir ? path.join(dir, "report-secret") : "";
  try {
    if (file && fs.existsSync(file)) reportSecret = fs.readFileSync(file, "utf8").trim();
  } catch {
    /* unreadable: a new one below */
  }
  if (!reportSecret) {
    reportSecret = crypto.randomBytes(32).toString("hex");
    try {
      // the folder may not exist yet on a fresh volume: without the file, every signed
      // link (follow-up buttons, case pages) would stop working after a restart
      if (file) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, reportSecret, { mode: 0o600 });
      }
    } catch {
      /* no volume: in memory only */
    }
  }
}
/** A signature with the same secret (lead status links, funnel page). */
export function sign(text) {
  return crypto.createHmac("sha256", reportSecret).update(`sig:${text}`).digest("base64url").slice(0, 32);
}
export function verifySigned(text, token) {
  const want = sign(text);
  return typeof token === "string" && token.length === want.length && crypto.timingSafeEqual(Buffer.from(want), Buffer.from(token));
}
export function reportToken(email) {
  const key = emailKey(email);
  if (!key) return "";
  return crypto.createHmac("sha256", reportSecret).update(`report:${key}`).digest("base64url").slice(0, 32);
}
export function verifyReportToken(email, token) {
  const want = reportToken(email);
  if (!want || typeof token !== "string" || token.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(want), Buffer.from(token));
}

// ── Housekeeping: expired IP windows and old "searched" marks are dropped ──
setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of ips) if (e.resetAt <= now && !e.pending) ips.delete(ip);
  for (const [k, at] of searched) if (now - at > 7 * 24 * 60 * 60 * 1000) searched.delete(k);
}, 60 * 60 * 1000).unref();

// ── Optional persistence (DATA_DIR = a mounted volume) ─────────────────────
const DATA_DIR = process.env.DATA_DIR || "";
const FILE = DATA_DIR ? path.join(DATA_DIR, "quota.json") : "";
let saveTimer = null;
function scheduleSave() {
  if (!FILE || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const data = {
        emails: [...emails].map(([k, e]) => [k, e.count]).filter(([, c]) => c > 0),
        ips: [...ips].map(([k, e]) => [k, e.count, e.resetAt]).filter(([, c, r]) => c > 0 && r > Date.now()),
        searched: [...searched],
      };
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(data));
      fs.renameSync(`${FILE}.tmp`, FILE);
    } catch (err) {
      console.error("⚠️ quota save failed:", err.message);
    }
  }, 2000);
  saveTimer.unref?.();
}
if (FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    for (const [k, c] of data.emails || []) emails.set(k, { count: Number(c) || 0, pending: 0 });
    for (const [k, c, r] of data.ips || []) if (r > Date.now()) ips.set(k, { count: Number(c) || 0, pending: 0, resetAt: r });
    for (const [k, at] of data.searched || []) searched.set(k, Number(at) || 0);
    console.log(`📦 quota loaded: ${emails.size} emails, ${ips.size} IPs`);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("⚠️ quota load failed:", err.message);
  }
}
export const quotaPersistent = !!FILE;

/** Writes pending counts now (on shutdown, so a deploy doesn't lose the last seconds). */
export function flushQuota() {
  if (!FILE || !saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    const data = {
      emails: [...emails].map(([k, e]) => [k, e.count]).filter(([, c]) => c > 0),
      ips: [...ips].map(([k, e]) => [k, e.count, e.resetAt]).filter(([, c, r]) => c > 0 && r > Date.now()),
      searched: [...searched],
    };
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(data));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (err) {
    console.error("⚠️ quota flush failed:", err.message);
  }
}
