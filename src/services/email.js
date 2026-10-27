import { Resend } from "resend";
import { escapeHtml as e } from "../middleware/security.js";

/* ─────────────────────────────────────────────
   Safe Resend Client Creator
───────────────────────────────────────────── */
function getResendClient() {
  const apiKey = process.env.RESEND_API_KEY;

  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not defined in environment");
  }

  return new Resend(apiKey);
}

// Leads always go to SEAL sales; ADMIN_EMAIL / ADMIN2_EMAIL get a copy if set
const LEADS_EMAIL = process.env.LEADS_EMAIL || "ventas@seal.com.gt";

// Test records (fictitious name/email) are flagged so sales doesn't follow them up
const TEST_RE = /\b(prueba|test|testing|ficticio|ficticia|demo|fake|ejemplo)\b|@(example|test|prueba|mailinator)\./i;
export function testTag(...values) {
  return values.some((v) => TEST_RE.test(String(v || ""))) ? "[PRUEBA] " : "";
}
const adminEmails = [...new Set(
  [LEADS_EMAIL, process.env.ADMIN_EMAIL, process.env.ADMIN2_EMAIL]
    .filter(Boolean)
    .map((x) => x.trim().toLowerCase()),
)];

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
    <h2>🎯 New Lead</h2>
    <p><b>Name:</b> ${e(name)}</p>
    <p><b>Email:</b> ${e(email)}</p>
    <p><b>Query:</b> ${e(query)}</p>
  `;

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: adminEmails,
    replyTo: email,
    subject: `${testTag(name, email)}Nuevo prospecto: ${name.replace(/[\r\n]/g, " ")}`,
    html: emailWrapper("New Lead Notification", content),
  });

  if (error) throw new Error(error.message);
  return data;
}

/* ─────────────────────────────────────────────
   1️⃣b Search Lead — every successful supplier search
───────────────────────────────────────────── */
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
    <h2>🔎 Nueva búsqueda en SmartTrade AI</h2>
    <table style="border-collapse:collapse;width:100%;">
      ${row("Correo", email || "sin correo")}
      ${row("Lo que busca", userQuery)}
      ${row("Tipo de producto", productType)}
      ${row("Material", material)}
      ${row("Cantidad", quantity)}
      ${row("Presupuesto (US$)", budget)}
      ${row("Destino", destination)}
      ${row("Palabra clave usada", searchKeyword)}
      ${row("Proveedores calificados", qualifiedCount)}
      ${row("Mejor proveedor", topSupplier)}
    </table>
    <p style="color:#64748b;font-size:13px;">Responda a este correo para escribirle directo al prospecto.</p>
  `;

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: adminEmails,
    ...(email ? { replyTo: email } : {}),
    subject: `${testTag(email, userQuery)}Búsqueda: ${String(userQuery || productType || "producto").replace(/[\r\n]/g, " ").slice(0, 80)}${email ? " — " + email : ""}`,
    html: emailWrapper("Nuevo prospecto calificado", content),
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
    to: adminEmails,
    replyTo: data.email,
    subject: `${testTag(data.name, data.email)}${String(data.requestType || "Solicitud de cotización").replace(/[\r\n]/g, " ")} — ${String(data.name).replace(/[\r\n]/g, " ")}`,
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
};
function fmtDate(ms) {
  return new Date(ms).toLocaleString("es-GT", { timeZone: "America/Guatemala", dateStyle: "medium", timeStyle: "short" });
}
const FIELD_LABEL = {
  product: "producto", description: "descripción", quantity: "cantidad", supplierName: "proveedor", supplierUrl: "enlace del proveedor",
  price: "precio", priceSource: "origen del precio", publishedPrice: "precio publicado", totalCostText: "costo estimado", budget: "presupuesto",
  destination: "destino", message: "mensaje", caseRef: "informe", assumptions: "supuestos", warnings: "advertencias", chat: "conversación",
  name: "nombre", phone: "teléfono", company: "empresa",
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
       ${Object.entries(STATUS_LABEL).map(([s, label]) => `<a href="${e(links.act(s))}" style="display:inline-block;margin:3px 4px 3px 0;padding:7px 12px;border-radius:6px;background:${s === "descartado" ? "#94a3b8" : s === "derivar" ? "#f59e0b" : "#0B3C5D"};color:#fff;text-decoration:none;font-size:13px">${label}</a>`).join("")}
       <p style="margin:14px 0 0;font-size:13px"><a href="${e(links.funnel)}">Ver el embudo (visitas → clientes)</a></p>`
    : "";
  return emailWrapper(
    `Caso ${lead.id}`,
    `
    ${update ? `<p style="margin:0 0 12px;padding:10px;background:#e0f2fe;border-radius:6px"><b>Actualización del mismo caso</b> (no es un caso nuevo): el cliente cambió ${e(update.map((k) => FIELD_LABEL[k] || k).join(", "))}. Abajo está el caso completo, ya actualizado.</p>` : ""}
    <h2 style="margin-top:0">📥 ${e(lead.requestType || "Solicitud")} — caso ${e(lead.id)}</h2>
    <p style="margin:0 0 12px;color:#64748b">Recibido ${e(fmtDate(lead.createdAt))} · desde: ${e(lead.source || "—")}${lead.intent ? ` · intención: ${e(lead.intent)}` : ""}${lead.lang === "en" ? " · cliente en inglés" : ""}</p>
    <table style="border-collapse:collapse;width:100%">
      ${row("Nombre", p.name)}${row("Correo", p.email)}${row("Teléfono", p.phone)}${row("Empresa", p.company)}
    </table>
    <h3 style="margin:18px 0 6px;color:#0B3C5D">El caso</h3>
    <table style="border-collapse:collapse;width:100%">
      ${row("Producto", c.product)}${row("Descripción", c.description && c.description !== c.product ? c.description : "")}
      ${row("Cantidad", c.quantity)}${row("Proveedor", c.supplierName)}${row("Enlace del proveedor", c.supplierUrl)}
      ${c.priceSource === "usuario" ? `${row("Precio indicado por el usuario", c.price)}${row("Precio publicado", c.publishedPrice)}` : row("Precio publicado", c.price)}${row("Costo total estimado", c.totalCostText)}${row("Presupuesto", c.budget)}
      ${row("Destino", c.destination)}${row("Informe del cliente", c.caseRef)}
    </table>
    ${c.message ? `<h3 style="margin:18px 0 6px;color:#0B3C5D">Mensaje del cliente</h3><p style="margin:0;white-space:pre-line">${e(c.message)}</p>` : ""}
    ${list("Supuestos usados en la estimación", c.assumptions, "#0369a1")}
    ${list("Advertencias que vio el cliente", c.warnings, "#b45309")}
    ${chat}
    <p style="margin:18px 0 0;padding:10px;background:#fef3c7;border-radius:6px;font-size:13px">SEAL atiende primero este caso. Si conviene derivarlo a otra empresa del grupo (ImportaGuate, Courier.com.gt, DLZ o DLZ Foods), una persona lo valida: no es automático. Los datos del proveedor y la estimación vienen de lo publicado en la plataforma y no están verificados.</p>
    ${buttons}
  `,
  );
}

export async function sendCaseToSeal(lead, links, update = null) {
  const resend = getResendClient();
  const c = lead.case || {};
  const product = String(c.product || c.description || "").replace(/[\r\n]/g, " ").slice(0, 60);
  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: adminEmails,
    replyTo: lead.contact.email,
    subject: `${lead.test ? "[PRUEBA] " : ""}${update ? "Actualización · " : ""}Caso ${lead.id}: ${String(lead.requestType || "Solicitud").replace(/[\r\n]/g, " ")} — ${String(lead.contact.name).replace(/[\r\n]/g, " ")}${product ? ` (${product})` : ""}`,
    html: caseEmailHtml(lead, links, update),
  });
  if (error) throw new Error(error.message);
  return data;
}

/** Cases nobody has marked as contacted yet. */
export async function sendFollowUpReminder(list, linksFor) {
  const resend = getResendClient();
  const rows = list
    .map((l) => `<li style="margin:6px 0"><b>${e(l.id)}</b> — ${e(l.contact.name)} (${e(l.contact.email)}) · ${e(l.case.product || l.case.description || "")} · recibido ${e(fmtDate(l.createdAt))} · <a href="${e(linksFor(l).act("contactado"))}">marcar contactado</a></li>`)
    .join("");
  const { error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: adminEmails,
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
}) {
  const resend = getResendClient();
  const en = lang === "en";
  const attachments = pdfBuffer
    ? [{ filename: `SEAL_${en ? "Report" : "Informe"}_${Date.now()}.pdf`, content: pdfBuffer }]
    : [];
  const other = requesterEmail && requesterEmail.toLowerCase() !== String(recipientEmail).toLowerCase();
  const total = e(totalCostText || "US$" + Number(totalCost || 0).toLocaleString("en-US"));

  // the client's language, as in the PDF they chose
  const content = en
    ? `
    <h2>📄 Your import report</h2>
    <p>Hello ${e(recipientName || "")}</p>
    ${supplierName ? `<p>Supplier: ${e(supplierName)}</p>` : ""}
    <p>Estimated total cost: ${total}</p>
    ${other ? `<p>Sent at the request of: ${e(requesterEmail)}</p>` : ""}
    <p style="color:#64748b;font-size:12px">This is a preliminary estimate based on information published by the platform; it is not a quote nor a verification of the supplier.</p>
  `
    : `
    <h2>📄 Su informe de importación</h2>
    <p>Hola ${e(recipientName || "")}</p>
    ${supplierName ? `<p>Proveedor: ${e(supplierName)}</p>` : ""}
    <p>Costo total estimado: ${total}</p>
    ${other ? `<p>Enviado a solicitud de: ${e(requesterEmail)}</p>` : ""}
    <p style="color:#64748b;font-size:12px">Es una estimación preliminar con información publicada por la plataforma; no es una cotización ni una verificación del proveedor.</p>
  `;

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: recipientEmail,
    bcc: adminEmails,
    subject: `${en ? "Your SEAL report" : "Su informe SEAL"}${supplierName ? ` - ${String(supplierName).replace(/[\r\n]/g, " ")}` : ""}`,
    html: emailWrapper(en ? "Import analysis report" : "Informe de análisis de importación", content),
    attachments,
  });

  if (!error) return { delivered: true, data };

  // Resend can refuse external recipients (e.g. sender domain not verified).
  // Don't lose the lead: send the report to SEAL sales so they forward it.
  console.error("⚠️ Report to client failed, forwarding to SEAL:", error.message);
  const fwd = await resend.emails.send({
    from: FROM_EMAIL,
    to: adminEmails,
    replyTo: recipientEmail,
    subject: `${testTag(recipientName, recipientEmail)}REENVIAR informe a cliente: ${recipientEmail}`,
    html: emailWrapper(
      "Informe pendiente de reenviar",
      `<p><b>No se pudo enviar el informe directo al cliente.</b> Reenvíelo a <b>${e(recipientEmail)}</b>.</p>
       <p>Motivo técnico: ${e(error.message)}</p>${content}`,
    ),
    attachments,
  });
  if (fwd.error) throw new Error(fwd.error.message);
  return { delivered: false, forwarded: true };
}

/* ✅ Optional default export (not required but safe) */
export default {
  sendLeadNotification,
  sendSearchLead,
  sendQuoteRequest,
  sendCaseToSeal,
  sendFollowUpReminder,
  sendReportToUser,
};