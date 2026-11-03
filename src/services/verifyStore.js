// 02-11k — Proof that a person controls an email address.
// A 6-digit code is emailed to the address; entering it returns two random, server-stored credentials:
//   · session     (12 h): «this browser verified this mailbox» — lets a QA account skip search limits
//   · reportGrant (30 min, ONE use): authorizes one report email to that same mailbox
// Nothing is derived from the address (the old report token was an HMAC of the email: anyone who started a
// search with someone else's address received it). Only hashes are kept; codes expire, have 5 attempts and
// are rate limited per address and per IP. Everything lives in memory: a restart just asks for a new code.
import crypto from "node:crypto";
import { identityKey } from "./quotaStore.js";

const CODE_MS = 15 * 60 * 1000;
const SESSION_MS = 12 * 60 * 60 * 1000;
const GRANT_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;
// (review) a code request by someone else must not cancel the owner's code: up to 3 codes are pending per
// address; and wrong guesses are capped per address per day (brute force across many codes and IPs)
const MAX_PENDING = 3;
const FAILS_PER_DAY = 10;
const DAY = 24 * 60 * 60 * 1000;
// per-hour caps of codes sent (an operator may raise them, e.g. for QA campaigns; tests do)
const PER_ADDRESS_HOUR = Math.max(1, parseInt(process.env.VERIFY_MAX_PER_ADDRESS_HOUR) || 3);
const PER_IP_HOUR = Math.max(1, parseInt(process.env.VERIFY_MAX_PER_IP_HOUR) || 10);
const HOUR = 60 * 60 * 1000;

const SECRET = crypto.randomBytes(32);
const h = (x) => crypto.createHmac("sha256", SECRET).update(String(x)).digest("base64url");
const codes = new Map(); // identity -> [{ codeHash, exp, attempts }] (newest last)
const fails = new Map(); // identity -> [timestamps of wrong codes]
const sessions = new Map(); // hash(token) -> { identity, exp }
const grants = new Map(); // hash(token) -> { identity, exp }
const sentByAddress = new Map(); // identity -> [timestamps]
const sentByIp = new Map(); // ip -> [timestamps]

function underHourCap(map, key, max, now) {
  const list = (map.get(key) || []).filter((t) => now - t < HOUR);
  map.set(key, list);
  return list.length < max;
}
const randomToken = () => crypto.randomBytes(32).toString("base64url");

/**
 * A new code for this address → { ok: true, code } | { ok: false, reason: "invalid" | "rate_limited" }.
 * The caller emails the code; the code is never returned to the client.
 */
export function startVerification(email, ip, now = Date.now()) {
  const identity = identityKey(email);
  if (!identity) return { ok: false, reason: "invalid" };
  if (!underHourCap(sentByAddress, identity, PER_ADDRESS_HOUR, now) || !underHourCap(sentByIp, String(ip || ""), PER_IP_HOUR, now))
    return { ok: false, reason: "rate_limited" };
  sentByAddress.get(identity).push(now);
  sentByIp.get(String(ip || "")).push(now);
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const pending = (codes.get(identity) || []).filter((c) => now <= c.exp && c.attempts < MAX_ATTEMPTS);
  pending.push({ codeHash: h(`${identity}|${code}`), exp: now + CODE_MS, attempts: 0 });
  codes.set(identity, pending.slice(-MAX_PENDING));
  return { ok: true, code };
}

/** The code could not be emailed: it is dropped and does not count against the caps. */
export function cancelVerification(email, ip, code, now = Date.now()) {
  const identity = identityKey(email);
  if (!identity) return;
  const want = h(`${identity}|${code}`);
  codes.set(identity, (codes.get(identity) || []).filter((c) => c.codeHash !== want));
  void now;
  for (const [m, k] of [[sentByAddress, identity], [sentByIp, String(ip || "")]]) (m.get(k) || []).pop();
}

/** The code typed by the client → { session, reportGrant } | null (wrong, expired or too many attempts). */
export function confirmVerification(email, code, now = Date.now()) {
  const identity = identityKey(email);
  if (!identity) return null;
  const recentFails = (fails.get(identity) || []).filter((t) => now - t < DAY);
  fails.set(identity, recentFails);
  if (recentFails.length >= FAILS_PER_DAY) return null; // locked for the day (brute force)
  const pending = (codes.get(identity) || []).filter((c) => now <= c.exp && c.attempts < MAX_ATTEMPTS);
  if (!pending.length) {
    codes.delete(identity);
    return null;
  }
  const given = Buffer.from(h(`${identity}|${String(code || "").trim()}`));
  const hit = pending.find((c) => {
    const want = Buffer.from(c.codeHash);
    return given.length === want.length && crypto.timingSafeEqual(given, want);
  });
  if (!hit) {
    for (const c of pending) c.attempts += 1;
    recentFails.push(now);
    codes.set(identity, pending.filter((c) => c.attempts < MAX_ATTEMPTS));
    return null;
  }
  codes.delete(identity); // a code works once (and the other pending ones are no longer needed)
  const session = randomToken();
  const reportGrant = randomToken();
  sessions.set(h(session), { identity, exp: now + SESSION_MS });
  grants.set(h(reportGrant), { identity, exp: now + GRANT_MS });
  return { session, reportGrant, sessionSeconds: SESSION_MS / 1000, grantSeconds: GRANT_MS / 1000 };
}

/** The verified identity of a session token, or "" (unknown, expired, not a string). */
export function sessionIdentity(token, now = Date.now()) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return "";
  const s = sessions.get(h(token));
  if (!s) return "";
  if (now > s.exp) {
    sessions.delete(h(token));
    return "";
  }
  return s.identity;
}
/** Whether this session token proves control of this email address. */
export const sessionVerifies = (token, email, now = Date.now()) => {
  const id = identityKey(email);
  return !!id && sessionIdentity(token, now) === id;
};

/** Whether a report grant is valid for this address (does NOT use it). */
export function grantValid(token, email, now = Date.now()) {
  if (typeof token !== "string" || token.length < 20 || token.length > 100) return false;
  const g = grants.get(h(token));
  const id = identityKey(email);
  return !!g && !!id && g.identity === id && now <= g.exp;
}
/** Uses a report grant (once): true only the first time, for its own address, before it expires. */
export function consumeGrant(token, email, now = Date.now()) {
  if (!grantValid(token, email, now)) return false;
  grants.delete(h(token));
  return true;
}

setInterval(() => {
  const now = Date.now();
  for (const m of [sessions, grants]) for (const [k, v] of m) if (now > v.exp) m.delete(k);
  for (const [k, list] of codes) if (!list.some((c) => now <= c.exp)) codes.delete(k);
  for (const [k, list] of fails) if (!list.some((t) => now - t < DAY)) fails.delete(k);
  for (const m of [sentByAddress, sentByIp]) for (const [k, list] of m) if (!list.some((t) => now - t < HOUR)) m.delete(k);
}, 10 * 60 * 1000).unref();
