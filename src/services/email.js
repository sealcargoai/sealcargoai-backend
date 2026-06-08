import { Resend } from "resend";

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

const adminEmails = [
  process.env.ADMIN_EMAIL,
  process.env.ADMIN2_EMAIL,
].filter(Boolean);

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
    <p><b>Name:</b> ${name}</p>
    <p><b>Email:</b> ${email}</p>
    <p><b>Query:</b> ${query}</p>
  `;

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: adminEmails,
    replyTo: email,
    subject: `New Lead from ${name}`,
    html: emailWrapper("New Lead Notification", content),
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
    <pre>${JSON.stringify(data, null, 2)}</pre>
  `;

  const { data: result, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: adminEmails,
    replyTo: data.email,
    subject: `Quote Request from ${data.name}`,
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

  const content = `
    <h2>📄 Your Import Report</h2>
    <p>Hello ${recipientName || ""}</p>
    <p>Supplier: ${supplierName}</p>
    <p>Total Cost: $${totalCost}</p>
  `;

  const { data, error } = await resend.emails.send({
    from: FROM_EMAIL,
    to: recipientEmail,
    bcc: adminEmails,
    subject: `Your SEAL Report - ${supplierName}`,
    html: emailWrapper("Import Analysis Report", content),
    attachments: pdfBuffer
      ? [
          {
            filename: `SEAL_Report_${Date.now()}.pdf`,
            content: pdfBuffer,
          },
        ]
      : [],
  });

  if (error) throw new Error(error.message);
  return data;
}

/* ✅ Optional default export (not required but safe) */
export default {
  sendLeadNotification,
  sendQuoteRequest,
  sendReportToUser,
};