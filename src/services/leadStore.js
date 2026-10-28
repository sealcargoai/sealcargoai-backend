// Registry of the requests that reach SEAL (one record per case, no duplicates).
// - Every request gets a case number (SEAL-YYYYMMDD-XXXXXX) the client sees.
// - The same person asking again about the same product and supplier while the
//   case is open is the SAME case: it is updated (repeats + 1), not re-created,
//   and SEAL is not emailed again.
// - Status follows the sales funnel: recibido → contactado → calificado →
//   cotizado → cliente (or descartado). Only a person changes it (signed links
//   in SEAL's email); transfers to group companies are never automatic and
//   record who validated them.
// - With DATA_DIR set (Railway volume) the registry is saved to DATA_DIR/leads.json.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { emailKey } from "./quotaStore.js";

export const STATUSES = ["recibido", "contactado", "calificado", "cotizado", "cliente", "descartado"];
export const STAGES = ["recibido", "contactado", "calificado", "cotizado", "cliente"]; // in order
export const GROUP_COMPANIES = ["ImportaGuate", "Courier.com.gt", "DLZ", "DLZ Foods"];
const OPEN_WINDOW = 30 * 24 * 60 * 60 * 1000; // a repeat within 30 days of an open case is the same case
const MAX_LEADS = 5000;

