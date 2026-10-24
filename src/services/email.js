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
    subject: `New Lead from ${name.replace(/[\r\n]/g, " ")}`,
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
    subject: `Búsqueda: ${String(userQuery || productType || "producto").replace(/[\r\n]/g, " ").slice(0, 80)}${email ? " — " + email : ""}`,
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
    subject: `${data.requestType || "Solicitud de cotización"} — ${String(data.name).replace(/[\r\n]/g, " ")}`,
    html: emailWrapper("Quote Request", content),
  });

  if (error) throw new Error(error.message);
  return result;
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
}) {
  const resend = getResendClient();
  const attachments = pdfBuffer
    ? [{ filename: `SEAL_Informe_${Date.now()}.pdf`, content: pdfBuffer }]
    : [];

  const content = `
    <h2>📄 Su informe de importación</h2>
    <p>Hola ${e(recipientName || "")}</p>
    <p>Proveedor: ${e(supplierName)}</p>
    <p>Costo total estimado: $${e(Number(totalCost || 0).toLocaleString("en-US"))}</p>
  `;

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: recipientEmail,
    bcc: adminEmails,
    subject: `Su informe SEAL - ${String(supplierName).replace(/[\r\n]/g, " ")}`,
    html: emailWrapper("Informe de análisis de importación", content),
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
    subject: `REENVIAR informe a cliente: ${recipientEmail}`,
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
  sendReportToUser,
};