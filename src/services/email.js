import { Resend } from "resend";
import { escapeHtml as e } from "../middleware/security.js";
import { isQa, isQaMailbox, emailKey, mailboxAddress } from "./quotaStore.js";

// ── 02-11l: sender status, read-only, for /health (never the address, the key or the domain name) ──
// from:   "custom" (RESEND_FROM set to another domain) | "resend-test-sender" (onboarding@resend.dev, which
//         Resend only lets deliver to the account owner) | "invalid"
// domain: the status Resend reports for the sender's domain via GET /domains (no email is sent):
//         "verified" | "pending" | "failed" | "temporary_failure" | "not_started" | "not_found" |
//         "not_checkable_with_key" (02-11q: the API key cannot read domains, e.g. a sending-only key; says nothing about the domain or delivery) | "unknown"
const fromDomain = () => (String(FROM_EMAIL).match(/@([^\s>]+)>?\s*$/)?.[1] || "").toLowerCase();
let senderCheck = { domain: "unknown", at: 0 };
export function senderStatus() {
  const d = fromDomain();
  return { from: !d ? "invalid" : d === "resend.dev" ? "resend-test-sender" : "custom", domain: senderCheck.domain };
}
export async function checkSenderDomain() {
  const d = fromDomain();
  if (emailDryRun() || !process.env.RESEND_API_KEY || !d || d === "resend.dev") return senderStatus();
  try {
    const ctl = AbortSignal.timeout(6000);
    const res = await fetch("https://api.resend.com/domains", { headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` }, signal: ctl });
    if (res.status === 401 || res.status === 403) senderCheck = { domain: "not_checkable_with_key", at: Date.now() };
    else if (!res.ok) senderCheck = { domain: "unknown", at: Date.now() };
    else {
      const list = (await res.json())?.data || [];
      // exactly the sender's domain (a sending subdomain is verified on its own at Resend)
      const hit = list.find((x) => typeof x?.name === "string" && d === x.name.toLowerCase());
      senderCheck = { domain: hit ? String(hit.status || "unknown") : "not_found", at: Date.now() };
    }
  } catch {
    senderCheck = { domain: "unknown", at: Date.now() };
  }
  return senderStatus();
}

/* ─────────────────────────────────────────────
   Safe Resend Client Creator
───────────────────────────────────────────── */
// EMAIL_DRY_RUN=1 (staging / preview / tests): no email can leave this server. Every send is
// replaced by a log line with no addresses or content, and answers like Resend would.
export const emailDryRun = () => process.env.EMAIL_DRY_RUN === "1";
let dryN = 0;
const dryClient = {
  emails: {
    send: async (msg) => {
      const n = Array.isArray(msg?.to) ? msg.to.length : msg?.to ? 1 : 0;
      console.log(`✉️  [EMAIL_DRY_RUN] email suppressed (${n} recipient(s), not sent)`);
      return { data: { id: `dry-run-${Date.now()}-${++dryN}` }, error: null };
    },
    get: async () => ({ data: { last_event: "dry_run" }, error: null }),
  },
};
// ── 02-11q: what Resend answered to the real sends since this process started, for /health ──
// Counts and times only: never an address, subject, id or the error text (it can carry addresses).
// «accepted» means Resend took the email for delivery; it is NOT proof it reached an inbox.
const sendStats = { since: new Date().toISOString(), accepted: 0, refused: 0, lastAcceptedAt: null, lastRefusedAt: null, lastRefusal: null };
const refusalKind = (err) => {
  const name = String(err?.name || "");
  if (/^[a-z_]{3,40}$/.test(name) && name !== "application_error") return name;
  const m = String(err?.message || "");
  if (/domain.*not verified|verify a domain/i.test(m)) return "domain_not_verified";
  if (/api key|unauthori|forbidden/i.test(m)) return "api_key";
  if (/rate limit|too many/i.test(m)) return "rate_limit";
  if (/timeout|ETIMEDOUT|ECONNRE|ENOTFOUND|fetch failed/i.test(m)) return "network";
  return "other";
};
function refused(err) {
  sendStats.refused++;
  sendStats.lastRefusedAt = new Date().toISOString();
  sendStats.lastRefusal = refusalKind(err);
}
export function emailSendStats() {
  return { ...sendStats };
}
function tracked(client) {
  return {
    emails: {
      get: (...a) => client.emails.get(...a),
      send: async (msg) => {
        try {
          const r = await client.emails.send(msg);
          if (r?.error) refused(r.error);
          else {
            sendStats.accepted++;
            sendStats.lastAcceptedAt = new Date().toISOString();
          }
          return r;
        } catch (err) {
          refused(err);
          throw err;
        }
      },
    },
  };
}
function getResendClient() {
  if (emailDryRun()) return dryClient;
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not defined in environment");
  }

  return tracked(new Resend(apiKey));
}

// ── Who receives what ─────────────────────────────────────────────────────────
// Real client data goes ONLY to SEAL's commercial owners:
//   LEADS_EMAIL (default ventas@seal.com.gt) + LEADS_CC (comma list, optional, authorized
//   commercial copies).
// Development copies (ADMIN_EMAIL, ADMIN2_EMAIL, QA_NOTIFY_EMAILS) receive ONLY identified
// test records, unless DEV_COPIES_REAL_LEADS=1 records an explicit authorization.
// Test records go ONLY to the QA inbox (QA_LEADS_EMAIL) plus the development copies. 02-11c: when
// the QA inbox is missing, invalid or is a commercial address, a test record is NOT emailed at all
// (it used to fall back to the commercial inbox): the send is refused with QA_ROUTING_UNAVAILABLE.
const LEADS_EMAIL = process.env.LEADS_EMAIL || "ventas@seal.com.gt";
const emailList = (...values) =>
  [...new Set(values.flatMap((v) => String(v || "").split(",")).map((x) => x.trim().toLowerCase()).filter((x) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(x)))];
const COMMERCIAL = emailList(LEADS_EMAIL, process.env.LEADS_CC);
// 02-11e: commercial addresses are matched BROADLY (emailKey: case, «+etiqueta» and Gmail dots ignored) to REFUSE them;
// «ventas+qa@…» is delivered to ventas@: it is a commercial address, never a QA one.
const COMMERCIAL_KEYS = new Set(COMMERCIAL.map((x) => emailKey(x)).filter(Boolean));
const isCommercial = (x) => COMMERCIAL_KEYS.has(emailKey(x));
/** 02-11k: an address that may reach sales (verification codes are never sent there). */
export const isCommercialAddress = (x) => isCommercial(x);
const DEV_COPIES = emailList(process.env.ADMIN_EMAIL, process.env.ADMIN2_EMAIL, process.env.QA_NOTIFY_EMAILS).filter((x) => !isCommercial(x));
const QA_INBOX_RAW = String(process.env.QA_LEADS_EMAIL || "").trim();
const QA_INBOX = emailList(QA_INBOX_RAW);
// 02-11f: the QA inbox as an exact mailbox (an authorization; see mailboxAddress)
const QA_INBOX_MAILBOXES = new Set(QA_INBOX.map((x) => mailboxAddress(x)).filter(Boolean));
const DEV_GETS_REAL = process.env.DEV_COPIES_REAL_LEADS === "1";

// 02-11c: a test is identified ONLY by an explicit signal: the requester's email is in the QA
// allow-list (QA_EMAILS). Words in the name, the email or the product ("demo", "unidad de prueba",
// "testing", "ejemplo") never make a record a test: a real lead used to be marked [PRUEBA] by them.
/** A test record: the email (or, for a report, the requester's email) is a QA account. */
export function isTestRecord(...emails) {
  return emails.some((x) => isQa(x));
}
/** The subject tag of a test record. */
export const qaTag = (test) => (test ? "[PRUEBA] " : "");
/**
 * Whether test records can be routed: "ok" | "missing" (QA_LEADS_EMAIL not set) | "invalid" (set, no
 * valid address) | "overlaps_commercial" (a QA inbox address is also a commercial one). Only the
 * status is exposed, never the addresses.
 */
export function qaRouting() {
  // the same configuration read once at start (as the recipient lists): status and routing never disagree
  if (!QA_INBOX_RAW) return "missing";
  if (!QA_INBOX.length) return "invalid";
  if (QA_INBOX.some((x) => isCommercial(x))) return "overlaps_commercial";
  return "ok";
}
export class QaRoutingError extends Error {
  constructor() {
    super("QA_ROUTING_UNAVAILABLE");
    this.code = "qa_routing_unavailable";
  }
}
/**
 * Recipients for a record: real → commercial only (+ dev copies only with explicit authorization);
 * test → QA inbox + dev copies, and NOTHING when QA routing is not "ok" (throws QaRoutingError):
 * a test never reaches sales.
 */
export function recipientsFor(test) {
  if (test) {
    if (qaRouting() !== "ok") throw new QaRoutingError();
    return [...new Set([...QA_INBOX, ...DEV_COPIES])].filter((x) => !isCommercial(x));
  }
  return [...new Set([...COMMERCIAL, ...(DEV_GETS_REAL ? DEV_COPIES : [])])];
}
/**
 * 02-11e/f: a recipient a QA operation may send a report to: an address written in QA_EMAILS or the QA
 * inbox (QA_LEADS_EMAIL), compared by EXACT mailbox (trimmed, lowercase; Gmail's documented rule only),
 * and never a commercial address. The two comparisons are deliberately different: anything that MIGHT
 * reach sales is refused (broad emailKey: «ventas+x@», «VENTAS@»), and only what surely reaches a QA
 * mailbox is allowed (exact: «qa1+otra@dominio» is NOT qa1@dominio unless it is itself listed).
 */
export function qaRecipientAllowed(email) {
  const m = mailboxAddress(email);
  if (!m || isCommercial(email)) return false;
  return isQaMailbox(email) || QA_INBOX_MAILBOXES.has(m);
}
/**
 * 02-11e: the routing decision for a report, shared by the route (before any limit is counted) and the
 * sender (before Resend is called). A report is a QA operation when the requester OR the recipient is
 * a QA account. A QA operation needs QA routing "ok" (else 503) AND a QA recipient (else 403): it used
 * to go to any recipientEmail with the QA inbox in BCC.
 * → { test, ok, status?, error? }
 */
export function reportRouting(recipientEmail, requesterEmail) {
  const test = isTestRecord(recipientEmail, requesterEmail);
  if (!test) return { test, ok: true };
  if (qaRouting() !== "ok") return { test, ok: false, status: 503, error: "qa_routing_unavailable" };
  if (!qaRecipientAllowed(recipientEmail)) return { test, ok: false, status: 403, error: "qa_recipient_not_allowed" };
  return { test, ok: true };
}
export class QaRecipientError extends Error {
  constructor() {
    super("QA_RECIPIENT_NOT_ALLOWED");
    this.code = "qa_recipient_not_allowed";
  }
}
/** "ve***@seal.com.gt": shows where it went without exposing addresses. */
export const maskEmail = (x) => String(x).replace(/^(.{1,2})[^@]*@/, "$1***@");
/** No addresses in logs or stored error notes. */
export const scrubEmails = (text) => String(text || "").replace(/[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[a-z]{2,}/gi, "[correo]");
export const recipientConfig = () => ({ commercial: COMMERCIAL.length, devCopies: DEV_COPIES.length, qaInbox: QA_INBOX.length, devGetsReal: DEV_GETS_REAL, qaRouting: qaRouting() });

const FROM_EMAIL =
  process.env.RESEND_FROM ||
  "SEAL SmartTrade AI <onboarding@resend.dev>";

/* ─────────────────────────────────────────────
   Email Branding Wrapper
───────────────────────────────────────────── */
function emailWrapper(title, content) {
  return `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8fafc;">
    <div style="background: linear-gradient(135deg, #0B3C5D 0%, #1e40af 100%); padding: 30px; text-align: center;">
      <h1 style="color: white; margin: 0;">SEAL SmartTrade AI</h1>
      <p style="color: #bfdbfe; margin-top: 8px;">${title}</p>
    </div>
    <div style="background: white; padding: 30px;">
      ${content}
    </div>
    <div style="background: #0B3C5D; padding: 20px; text-align: center; color: #bfdbfe; font-size: 12px;">
      SEAL SmartTrade AI © ${new Date().getFullYear()}
    </div>
  </div>`;
}

/* ─────────────────────────────────────────────
   1️⃣ Send Lead Notification
───────────────────────────────────────────── */
export async function sendLeadNotification({ name, email, query }) {
  const resend = getResendClient();

  const content = `
    <h2>Consulta iniciada en SmartTrade AI</h2>
    <p style="color:#64748b;font-size:13px">Aviso de registro: la persona escribió su consulta en la página de inicio. Aún no es una solicitud a SEAL ni una cotización; si la envía, llega aparte con número de caso.</p>
    <p><b>Nombre:</b> ${e(name)}</p>
    <p><b>Correo:</b> ${e(email)}</p>
    <p><b>Consulta:</b> ${e(query)}</p>
  `;
  const test = isTestRecord(email);
  const to = recipientsFor(test); // a test without QA routing throws: nothing is sent
  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    replyTo: email,
    subject: `${qaTag(test)}Consulta iniciada (aún sin solicitud): ${name.replace(/[\r\n]/g, " ")}`,
    html: emailWrapper("Consulta iniciada", content),
  });

  if (error) throw new Error(error.message);
  return data;
}

/* ─────────────────────────────────────────────
   1️⃣b Search Lead — every successful supplier search
───────────────────────────────────────────── */
// 02-11: the page sends a category KEY ("machinery", "other"…); the team reads it in Spanish
const CATEGORY_ES = {
  machinery: "Maquinaria / equipo", electronics: "Electrónica", textiles: "Textiles / calzado", furniture: "Muebles",
  food: "Alimentos / bebidas", stationery: "Papelería / útiles escolares", ppe: "Equipo de protección", other: "Otro (sin categoría)",
};
export const categoryEs = (key) => CATEGORY_ES[String(key || "").trim().toLowerCase()] || String(key || "");

export async function sendSearchLead({
  email, userQuery, productType, material, quantity, budget,
  destination, searchKeyword, qualifiedCount, topSupplier,
}) {
  const resend = getResendClient();
  const row = (label, value) =>
    value || value === 0
      ? `<tr><td style="padding:6px 12px;color:#64748b;">${label}</td><td style="padding:6px 12px;"><b>${e(value)}</b></td></tr>`
      : "";

  const content = `
    <h2>🔎 Búsqueda realizada en SmartTrade AI</h2>
    <table style="border-collapse:collapse;width:100%;">
      ${row("Correo", email || "sin correo")}
      ${row("Lo que busca", userQuery)}
      ${row("Categoría inferida", categoryEs(productType))}
      ${row("Material", material)}
      ${row("Cantidad", quantity)}
      ${row("Presupuesto (US$)", budget)}
      ${row("Destino", /^gt$/i.test(String(destination || "").trim()) ? "Guatemala" : destination)}
      ${row("Palabra clave usada", searchKeyword)}
      ${row("Coincidencias que pasaron los filtros", qualifiedCount)}
      ${row("Primera coincidencia de la lista", topSupplier)}
    </table>
    <p style="color:#64748b;font-size:13px;">Las coincidencias son referencias de búsqueda tomadas de lo que publica la plataforma: no confirman existencia, identidad, capacidad, calidad, oferta vigente ni idoneidad del proveedor, y el orden en pantalla del cliente puede ser distinto. Aún no es una solicitud a SEAL.</p>
    <p style="color:#64748b;font-size:13px;">Responda a este correo para escribirle directo al prospecto.</p>
  `;

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: recipientsFor(isTestRecord(email)),
    ...(email ? { replyTo: email } : {}),
    subject: `${qaTag(isTestRecord(email))}Búsqueda: ${String(userQuery || productType || "producto").replace(/[\r\n]/g, " ").slice(0, 80)}${email ? " — " + email : ""}`,
    html: emailWrapper("Búsqueda realizada (aún sin solicitud a SEAL)", content),
  });

  if (error) throw new Error(error.message);
  return data;
}

/* ─────────────────────────────────────────────
   2️⃣ Send Quote Request
───────────────────────────────────────────── */
export async function sendQuoteRequest(data) {
  const resend = getResendClient();

  const content = `
    <h2>💰 New Quote Request</h2>
    <pre>${e(JSON.stringify(data, null, 2))}</pre>
  `;

  const { data: result, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: recipientsFor(isTestRecord(data.email)),
    replyTo: data.email,
    subject: `${qaTag(isTestRecord(data.email))}${String(data.requestType || "Solicitud de cotización").replace(/[\r\n]/g, " ")} — ${String(data.name).replace(/[\r\n]/g, " ")}`,
    html: emailWrapper("Quote Request", content),
  });

  if (error) throw new Error(error.message);
  return result;
}

/* ─────────────────────────────────────────────
   2️⃣b A registered case (lead) for SEAL: everything the client saw, with its
   case number and the links a person uses to record the follow-up
───────────────────────────────────────────── */
const STATUS_LABEL = {
  contactado: "Marcar contactado",
  calificado: "Lead calificado",
  cotizado: "Cotización enviada",
  cliente: "Ya es cliente",
  descartado: "Descartar",
  derivar: "Derivar (requiere validación)",
  excluir: "Es una prueba: excluir de métricas",
};
function fmtDate(ms) {
  return new Date(ms).toLocaleString("es-GT", { timeZone: "America/Guatemala", dateStyle: "medium", timeStyle: "short" });
}
const FIELD_LABEL = {
  product: "producto", description: "descripción", quantity: "cantidad", supplierName: "proveedor", supplierUrl: "enlace del proveedor",
  price: "precio", priceSource: "origen del precio", publishedPrice: "precio publicado", totalCostText: "costo estimado", budget: "presupuesto",
  destination: "destino", message: "mensaje", caseRef: "informe", assumptions: "supuestos", warnings: "advertencias", chat: "conversación", earlier: "historial de producto",
  name: "nombre", phone: "teléfono", company: "empresa",
  contacto_distinto: "datos de contacto distintos (NO aplicados: confirme con el cliente antes de usarlos)",
};
export function caseEmailHtml(lead, links, update = null) {
  const c = lead.case || {};
  const p = lead.contact || {};
  const row = (label, value) =>
    value || value === 0
      ? `<tr><td style="padding:6px 10px;color:#64748b;vertical-align:top;white-space:nowrap">${label}</td><td style="padding:6px 10px"><b>${e(value)}</b></td></tr>`
      : "";
  const list = (title, items, color) =>
    Array.isArray(items) && items.length
      ? `<h3 style="margin:18px 0 6px;color:${color}">${title}</h3><ul style="margin:0;padding-left:18px">${items.map((x) => `<li style="margin:3px 0">${e(x)}</li>`).join("")}</ul>`
      : "";
  const chat = Array.isArray(c.chat) && c.chat.length
    ? `<h3 style="margin:18px 0 6px;color:#0B3C5D">Lo que escribió en el chat</h3>${c.chat.map((x) => `<p style="margin:4px 0;padding:6px 10px;background:#f1f5f9;border-radius:6px">${e(x)}</p>`).join("")}`
    : "";
  const buttons = links
    ? `<h3 style="margin:22px 0 8px;color:#0B3C5D">Seguimiento (lo registra una persona)</h3>
       <p style="margin:0 0 8px;color:#64748b;font-size:13px">Cada botón abre una página para confirmar el cambio; nada cambia solo con abrir el correo.</p>
       ${Object.entries(STATUS_LABEL).map(([s, label]) => `<a href="${e(links.act(s))}" style="display:inline-block;margin:3px 4px 3px 0;padding:7px 12px;border-radius:6px;background:${s === "descartado" || s === "excluir" ? "#94a3b8" : s === "derivar" ? "#f59e0b" : "#0B3C5D"};color:#fff;text-decoration:none;font-size:13px">${label}</a>`).join("")}
       <p style="margin:14px 0 0;font-size:13px"><a href="${e(links.funnel)}">Ver el embudo (visitas → clientes)</a></p>`
    : "";
  return emailWrapper(
    `Caso ${lead.id}`,
    `
    ${update ? `<p style="margin:0 0 12px;padding:10px;background:#e0f2fe;border-radius:6px"><b>Actualización del mismo caso</b> (no es un caso nuevo): el cliente cambió ${e(update.map((k) => FIELD_LABEL[k] || k).join(", "))}. Abajo está el caso completo, ya actualizado.</p>` : ""}
    ${(() => {
      // 02-11j: a repeat with a different phone/company/name does not replace the contact: shown apart
      // (review: from the latest history entry, so it also shows when the email is re-sent after a failure)
      const p = lead.history?.[lead.history.length - 1]?.proposedContact;
      return p
        ? `<p style="margin:0 0 12px;padding:10px;background:#fef3c7;border-radius:6px"><b>Datos de contacto distintos recibidos en esta actualización (no se aplicaron):</b> ${e(Object.entries(p).map(([k, v]) => `${FIELD_LABEL[k] || k}: ${v}`).join(" · "))}. El contacto del caso sigue siendo el original; confirme con el cliente antes de usarlos.</p>`
        : "";
    })()}
    <h2 style="margin-top:0">📥 Solicitud recibida: ${e(requestLabel(lead.requestType))} — caso ${e(lead.id)}</h2>
    <p style="margin:0 0 8px;font-size:13px;color:#334155">${c.totalCostText ? "Incluye una <b>estimación preliminar</b> calculada por la herramienta; no es una cotización comercial de SEAL." : "Es una solicitud del cliente; no incluye cotización comercial."}</p>
    <p style="margin:0 0 12px;color:#64748b">Recibido ${e(fmtDate(lead.createdAt))} · desde: ${e(lead.source || "—")}${lead.intent ? ` · intención: ${e(lead.intent)}` : ""}${lead.lang === "en" ? " · cliente en inglés" : ""}</p>
    <table style="border-collapse:collapse;width:100%">
      ${row("Nombre", p.name)}${row("Correo", p.email)}${row("Teléfono", p.phone)}${row("Empresa", p.company)}
    </table>
    <h3 style="margin:18px 0 6px;color:#0B3C5D">El caso</h3>
    <table style="border-collapse:collapse;width:100%">
      ${row("Producto", c.product)}${row("Descripción", c.description && c.description !== c.product ? c.description : "")}
      ${row("Cantidad", c.quantity)}${row("Proveedor", c.supplierName)}${row("Enlace del proveedor", c.supplierUrl)}
      ${c.priceSource === "usuario" ? `${row("Precio indicado por el usuario", c.price)}${row("Precio publicado", c.publishedPrice)}` : (c.publishedPrice && c.publishedPrice !== c.price ? `${row("Precio usado en la estimación", c.price)}${row("Precio publicado", c.publishedPrice)}` : row("Precio publicado", c.price))}${row(/sin flete/i.test(String(c.totalCostText || "")) ? "Costo estimado preliminar (sin flete)" : "Costo estimado preliminar", c.totalCostText)}${row("Presupuesto", c.budget)}
      ${row("Destino", /^gt$/i.test(String(c.destination || "").trim()) ? "Guatemala" : c.destination)}${row("Informe del cliente", c.caseRef)}
    </table>
    ${c.message ? `<h3 style="margin:18px 0 6px;color:#0B3C5D">Mensaje del cliente</h3><p style="margin:0;white-space:pre-line">${e(c.message)}</p>` : ""}
    ${list("Supuestos usados en la estimación", c.assumptions, "#0369a1")}
    ${list("Advertencias que vio el cliente", c.warnings, "#b45309")}
    ${list("Historial del caso: datos de un producto anterior (ya no vigentes, no cotizar con ellos)", c.earlier, "#64748b")}
    ${chat}
    <p style="margin:18px 0 0;padding:10px;background:#fef3c7;border-radius:6px;font-size:13px">SEAL atiende primero este caso. Si conviene derivarlo a otra empresa del grupo (ImportaGuate, Courier.com.gt, DLZ o DLZ Foods), una persona lo valida: no es automático. Los datos del proveedor y la estimación vienen de lo publicado en la plataforma y no están verificados.</p>
    ${buttons}
  `,
  );
}

/**
 * The subject says what the email is: a request received (always: the tool never
 * confirms a commercial quote), whether it carries a preliminary estimate, and
 * whether it is an update of the same case. "Cotización confirmada" only exists
 * once SEAL sends its own quote, never from the tool.
 */
export function requestLabel(requestType) {
  return String(requestType || "Solicitud").replace(/[\r\n]/g, " ").replace(/cotizaci[oó]n\s+confirmada/gi, "Solicitud de cotización formal").slice(0, 80);
}
export function caseSubject(lead, update = null) {
  const c = lead.case || {};
  // the subject carries the product cut at a whole word ("…para bebidas…", never "para be")
  const full = String(c.product || c.description || "").replace(/[\r\n]/g, " ").trim();
  const product = full.length <= 60 ? full : `${full.slice(0, 61).replace(/\s+\S*$/, "").replace(/[,;:.\s]+$/, "")}…`;
  const estimate = c.totalCostText ? " · incluye estimación preliminar (no es cotización)" : "";
  return `${lead.test ? "[PRUEBA] " : ""}${update ? "Actualización · " : ""}Caso ${lead.id} · Solicitud recibida: ${requestLabel(lead.requestType)} — ${String(lead.contact.name).replace(/[\r\n]/g, " ")}${product ? ` (${product})` : ""}${estimate}`;
}

export async function sendCaseToSeal(lead, links, update = null) {
  const resend = getResendClient();
  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: recipientsFor(!!lead.test),
    replyTo: lead.contact.email,
    subject: caseSubject(lead, update),
    html: caseEmailHtml(lead, links, update),
  });
  if (error) throw new Error(scrubEmails(error.message));
  // where it went, masked (shown on the case page as evidence, without addresses)
  return { ...data, to: recipientsFor(!!lead.test).map(maskEmail) };
}

/**
 * What the email service knows about a sent email: "delivered" means SEAL's mail
 * server accepted it (not that someone read it). "" when it can't be checked
 * (e.g. a send-only API key).
 */
export async function emailDelivery(id) {
  if (!id) return "";
  try {
    const { data, error } = await getResendClient().emails.get(id);
    if (error || !data) return "";
    return String(data.last_event || "");
  } catch {
    return "";
  }
}

/** Cases nobody has marked as contacted yet. */
export async function sendFollowUpReminder(list, linksFor) {
  const resend = getResendClient();
  const rows = list
    .map((l) => `<li style="margin:6px 0"><b>${e(l.id)}</b> — ${e(l.contact.name)} (${e(l.contact.email)}) · ${e(l.case.product || l.case.description || "")} · recibido ${e(fmtDate(l.createdAt))} · <a href="${e(linksFor(l).act("contactado"))}">marcar contactado</a></li>`)
    .join("");
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: recipientsFor(false), // reminders list real cases only (tests are skipped)
    subject: `Seguimiento pendiente: ${list.length} caso${list.length === 1 ? "" : "s"} sin contacto registrado`,
    html: emailWrapper("Casos sin seguimiento", `<p>Estos casos llevan más de un día sin que nadie registre el contacto:</p><ul style="padding-left:18px">${rows}</ul>`),
  });
  if (error) throw new Error(error.message);
}

/* ─────────────────────────────────────────────
   3️⃣ Send Report To User
───────────────────────────────────────────── */
export async function sendReportToUser({
  recipientEmail,
  recipientName,
  pdfBuffer,
  supplierName,
  totalCost,
  totalCostText,
  requesterEmail,
  lang = "es",
  partial = false,
}) {
  const resend = getResendClient();
  const en = lang === "en";
  const attachments = pdfBuffer
    // 02-11k: the PDF is made in the client's browser: its name says it is a preliminary estimate, not a SEAL document
    ? [{ filename: `SmartTrade_${en ? "preliminary_estimate" : "estimacion_preliminar"}_${Date.now()}.pdf`, content: pdfBuffer }]
    : [];
  void recipientName; // 02-11k: reports go only to the requester's own verified mailbox: no third-party greeting
  // 02-11e: the same decision as the route, again here, before Resend is called: a QA report goes
  // only to a QA recipient, with QA copies; without QA routing or to any other address nothing is sent
  const routing = reportRouting(recipientEmail, requesterEmail);
  if (!routing.ok) throw routing.status === 503 ? new QaRoutingError() : new QaRecipientError();
  const reportTest = routing.test;
  const copies = recipientsFor(reportTest); // a test without QA routing throws before anything is sent
  const total = e(totalCostText || "US$" + Number(totalCost || 0).toLocaleString("en-US"));

  // the client's language, as in the PDF they chose
  const content = en
    ? `
    <h2>📄 Your preliminary estimate</h2>
    <p>Hello,</p>
    <p>You asked SmartTrade AI to email you the estimate you prepared. <b>The attached PDF was generated in your browser with the data you entered; SEAL did not review or validate it.</b> It is preliminary guidance: it is not a quote, a supplier verification or a confirmed tariff classification.</p>
    ${supplierName ? `<p>Supplier (as entered in the tool): ${e(supplierName)}</p>` : ""}
    <p>${partial ? "Preliminary estimated cost, without freight (tool's figure)" : "Preliminary estimated cost (tool's figure)"}: ${total}</p>
    <p style="color:#64748b;font-size:12px">If you want SEAL to review your case, reply to SEAL on WhatsApp +502 5996 4664.</p>
  `
    : `
    <h2>📄 Su estimación preliminar</h2>
    <p>Hola:</p>
    <p>Usted pidió a SmartTrade AI enviarle por correo la estimación que preparó. <b>El PDF adjunto se generó en su navegador con los datos que usted ingresó; SEAL no lo revisó ni lo valida.</b> Es una orientación preliminar: no es una cotización, ni una verificación del proveedor, ni una clasificación arancelaria confirmada.</p>
    ${supplierName ? `<p>Proveedor (según los datos ingresados en la herramienta): ${e(supplierName)}</p>` : ""}
    <p>${partial ? "Costo estimado preliminar, sin flete (cifra de la herramienta)" : "Costo estimado preliminar (cifra de la herramienta)"}: ${total}</p>
    <p style="color:#64748b;font-size:12px">Si desea que SEAL revise su caso, escriba al WhatsApp de SEAL +502 5996 4664.</p>
  `;

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: recipientEmail,
    // 02-11e: the recipient is not copied to itself (a report to the QA inbox arrived there twice)
    ...(() => {
      // (by exact mailbox: an alias of a copy is not assumed to reach it, so the copy still goes)
      const bcc = copies.filter((x) => mailboxAddress(x) !== mailboxAddress(recipientEmail));
      return bcc.length ? { bcc } : {};
    })(),
    // 02-11k: no free text in the subject
    subject: en ? "Your preliminary estimate (SmartTrade AI)" : "Su estimación preliminar (SmartTrade AI)",
    html: emailWrapper(en ? "Preliminary estimate" : "Estimación preliminar", content),
    attachments,
  });

  if (!error) return { delivered: true, data };

  // Resend can refuse external recipients (e.g. sender domain not verified).
  // Don't lose the lead: send the report to SEAL sales so they forward it. 02-11e: a QA report is
  // forwarded only to the QA copies (recipientsFor(true): QA inbox + dev copies, never sales).
  console.error(`⚠️ Report to ${reportTest ? "QA recipient" : "client"} failed, forwarding to ${reportTest ? "the QA inbox" : "SEAL"}:`, scrubEmails(error.message));
  const fwd = await resend.emails.send({
    from: FROM_EMAIL,
    to: copies,
    replyTo: recipientEmail,
    subject: `${qaTag(reportTest)}REENVIAR informe a cliente: ${recipientEmail}`,
    html: emailWrapper(
      "Informe pendiente de reenviar",
      `<p><b>No se pudo enviar el informe directo al cliente.</b> Reenvíelo a <b>${e(recipientEmail)}</b>.</p>
       <p>Motivo técnico: ${e(scrubEmails(error.message))}</p>${content}`,
    ),
    attachments,
  });
  if (fwd.error) throw new Error(fwd.error.message);
  return { delivered: false, forwarded: true };
}

/* ─────────────────────────────────────────────
   02-11k: verification code (proof of control of an address)
   Sent only to the address itself; no case data, no links, no free text.
───────────────────────────────────────────── */
export async function sendVerificationCode(email, code, lang = "es") {
  const resend = getResendClient();
  const en = lang === "en";
  // 02-11n: 10 characters, shown in two groups of 5 (ABCDE-FGHJK) to be easier to copy
  const raw = String(code).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 10);
  const c = raw.length === 10 ? `${raw.slice(0, 5)}-${raw.slice(5)}` : raw;
  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: [email],
    subject: en ? "Your SmartTrade AI verification code" : "Su código de verificación de SmartTrade AI",
    html: emailWrapper(
      en ? "Verification code" : "Código de verificación",
      en
        ? `<p>Your code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:monospace">${c}</p><p style="color:#64748b;font-size:12px">It expires in 15 minutes. If you did not ask for it, ignore this message: nothing will be sent without the code.</p>`
        : `<p>Su código es:</p><p style="font-size:28px;font-weight:bold;letter-spacing:6px;font-family:monospace">${c}</p><p style="color:#64748b;font-size:12px">Vence en 15 minutos. Si usted no lo pidió, ignore este mensaje: sin el código no se envía nada.</p>`,
    ),
  });
  if (error) throw new Error(error.message);
  return data;
}

/* ✅ Optional default export (not required but safe) */
export default {
  sendLeadNotification,
  sendSearchLead,
  sendQuoteRequest,
  sendCaseToSeal,
  sendFollowUpReminder,
  sendReportToUser,
  sendVerificationCode,
};