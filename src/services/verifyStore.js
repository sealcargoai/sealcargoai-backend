// Proof that a person controls an email address (02-11k; shared store and abuse controls since 02-11l/m).
// A 10-character code (32 symbols: A–Z without I/O, 2–9; about 50 bits) is emailed to the address.
// Entering it returns two random credentials:
//   · session     (12 h): «this browser verified this mailbox», which lets a QA account skip search limits
//   · reportGrant (30 min, ONE use): authorizes one report email to that same mailbox
//
// Storage (02-11l). With DATA_DIR set (the Railway volume) the state lives in DATA_DIR/verify.json. Every
// operation takes an exclusive lock file, reads, changes and replaces the file atomically, so operations
// are serialized across processes sharing the volume and a grant can be used only once.
// Without DATA_DIR it stays in memory (tests, local); /health says which («verifyStore»).
// If the store cannot be read or written, the operation throws VerifyStoreError: callers refuse (fail closed).
//
// Nothing is stored in clear: codes, tokens, addresses and IPs are stored as HMAC-SHA256 with a secret
// from VERIFY_SECRET, else derived from the signing secret (REPORT_SECRET or DATA_DIR/report-secret).
//
// Abuse controls (02-11m). Anyone can ask for a code for any address, and every code they ask for reaches
// the OWNER's inbox. So the design keeps every code the owner receives usable, and caps volume per hour:
//   · up to 3 codes per hour per (address, IP), with a progressive wait between them (0 s, 30 s, 60 s)
//   · up to 6 codes per hour per address; past them, a connection that asked at most once for that address
//     in the last hour and has not been locked for wrong codes still gets a code, up to 12 per hour
//   · 10 per hour per IP; 300 per hour for the whole service; 30,000 tracked keys
//   · a new code never cancels an earlier one: every code sent in the last 15 minutes stays valid
//   · wrong codes lock only the (address, IP) that typed them: 5 per hour. There is NO lock per address
//     (a lock per address was a way for a third
//     party to keep the owner out (02-11m review). No daily cap per address either (a cap that lasts a day
//     was the same kind of lever); the hourly caps bound the volume a third party can send.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { identityKey, deriveKey, signingSecretShared } from "./quotaStore.js";

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const num = (v, d) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : d;
};

export class VerifyStoreError extends Error {
  constructor(msg) {
    super(msg);
    this.code = "VERIFY_STORE";
  }
}

// 32 symbols without look-alikes (no I, O, 0, 1). 02-11n: 10 of them ≈ 50 bits (it was 8 ≈ 40 bits: the
// risk note of 02-11m understated the brute-force bound; see scripts/riesgo-codigos.mjs)
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 10;
/** What the person typed → the canonical code: uppercase, without spaces or dashes. */
export const normalizeCode = (x) => String(x || "").toUpperCase().replace(/[\s-]/g, "");
const randomToken = () => crypto.randomBytes(32).toString("base64url");
const okToken = (t) => typeof t === "string" && t.length >= 20 && t.length <= 100;

/**
 * A verification store. `dir` = a shared folder (persistent) or "" (memory). Exposed for tests (several
 * instances on one folder = several processes on one volume); the app uses the default instance below.
 */
