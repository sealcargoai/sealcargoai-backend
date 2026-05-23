import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

// ── Verify on startup ──
if (!process.env.RESEND_API_KEY) {
  console.error("❌ RESEND_API_KEY not set");
} else {
  console.log("✅ Resend email service ready");
}

// ── Use Resend's test domain OR your own verified domain ──
const FROM_EMAIL = process.env.RESEND_FROM || "SEAL SmartTrade AI <onboarding@resend.dev>";

// ── Email branding wrapper ──
function emailWrapper(title, content) {
  return `
  <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; background: #f8fafc;">
    <div style="background: linear-gradient(135deg, #0B3C5D 0%, #1e40af 100%); padding: 30px; text-align: center;">
      <h1 style="color: white; margin: 0; font-size: 24px;">SEAL SmartTrade AI</h1>
      <p style="color: #bfdbfe; margin: 8px 0 0; font-size: 14px;">${title}</p>
    </div>
    <div style="background: white; padding: 30px; border: 1px solid #e2e8f0;">
      ${content}
    </div>
    <div style="background: #0B3C5D; padding: 20px; text-align: center; color: #bfdbfe; font-size: 12px;">
      <p style="margin: 0;">SEAL SmartTrade AI © ${new Date().getFullYear()}</p>
      <p style="margin: 5px 0 0;">Connecting Guatemala to Global Trade</p>
    </div>
  </div>`;
}

// ── 1. New Lead Notification ──
export async function sendLeadNotification({ name, email, query }) {
  const content = `
    <h2 style="color: #0B3C5D;">🎯 New Lead Captured!</h2>
    <p>A new user just started an analysis on SEAL SmartTrade AI.</p>
    <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
      <tr><td style="padding: 12px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Name:</strong></td>
          <td style="padding: 12px; border: 1px solid #e2e8f0;">${name}</td></tr>
      <tr><td style="padding: 12px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Email:</strong></td>
          <td style="padding: 12px; border: 1px solid #e2e8f0;"><a href="mailto:${email}">${email}</a></td></tr>
      <tr><td style="padding: 12px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Query:</strong></td>
          <td style="padding: 12px; border: 1px solid #e2e8f0;">${query}</td></tr>
      <tr><td style="padding: 12px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Time:</strong></td>
          <td style="padding: 12px; border: 1px solid #e2e8f0;">${new Date().toLocaleString()}</td></tr>
    </table>
    <p style="color: #64748b; font-size: 14px;">Follow up within 24 hours for best conversion.</p>
  `;

const { data, error } = await resend.emails.send({
    from:    FROM_EMAIL,
    to:      [process.env.ADMIN_EMAIL],
    bcc:     [process.env.ADMIN2_EMAIL],
    replyTo: email,
    subject: `🎯 New Lead: ${name} - ${query.slice(0, 50)}`,
    html:    emailWrapper("New Lead Notification", content),
});

  if (error) throw new Error(error.message);
  return data;
}

// ── 2. Quote Request ──
export async function sendQuoteRequest({
  name, email, phone, company, message,
  supplierName, totalCost, productType, quantity, destination,
}) {
  const content = `
    <h2 style="color: #0B3C5D;">💰 New Quote Request</h2>
    <h3 style="color: #475569; margin-top: 25px;">Customer Details</h3>
    <table style="width: 100%; border-collapse: collapse; margin: 10px 0;">
      <tr><td style="padding: 10px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Name:</strong></td>
          <td style="padding: 10px; border: 1px solid #e2e8f0;">${name}</td></tr>
      <tr><td style="padding: 10px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Email:</strong></td>
          <td style="padding: 10px; border: 1px solid #e2e8f0;"><a href="mailto:${email}">${email}</a></td></tr>
      <tr><td style="padding: 10px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Phone:</strong></td>
          <td style="padding: 10px; border: 1px solid #e2e8f0;">${phone || "Not provided"}</td></tr>
      <tr><td style="padding: 10px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Company:</strong></td>
          <td style="padding: 10px; border: 1px solid #e2e8f0;">${company || "Not provided"}</td></tr>
    </table>

    <h3 style="color: #475569; margin-top: 25px;">Import Details</h3>
    <table style="width: 100%; border-collapse: collapse; margin: 10px 0;">
      <tr><td style="padding: 10px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Supplier:</strong></td>
          <td style="padding: 10px; border: 1px solid #e2e8f0;">${supplierName || "N/A"}</td></tr>
      <tr><td style="padding: 10px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Product:</strong></td>
          <td style="padding: 10px; border: 1px solid #e2e8f0;">${productType || "N/A"}</td></tr>
      <tr><td style="padding: 10px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Quantity:</strong></td>
          <td style="padding: 10px; border: 1px solid #e2e8f0;">${quantity || "N/A"}</td></tr>
      <tr><td style="padding: 10px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Destination:</strong></td>
          <td style="padding: 10px; border: 1px solid #e2e8f0;">${destination || "N/A"}</td></tr>
      <tr><td style="padding: 10px; background: #f1f5f9; border: 1px solid #e2e8f0;"><strong>Estimated Cost:</strong></td>
          <td style="padding: 10px; border: 1px solid #e2e8f0;">$${totalCost?.toLocaleString() || "N/A"}</td></tr>
    </table>

    ${message ? `
    <h3 style="color: #475569; margin-top: 25px;">Message from Customer</h3>
    <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 10px 0;">
      ${message}
    </div>` : ""}
  `;

  const { data, error } = await resend.emails.send({
    from:    FROM_EMAIL,
    to:      [process.env.ADMIN_EMAIL],
    replyTo: email,
    subject: `💰 Quote Request from ${name} - ${supplierName || "General"}`,
    html:    emailWrapper("Quote Request", content),
  });

  if (error) throw new Error(error.message);
  return data;
}

// ── 3. Email Report to User (with PDF attachment) ──
export async function sendReportToUser({
  recipientEmail, recipientName, pdfBase64, supplierName, totalCost,
}) {
  const content = `
    <h2 style="color: #0B3C5D;">📄 Your SEAL Import Analysis Report</h2>
    <p>Hello ${recipientName || "there"},</p>
    <p>Thank you for using SEAL SmartTrade AI. Please find attached your detailed import analysis report.</p>

    <div style="background: #eff6ff; border-left: 4px solid #3b82f6; padding: 15px; margin: 20px 0;">
      <p style="margin: 0;"><strong>Supplier:</strong> ${supplierName || "N/A"}</p>
      <p style="margin: 5px 0 0;"><strong>Total Estimated Cost:</strong> $${totalCost?.toLocaleString() || "N/A"}</p>
    </div>

    <p>Our team is available to help you with the next steps. If you have any questions, simply reply to this email.</p>
    <p style="color: #64748b; margin-top: 30px;">Best regards,<br><strong>SEAL SmartTrade AI Team</strong></p>
  `;

  const { data, error } = await resend.emails.send({
    from:    FROM_EMAIL,
    to:      [recipientEmail],
    bcc:     [process.env.ADMIN_EMAIL],
    subject: `📄 Your SEAL Import Analysis Report - ${supplierName || "Analysis"}`,
    html:    emailWrapper("Your Import Analysis Report", content),
    attachments: pdfBase64 ? [{
      filename: `SEAL_Report_${Date.now()}.pdf`,
      content:  pdfBase64,  // base64 string
    }] : [],
  });

  if (error) throw new Error(error.message);
  return data;
}

export default { sendLeadNotification, sendQuoteRequest, sendReportToUser };