const DATA_DIR = process.env.DATA_DIR || "";
const FILE = DATA_DIR ? path.join(DATA_DIR, "leads.json") : "";
let leads = [];

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/https?:\/\/(www\.)?/g, "")
    .replace(/[?#].*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .slice(0, 80);

/** What makes two requests the same case: person + product + supplier. */
export function dedupeKey({ email, product, supplierUrl, supplierName }) {
  return [emailKey(email) || norm(email), norm(product), norm(supplierUrl || supplierName)].join("|");
}

function newId(now) {
  const d = new Date(now);
  const ymd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  for (;;) {
    const id = `SEAL-${ymd}-${crypto.randomBytes(4).toString("hex").slice(0, 6).toUpperCase()}`;
    if (!leads.some((l) => l.id === id)) return id;
  }
}

const isOpen = (l) => l.status !== "cliente" && l.status !== "descartado";

/**
 * Registers a request. Returns { lead, duplicate }: duplicate = it was already
 * an open case (same person, product and supplier), which is updated instead.
 */
export function registerLead(input, now = Date.now()) {
  const key = dedupeKey({ email: input.contact.email, product: input.case.product || input.case.description, supplierUrl: input.case.supplierUrl, supplierName: input.case.supplierName });
  const existing = leads.find((l) => l.key === key && isOpen(l) && now - l.createdAt < OPEN_WINDOW);
  if (existing) {
    existing.repeats = (existing.repeats || 0) + 1;
    existing.updatedAt = now;
    // the newest data completes the case (never erases what was there); what changed is
    // reported to SEAL (same case number, no duplicate)
    const changes = [];
    for (const [k, v] of Object.entries(input.case)) {
      if (!(Array.isArray(v) ? v.length : v)) continue;
      if (JSON.stringify(existing.case[k]) !== JSON.stringify(v)) changes.push(k);
      existing.case[k] = v;
    }
    for (const [k, v] of Object.entries(input.contact)) {
      if (!v) continue;
      if (k !== "email" && existing.contact[k] !== v) changes.push(k);
      existing.contact[k] = v;
    }
    existing.history.push({ at: now, action: changes.length ? "actualizada" : "repetida", source: input.source, requestType: input.requestType, changes });
    scheduleSave();
    return { lead: existing, duplicate: true, changes };
  }
  const lead = {
    id: newId(now),
    key,
    createdAt: now,
    updatedAt: now,
    status: "recibido",
    reached: 0,
    source: input.source || "",
    requestType: input.requestType || "",
    intent: input.intent || "",
    lang: input.lang === "en" ? "en" : "es",
    test: !!input.test,
    contact: { ...input.contact },
    case: { ...input.case },
    repeats: 0,
    notified: null,
    history: [{ at: now, action: "recibido", source: input.source, requestType: input.requestType }],
  };
  leads.push(lead);
  if (leads.length > MAX_LEADS) leads = leads.slice(-MAX_LEADS);
  scheduleSave();
  return { lead, duplicate: false, changes: [] };
}

export function getLead(id) {
  return leads.find((l) => l.id === id) || null;
}

/** Whether SEAL's inbox got the case email (false = only in the registry: check it). */
export function markNotified(id, ok, error = "", now = Date.now(), emailId = "", to = []) {
  const l = getLead(id);
  if (!l) return;
  l.notified = !!ok;
  // the email service's id: lets the case page check the delivery
  if (ok && emailId) l.emailIds = [...(l.emailIds || []), String(emailId).slice(0, 80)].slice(-10);
  if (ok && Array.isArray(to) && to.length) l.notifiedTo = to.map((x) => String(x).slice(0, 80)).slice(0, 10); // masked
  if (!ok) l.notifyError = String(error).slice(0, 200);
  l.history.push({ at: now, action: ok ? "notificado" : "notificacion_fallida", note: ok ? "" : String(error).slice(0, 200) });
  scheduleSave();
}

/**
 * A person changes the status. A transfer to a group company needs the name of
 * the person who validated it (never automatic). Returns { lead } or { error }.
 */
export function updateLead(id, { status, note = "", by = "", transferTo = "", validatedBy = "", exclude = false }, now = Date.now()) {
  const l = getLead(id);
  if (!l) return { error: "not_found" };
  // every change records who made it (a person) and when
  const who = String(by || validatedBy || "").trim().slice(0, 120);
  if (!who) return { error: "who_required" };
  const entry = { at: now, action: "estado", note: String(note).slice(0, 500), by: who };
  // a controlled test (or spam) that reached the customer routing: kept in the
  // registry, out of the commercial metrics; needs who and why
  if (exclude) {
    if (!String(note).trim()) return { error: "reason_required" };
    if (l.excluded && now - l.excluded.at < 10 * 60 * 1000 && l.excluded.by === who) return { lead: l, repeated: true };
    l.excluded = { by: who, at: now, note: String(note).slice(0, 500) };
    l.updatedAt = now;
    l.history.push({ ...entry, action: "excluido_de_metricas" });
    scheduleSave();
    return { lead: l };
  }
  if (transferTo) {
    if (!GROUP_COMPANIES.includes(transferTo)) return { error: "unknown_company" };
    if (!String(validatedBy).trim()) return { error: "validation_required" };
    l.transfer = { to: transferTo, validatedBy: String(validatedBy).trim().slice(0, 120), at: now };
    entry.action = "derivacion_validada";
    entry.transferTo = transferTo;
    entry.validatedBy = l.transfer.validatedBy;
  }
  if (status) {
    if (!STATUSES.includes(status)) return { error: "bad_status" };
    l.status = status;
    const i = STAGES.indexOf(status);
    if (i > (l.reached || 0)) l.reached = i;
    entry.status = status;
  }
  if (!status && !transferTo) return { error: "nothing_to_change" };
  // the same confirmation sent twice (double click, a resent form, a retry) is recorded once
  const last = l.history[l.history.length - 1];
  if (last && now - last.at < 10 * 60 * 1000 && last.action === entry.action && last.status === entry.status && last.by === entry.by && (last.note || "") === entry.note && (last.transferTo || "") === (entry.transferTo || ""))
    return { lead: l, repeated: true };
  l.updatedAt = now;
  l.history.push(entry);
  scheduleSave();
  return { lead: l };
}

/** Cases still "recibido" (nobody marked contact) after `ageMs`, not reminded yet. */
export function dueForReminder(ageMs, now = Date.now()) {
  return leads.filter((l) => l.status === "recibido" && !l.test && !l.excluded && !l.remindedAt && now - l.createdAt >= ageMs);
}
export function markReminded(id, now = Date.now()) {
  const l = getLead(id);
  if (!l) return;
  l.remindedAt = now;
  l.history.push({ at: now, action: "recordatorio" });
  scheduleSave();
}

export function listLeads({ status = "", sinceMs = 0, includeTest = false } = {}) {
  return leads.filter((l) => (!status || l.status === status) && l.createdAt >= sinceMs && (includeTest || (!l.test && !l.excluded)));
}

/** Requests, then each later stage counted as reached (a client was also quoted). */
export function leadFunnel({ sinceMs = 0, includeTest = false } = {}) {
  const list = listLeads({ sinceMs, includeTest });
  const reached = (i) => list.filter((l) => (l.reached || 0) >= i).length;
  return {
    solicitudes: list.length,
    repetidasAgrupadas: list.reduce((a, l) => a + (l.repeats || 0), 0),
    contactados: reached(1),
    calificados: reached(2),
    cotizaciones: reached(3),
    clientes: reached(4),
    descartados: list.filter((l) => l.status === "descartado").length,
    sinNotificar: list.filter((l) => l.notified === false).length,
    sinAtender: list.filter((l) => l.status === "recibido").length,
  };
}

// ── persistence ─────────────────────────────────────────────────────────────
let saveTimer = null;
function writeNow() {
  if (!FILE) return;
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(leads));
    fs.renameSync(`${FILE}.tmp`, FILE);
  } catch (err) {
    console.error("⚠️ leads save failed:", err.message);
  }
}
function scheduleSave() {
  if (!FILE || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 500);
  saveTimer.unref?.();
}
export function flushLeads() {
  if (!FILE) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  writeNow();
}
if (FILE) {
  try {
    const data = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (Array.isArray(data)) leads = data;
    console.log(`📇 leads loaded: ${leads.length}`);
  } catch (err) {
    if (err.code !== "ENOENT") console.error("⚠️ leads load failed:", err.message);
  }
}
export const leadsPersistent = !!FILE;

/** Tests only. */
export function _resetLeads() {
  leads = [];
}