export function createVerifyStore({ dir = "", secret, env = process.env } = {}) {
  const L = {
    codeMs: 15 * MIN,
    sessionMs: 12 * HOUR,
    grantMs: 30 * MIN,
    perAddressIpHour: num(env.VERIFY_MAX_PER_ADDRESS_IP_HOUR, 3),
    perAddressHour: num(env.VERIFY_MAX_PER_ADDRESS_HOUR, 6),
    // 02-11m: past the 6/hour, a connection with at most one request for this address in the last hour (and
    // not locked for wrong codes) still gets a code, up to 12/hour per address
    perAddressHardHour: num(env.VERIFY_MAX_PER_ADDRESS_HARD_HOUR, 12),
    perIpHour: num(env.VERIFY_MAX_PER_IP_HOUR, 10),
    waitSeconds: env.VERIFY_RESEND_WAIT_SECONDS === "0" ? 0 : num(env.VERIFY_RESEND_WAIT_SECONDS, 30),
    failsPerAddressIpHour: 5,
    globalHour: num(env.VERIFY_MAX_GLOBAL_HOUR, 300),
    maxTracked: num(env.VERIFY_MAX_TRACKED, 30000),
  };
  const key = secret || (env.VERIFY_SECRET ? Buffer.from(env.VERIFY_SECRET) : deriveKey("verify-store"));
  // the stored hashes are only usable after a restart / by another process if the key is shared too
  const keyShared = !!secret || !!env.VERIFY_SECRET || signingSecretShared;
  const h = (x) => crypto.createHmac("sha256", key).update(String(x)).digest("base64url");
  const file = dir ? path.join(dir, "verify.json") : "";
  const lock = file ? `${file}.lock` : "";
  let memory = empty();

  function empty() {
    return { codes: {}, sessions: {}, grants: {}, sent: {}, fails: {}, reports: {} };
  }
  function prune(s, now) {
    for (const k of Object.keys(s.codes)) {
      s.codes[k] = s.codes[k].filter((c) => now <= c.exp);
      if (!s.codes[k].length) delete s.codes[k];
    }
    for (const m of [s.sessions, s.grants]) for (const k of Object.keys(m)) if (now > m[k].exp) delete m[k];
    for (const [m, win] of [
      [s.sent, HOUR],
      [s.fails, DAY],
      [s.reports, DAY],
    ])
      for (const k of Object.keys(m)) {
        m[k] = m[k].filter((t) => now - t < win);
        if (!m[k].length) delete m[k];
      }
  }
  // Exclusive lock: a file created with «wx» holding a random nonce. A transaction takes milliseconds, so
  // a lock older than 2 s belongs to a crashed process: it is taken over by an atomic rename (only one
  // process can win it), and a process only ever removes a lock that still holds ITS nonce.
  // The wait is short (≤ 1 s) because it blocks this process; past it the operation fails closed (503).
  function acquire() {
    const nonce = crypto.randomBytes(12).toString("hex");
    const until = Date.now() + 1 * SEC;
    for (;;) {
      try {
        fs.writeFileSync(lock, nonce, { flag: "wx", mode: 0o600 });
        return nonce;
      } catch (e) {
        if (e.code !== "EEXIST") throw new VerifyStoreError(`lock: ${e.code || e.message}`);
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 2 * SEC) {
            const aside = `${lock}.stale-${nonce}`;
            fs.renameSync(lock, aside); // atomic: of several processes, one moves it
            fs.rmSync(aside, { force: true });
            continue;
          }
        } catch {
          /* someone else took it over or released it: try again */
        }
        if (Date.now() > until) throw new VerifyStoreError("lock: timeout");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
      }
    }
  }
  function release(nonce) {
    try {
      if (fs.readFileSync(lock, "utf8") === nonce) fs.rmSync(lock, { force: true });
    } catch {
      /* already gone */
    }
  }
  /** Runs fn(state) as one atomic operation and saves the result. */
  function tx(now, fn) {
    if (!file) {
      prune(memory, now);
      return fn(memory);
    }
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      throw new VerifyStoreError(`dir: ${e.code || e.message}`);
    }
    const nonce = acquire();
    try {
      let s;
      try {
        s = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") s = empty();
        else if (e instanceof SyntaxError) {
          // a damaged file is set aside and the store starts empty: only credentials and counters are lost
          // (users ask for a new code); nothing is granted from a file that cannot be read
          console.error("⚠️ verify store: damaged file set aside");
          try {
            fs.renameSync(file, `${file}.damaged-${now}`);
          } catch (err) {
            throw new VerifyStoreError(`read: ${err.code || "invalid"}`);
          }
          s = empty();
        } else throw new VerifyStoreError(`read: ${e.code || "invalid"}`);
      }
      s = { ...empty(), ...s };
      const before = JSON.stringify(s);
      prune(s, now);
      const out = fn(s);
      const after = JSON.stringify(s);
      // 02-11l: a read that changed nothing (and pruned nothing) is not written
      if (after === before) return out;
      // a bound on the file: with too many tracked addresses/IPs, new code requests are refused (below)
      try {
        const tmp = `${file}.${crypto.randomBytes(6).toString("hex")}.tmp`;
        const fd = fs.openSync(tmp, "w", 0o600);
        try {
          fs.writeSync(fd, after);
          fs.fsyncSync(fd); // on disk before it replaces the old file (a host crash leaves old or new)
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(tmp, file);
      } catch (e) {
        throw new VerifyStoreError(`write: ${e.code || e.message}`);
      }
      return out;
    } finally {
      release(nonce);
    }
  }
  const recent = (list, now, win) => (list || []).filter((t) => now - t < win);

  return {
    persistent: !!file,
    keyShared,
    limits: L,
    /**
     * A new code → { ok: true, code } | { ok: false, reason: "invalid" } | { ok: false, reason: "rate_limited",
     * retryAfterSeconds }. The caller emails the code; it is never returned to the client.
     */
    start(email, ip, now = Date.now(), { noCode = false } = {}) {
      const identity = identityKey(email);
      if (!identity) return { ok: false, reason: "invalid" };
      const A = `a:${h(identity)}`;
      const I = `i:${h(String(ip || ""))}`;
      const AI = `ai:${h(`${identity}|${ip || ""}`)}`;
      return tx(now, (s) => {
        const ai = recent(s.sent[AI], now, HOUR);
        const a = recent(s.sent[A], now, HOUR);
        const i = recent(s.sent[I], now, HOUR);
        // waits longer than 5 minutes are rounded up to 5 minutes (they would tell when others asked)
        const limited = (t) => {
          const secs = Math.max(1, Math.ceil(t / SEC));
          return { ok: false, reason: "rate_limited", retryAfterSeconds: secs > 300 ? Math.ceil(secs / 300) * 300 : secs };
        };
        const oldest = (list) => HOUR - (now - Math.min(...list));
        // a connection with at most one request for this address in the last hour, not locked for wrong codes
        const lockedHere = recent(s.fails[`fai:${h(`${identity}|${ip || ""}`)}`], now, HOUR).length >= L.failsPerAddressIpHour;
        const reserved = ai.length < 2 && !lockedHere;
        if (ai.length >= L.perAddressIpHour) return limited(oldest(ai));
        if (a.length >= L.perAddressHour && !(reserved && a.length < L.perAddressHardHour)) return limited(oldest(a));
        if (i.length >= L.perIpHour) return limited(oldest(i));
        // global bounds: codes per hour for the whole service (protects the sender's reputation) and the
        // number of tracked keys (protects the file size); past them, nobody gets a new code for a while
        const g = recent(s.sent.g, now, HOUR);
        if (g.length >= L.globalHour || Object.keys(s.sent).length >= L.maxTracked) return limited(g.length ? oldest(g) : 5 * MIN);
        // progressive wait for the same (address, IP): 0 s, then 30 s, then 60 s
        if (ai.length && L.waitSeconds) {
          const wait = L.waitSeconds * SEC * 2 ** (ai.length - 1) - (now - Math.max(...ai));
          if (wait > 0) return limited(wait);
        }
        for (const k of [AI, A, I, "g"]) (s.sent[k] = s.sent[k] || []).push(now);
        // SEAL's own sales addresses: counted like any other, but no code exists (nothing to guess)
        if (noCode) return { ok: true, code: "" };
        const code = Array.from({ length: CODE_LENGTH }, () => CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)]).join("");
        (s.codes[A] = s.codes[A] || []).push({ c: h(`${identity}|${code}`), exp: now + L.codeMs, ai: AI, i: I, t: now });
        return { ok: true, code };
      });
    },
    /** The code could not be emailed: it is dropped and does not count against the caps. */
    cancel(email, ip, code, now = Date.now()) {
      const identity = identityKey(email);
      if (!identity) return;
      const A = `a:${h(identity)}`;
      const want = h(`${identity}|${code}`);
      tx(now, (s) => {
        const c = (s.codes[A] || []).find((x) => x.c === want);
        if (!c) return;
        s.codes[A] = s.codes[A].filter((x) => x !== c);
        for (const [m, k] of [[s.sent, A], [s.sent, c.ai], [s.sent, c.i], [s.sent, "g"]]) {
          const list = m[k] || [];
          const at = list.lastIndexOf(c.t);
          if (at >= 0) list.splice(at, 1);
        }
      });
    },
    /** The typed code → { session, reportGrant, … } | null (wrong, expired, or locked by failures). */
    confirm(email, code, ip, now = Date.now()) {
      const identity = identityKey(email);
      if (!identity) return null;
      const A = `a:${h(identity)}`;
      const FAI = `fai:${h(`${identity}|${ip || ""}`)}`;
      const given = Buffer.from(h(`${identity}|${normalizeCode(code)}`));
      return tx(now, (s) => {
        if (recent(s.fails[FAI], now, HOUR).length >= L.failsPerAddressIpHour) return null;
        const pending = s.codes[A] || [];
        const hit = pending.find((c) => {
          const want = Buffer.from(c.c);
          return want.length === given.length && crypto.timingSafeEqual(want, given);
        });
        if (!hit) {
          // a wrong code never voids a code the owner received: it only counts against this IP and address
          (s.fails[FAI] = s.fails[FAI] || []).push(now);
          return null;
        }
        delete s.codes[A]; // a code works once; the other pending ones are no longer needed
        const session = randomToken();
        const reportGrant = randomToken();
        const ID = h(identity);
        s.sessions[h(`s|${session}`)] = { id: ID, exp: now + L.sessionMs };
        s.grants[h(`g|${reportGrant}`)] = { id: ID, exp: now + L.grantMs };
        return { session, reportGrant, sessionSeconds: L.sessionMs / SEC, grantSeconds: L.grantMs / SEC };
      });
    },
    /**
     * 02-11l→m: daily report caps (they lived in each process's memory: a restart reset them and every
     * process had its own). Read-only check, used before reading the PDF.
     */
    reportCapOk(toKey, byKey, caps, now = Date.now()) {
      const T = `rt:${h(toKey)}`;
      const B = `rb:${h(byKey)}`;
      return tx(now, (s) => recent(s.reports[T], now, DAY).length < caps.to && recent(s.reports[B], now, DAY).length < caps.by);
    },
    /**
     * Uses the report grant AND counts the report in one atomic operation: «grant» (not valid / already used),
     * «limit» (daily cap reached; the grant is NOT used) or «ok».
     */
    consumeGrantAndCount(token, email, toKey, byKey, caps, now = Date.now()) {
      const identity = identityKey(email);
      if (!identity || !okToken(token)) return "grant";
      const T = `rt:${h(toKey)}`;
      const B = `rb:${h(byKey)}`;
      return tx(now, (s) => {
        const k = h(`g|${token}`);
        if (s.grants[k]?.id !== h(identity)) return "grant";
        if (recent(s.reports[T], now, DAY).length >= caps.to || recent(s.reports[B], now, DAY).length >= caps.by) return "limit";
        delete s.grants[k];
        (s.reports[T] = s.reports[T] || []).push(now);
        (s.reports[B] = s.reports[B] || []).push(now);
        return "ok";
      });
    },
    /** Whether this session token proves control of this address. */
    sessionVerifies(token, email, now = Date.now()) {
      const identity = identityKey(email);
      if (!identity || !okToken(token)) return false;
      return tx(now, (s) => s.sessions[h(`s|${token}`)]?.id === h(identity));
    },
    /** Whether a report grant is valid for this address (does NOT use it). */
    grantValid(token, email, now = Date.now()) {
      const identity = identityKey(email);
      if (!identity || !okToken(token)) return false;
      return tx(now, (s) => s.grants[h(`g|${token}`)]?.id === h(identity));
    },
    /** Uses a report grant: true only once (atomic across processes), for its own address, before it expires. */
    consumeGrant(token, email, now = Date.now()) {
      const identity = identityKey(email);
      if (!identity || !okToken(token)) return false;
      return tx(now, (s) => {
        const k = h(`g|${token}`);
        if (s.grants[k]?.id !== h(identity)) return false;
        delete s.grants[k];
        return true;
      });
    },
  };
}

