// 02-11z: the daily cap of photo analyses, kept on disk so a restart or a deploy does not reset it.
//
// Where: VISION_DATA_DIR or DATA_DIR (on Railway, the mounted volume) → vision-usage.json { day, used }.
// How: every reservation takes an exclusive lock file (open "wx"), reads, checks, writes a temp file,
// fsyncs and renames it over the old one, then releases the lock. The lock is held only for that short,
// synchronous step, so concurrent requests in this process and any other process sharing the folder (an
// old and a new container during a deploy) never count past the cap. A lock older than 10 s (a crashed
// process) is taken over.
// Day: the UTC date; a new day starts at 0.
// If the folder can't be read or written, or the file is damaged, the reservation throws: the caller
// answers "unavailable" WITHOUT calling the AI provider (fail closed), and /health says store: "error".
// Without any data folder (local development) the count lives in memory and /health says store: "memory".
// Scope: this caps the analyses THIS service asks for. It does not see other apps using the same Groq key,
// and it holds only while the volume is mounted (Railway attaches a volume to one service).
// 02-11z2 (review):
// - On Railway, a folder that is NOT inside the mounted volume (volume detached, wrong DATA_DIR) would be
//   created on the container's temporary disk and reset on every deploy: then the store refuses (fail closed,
//   /health store "not-on-volume") instead of pretending to be persistent.
// - Every lock holds its own random token. Taking over an old lock renames it first and checks it is still
//   that old lock (same token, still old), and a release only removes the lock with its own token: two processes that both find the same old lock cannot both get in.
// - A failed write (disk full, no permission) removes its temp file and leaves the last good count in place.
// - The day never goes backwards: if another instance's clock already wrote a later UTC day, that day and
//   its count are kept (a slightly late clock cannot reset the count to 0).
// - The day is the UTC date whatever TZ says: in Guatemala (UTC-6) the quota starts again at 18:00.
import fs from "node:fs";
import path from "node:path";

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const memory = { day: "", used: 0 };

const onRailway = () => !!(process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID || process.env.RAILWAY_ENVIRONMENT_NAME);
function insideVolume(dir) {
  const vol = process.env.RAILWAY_VOLUME_MOUNT_PATH || "";
  if (!vol) return false;
  const d = path.resolve(dir);
  const v = path.resolve(vol);
  return d === v || d.startsWith(v + path.sep);
}

function where() {
  const d = process.env.VISION_DATA_DIR || process.env.DATA_DIR || "";
  if (!d) return null;
  return { dir: d, file: path.join(d, "vision-usage.json"), lock: path.join(d, "vision-usage.lock"), notOnVolume: onRailway() && !insideVolume(d) };
}

function readState(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { day: "", used: 0 };
    throw e;
  }
  const j = JSON.parse(raw);
  if (typeof j?.day !== "string" || !Number.isInteger(j?.used) || j.used < 0) throw new Error("vision-usage.json is damaged");
  return { day: j.day, used: j.used };
}

const readToken = (file) => {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

function withLock(w, fn) {
  if (w.notOnVolume) throw new Error("vision usage folder is not on the mounted volume");
  fs.mkdirSync(w.dir, { recursive: true });
  const deadline = Date.now() + 2000;
  // each lock carries its own token: inode numbers are reused by the file system, so they cannot tell an old
  // lock from a new one
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(w.lock, "wx", 0o600);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let st;
      try {
        st = fs.statSync(w.lock);
      } catch {
        continue; // released between the open and the stat
      }
      if (Date.now() - st.mtimeMs > 10_000) {
        takeOver(w.lock, readToken(w.lock));
        continue;
      }
      if (Date.now() > deadline) throw new Error("vision usage lock timeout");
      pause(5);
    }
  }
  try {
    fs.writeSync(fd, token);
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(w.lock, { force: true });
    throw e;
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    // only the lock this call created (if it was ever taken over as old, the new holder's stays)
    if (readToken(w.lock) === token) fs.rmSync(w.lock, { force: true });
  }
}

// An old lock is moved aside (rename is atomic: only one process moves a given file). If what was moved is not
// the old lock that was examined (its token differs, or it is recent: someone else took it over and created a
// fresh one meanwhile), it is put back with link(), which never overwrites, and nobody enters on that turn.
function takeOver(lock, seenToken) {
  const aside = `${lock}.old-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    fs.renameSync(lock, aside);
  } catch {
    return; // someone else moved it first
  }
  try {
    let recent = true;
    try {
      recent = Date.now() - fs.statSync(aside).mtimeMs <= 10_000;
    } catch {
      /* treat as recent */
    }
    if (recent || readToken(aside) !== seenToken) {
      try {
        fs.linkSync(aside, lock);
      } catch {
        /* a newer lock already exists: that one wins */
      }
    }
  } finally {
    fs.rmSync(aside, { force: true });
  }
}

function syncDir(dir) {
  // makes the rename itself durable; some file systems do not allow fsync on a folder (then it is skipped)
  let fd;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    /* not supported */
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Takes one analysis from today's cap: { ok: true, used } or { ok: false, reason: "daily_limit", used }. Throws if the store fails. */
export function reserveVision(max, now = Date.now()) {
  const day = utcDay(now);
  const w = where();
  if (!w) {
    if (memory.day !== day) Object.assign(memory, { day, used: 0 });
    if (memory.used >= max) return { ok: false, reason: "daily_limit", used: memory.used };
    memory.used += 1;
    return { ok: true, used: memory.used };
  }
  return withLock(w, () => {
    const s = readState(w.file);
    // the day never goes backwards (another instance's clock may be a little ahead)
    const today = s.day > day ? s.day : day;
    const used = s.day === today ? s.used : 0;
    if (used >= max) return { ok: false, reason: "daily_limit", used };
    const tmp = `${w.file}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(tmp, "w", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ day: today, used: used + 1 }));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, w.file);
    } catch (e) {
      fs.rmSync(tmp, { force: true });
      throw e;
    }
    syncDir(w.dir);
    return { ok: true, used: used + 1 };
  });
}

/** For /health: only today's count and where it is kept (no requests, addresses or photos). */
export function visionUsage(now = Date.now()) {
  const day = utcDay(now);
  const w = where();
  if (!w) return { store: "memory", usedToday: memory.day === day ? memory.used : 0 };
  if (w.notOnVolume) return { store: "not-on-volume", usedToday: null };
  try {
    const s = readState(w.file);
    return { store: "persistent", usedToday: s.day === day ? s.used : s.day > day ? s.used : 0 };
  } catch {
    return { store: "error", usedToday: null };
  }
}

/** Tests only: the old-lock takeover step. */
export const takeOverForTests = takeOver;

/** Tests only: forget the in-memory count. */
export function resetMemoryUsage() {
  memory.day = "";
  memory.used = 0;
}
