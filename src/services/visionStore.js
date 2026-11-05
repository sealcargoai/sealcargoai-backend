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
import fs from "node:fs";
import path from "node:path";

const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export const utcDay = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);
const memory = { day: "", used: 0 };

function where() {
  const d = process.env.VISION_DATA_DIR || process.env.DATA_DIR || "";
  return d ? { dir: d, file: path.join(d, "vision-usage.json"), lock: path.join(d, "vision-usage.lock") } : null;
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

function withLock(w, fn) {
  fs.mkdirSync(w.dir, { recursive: true });
  const deadline = Date.now() + 2000;
  let fd;
  for (;;) {
    try {
      fd = fs.openSync(w.lock, "wx", 0o600);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        if (Date.now() - fs.statSync(w.lock).mtimeMs > 10_000) {
          fs.rmSync(w.lock, { force: true });
          continue;
        }
      } catch {
        continue; // released between the open and the stat
      }
      if (Date.now() > deadline) throw new Error("vision usage lock timeout");
      pause(5);
    }
  }
  try {
    return fn();
  } finally {
    fs.closeSync(fd);
    fs.rmSync(w.lock, { force: true });
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
    const used = s.day === day ? s.used : 0;
    if (used >= max) return { ok: false, reason: "daily_limit", used };
    const tmp = `${w.file}.${process.pid}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeSync(fd, JSON.stringify({ day, used: used + 1 }));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, w.file);
    return { ok: true, used: used + 1 };
  });
}

/** For /health: only today's count and where it is kept (no requests, addresses or photos). */
export function visionUsage(now = Date.now()) {
  const day = utcDay(now);
  const w = where();
  if (!w) return { store: "memory", usedToday: memory.day === day ? memory.used : 0 };
  try {
    const s = readState(w.file);
    return { store: "persistent", usedToday: s.day === day ? s.used : 0 };
  } catch {
    return { store: "error", usedToday: null };
  }
}

/** Tests only: forget the in-memory count. */
export function resetMemoryUsage() {
  memory.day = "";
  memory.used = 0;
}