/** 02-11n: the parameters the brute-force bound depends on (scripts/riesgo-codigos.mjs, test/riesgo-codigos). */
export function codeRiskParams(env = process.env) {
  const L = createVerifyStore({ secret: Buffer.from("params"), env }).limits;
  return {
    alphabet: CODE_ALPHABET.length,
    length: CODE_LENGTH,
    codeMinutes: L.codeMs / MIN,
    maxCodesPerHour: L.perAddressHardHour,
    failsPerIpHour: L.failsPerAddressIpHour,
  };
}

// ── The app's store ──────────────────────────────────────────────────────────
// VERIFY_DATA_DIR may point elsewhere (a separate volume); by default the app's DATA_DIR volume
const store = createVerifyStore({ dir: process.env.VERIFY_DATA_DIR || process.env.DATA_DIR || "" });
export const verifyPersistent = store.persistent;
/** /health: "persistent" | "persistent-ephemeral-key" (hashes unusable after a restart) | "memory". */
export const verifyStoreStatus = () => (!store.persistent ? "memory" : store.keyShared ? "persistent" : "persistent-ephemeral-key");
export const startVerification = (email, ip, now, opts) => store.start(email, ip, now, opts);
export const cancelVerification = (email, ip, code, now) => store.cancel(email, ip, code, now);
export const confirmVerification = (email, code, ip, now) => store.confirm(email, code, ip, now);
export const grantValid = (token, email, now) => store.grantValid(token, email, now);
export const consumeGrant = (token, email, now) => store.consumeGrant(token, email, now);
export const reportCapOk = (toKey, byKey, caps, now) => store.reportCapOk(toKey, byKey, caps, now);
export const consumeGrantAndCount = (token, email, toKey, byKey, caps, now) => store.consumeGrantAndCount(token, email, toKey, byKey, caps, now);
/** For limiters: a store error means «not verified» (fail closed: normal limits apply). */
export const sessionVerifies = (token, email, now) => {
  try {
    return store.sessionVerifies(token, email, now);
  } catch (err) {
    console.error("⚠️ verify store unavailable:", err.message);
    return false;
  }
};
