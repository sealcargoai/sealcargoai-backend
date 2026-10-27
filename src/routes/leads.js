// Follow-up of the registered cases and the funnel.
// - /api/events: anonymous funnel events from the site (visits, queries, results…)
// - /api/leads/act/:id: the page a SEAL person opens from the case email to record
//   contact, qualification, quote, client, discard or a validated transfer.
//   Opening it changes nothing; the change needs the button (email scanners
//   that open links can't change a case).
// - /api/leads/funnel: visits → queries → results → requests → qualified → quotes → clients.
import express from "express";
import { escapeHtml as e, clean } from "../middleware/security.js";
import { sign, verifySigned } from "../services/quotaStore.js";
import { getLead, updateLead, leadFunnel, dueForReminder, markReminded, GROUP_COMPANIES } from "../services/leadStore.js";
import { recordEvent, eventTotals } from "../services/funnelStore.js";
import { sendFollowUpReminder } from "../services/email.js";

export function baseUrl(req) {
  return process.env.PUBLIC_API_URL || `${req.protocol}://${req.get("host")}`;
}
export const leadToken = (id) => sign(`lead:${id}`);
export const funnelToken = () => sign("funnel");
export function linksFor(lead, base) {
  const t = leadToken(lead.id);
  return {
    act: (s) => `${base}/api/leads/act/${encodeURIComponent(lead.id)}?s=${encodeURIComponent(s)}&t=${encodeURIComponent(t)}`,
    funnel: `${base}/api/leads/funnel?t=${encodeURIComponent(funnelToken())}`,
  };
}

const LABEL = {
  contactado: "Contactado",
  calificado: "Lead calificado",
  cotizado: "Cotización enviada",
  cliente: "Cliente",
  descartado: "Descartado",
  derivar: "Derivar a otra empresa del grupo",
};
const page = (title, body) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${e(title)}</title>
<style>body{font-family:system-ui,Arial,sans-serif;max-width:640px;margin:0 auto;padding:20px;color:#0f172a;background:#f8fafc}h1{color:#0B3C5D;font-size:22px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:10px;padding:16px;margin:12px 0}label{display:block;margin:10px 0 4px;font-size:14px}input,select,textarea{width:100%;box-sizing:border-box;padding:8px;border:1px solid #cbd5e1;border-radius:6px;font:inherit}button{margin-top:14px;padding:10px 16px;background:#0B3C5D;color:#fff;border:0;border-radius:6px;font:inherit;cursor:pointer}table{border-collapse:collapse;width:100%}td{padding:6px 8px;border-bottom:1px solid #e2e8f0}td.n{text-align:right;font-weight:700}.muted{color:#64748b;font-size:13px}.ok{color:#15803d}.err{color:#b91c1c}</style></head><body>${body}</body></html>`;

const router = express.Router();
router.use(express.urlencoded({ extended: false, limit: "20kb" }));

// ── anonymous funnel events ────────────────────────────────────────────────
router.post("/events", (req, res) => {
  const b = req.body || {};
  recordEvent(clean(b.event, 40), clean(b.vid, 64));
  res.status(204).end();
});

// ── case follow-up (a person confirms each change) ─────────────────────────
function caseSummary(l) {
  const hist = l.history
    .slice(-8)
    .map((h) => `<li>${e(new Date(h.at).toLocaleString("es-GT", { timeZone: "America/Guatemala" }))} — ${e(h.action)}${h.status ? `: ${e(h.status)}` : ""}${h.transferTo ? ` → ${e(h.transferTo)} (validó ${e(h.validatedBy)})` : ""}${h.by ? ` · ${e(h.by)}` : ""}${h.note ? ` · ${e(h.note)}` : ""}</li>`)
    .join("");
  return `<div class="card"><b>${e(l.id)}</b> · ${e(l.contact.name)} (${e(l.contact.email)})<br>${e(l.case.product || l.case.description || "")}${l.case.quantity ? ` · ${e(l.case.quantity)}` : ""}<br><span class="muted">Estado actual: <b>${e(l.status)}</b>${l.repeats ? ` · el cliente volvió a enviarlo ${l.repeats} vez/veces (agrupado, sin duplicar)` : ""}</span><ul class="muted">${hist}</ul></div>`;
}
router.get("/leads/act/:id", (req, res) => {
  const l = getLead(String(req.params.id));
  const s = clean(req.query.s, 20);
  const t = clean(req.query.t, 64);
  if (!l || !verifySigned(`lead:${l.id}`, t) || !(s in LABEL)) return res.status(404).send(page("No encontrado", "<h1>Enlace no válido</h1>"));
  const transfer = s === "derivar";
  res.send(
    page(
      `${l.id} — ${LABEL[s]}`,
      `<h1>${e(LABEL[s])}</h1>${caseSummary(l)}
      <form method="post" class="card">
        <input type="hidden" name="s" value="${e(s)}"><input type="hidden" name="t" value="${e(t)}">
        ${transfer ? `<label>Empresa del grupo</label><select name="transferTo" required><option value="">Elegir…</option>${GROUP_COMPANIES.map((c) => `<option>${e(c)}</option>`).join("")}</select>
        <label>Persona que valida la derivación (obligatorio)</label><input name="validatedBy" required maxlength="120">` : `<label>Quién registra (opcional)</label><input name="by" maxlength="120">`}
        <label>Nota (opcional)</label><textarea name="note" rows="3" maxlength="500"></textarea>
        <button type="submit">Confirmar: ${e(LABEL[s])}</button>
        ${transfer ? `<p class="muted">SEAL atiende primero el caso; la derivación no es automática y queda registrada con quién la validó.</p>` : ""}
      </form>`,
    ),
  );
});
router.post("/leads/act/:id", (req, res) => {
  const l = getLead(String(req.params.id));
  const b = req.body || {};
  const s = clean(b.s, 20);
  if (!l || !verifySigned(`lead:${l.id}`, clean(b.t, 64)) || !(s in LABEL)) return res.status(404).send(page("No encontrado", "<h1>Enlace no válido</h1>"));
  const r =
    s === "derivar"
      ? updateLead(l.id, { transferTo: clean(b.transferTo, 40), validatedBy: clean(b.validatedBy, 120), note: clean(b.note, 500) })
      : updateLead(l.id, { status: s, by: clean(b.by, 120), note: clean(b.note, 500) });
  if (r.error) {
    const msg = r.error === "validation_required" ? "Falta el nombre de la persona que valida la derivación." : r.error === "unknown_company" ? "Elige una empresa del grupo." : "No se pudo registrar.";
    return res.status(400).send(page("Error", `<h1 class="err">${e(msg)}</h1><p><a href="javascript:history.back()">Volver</a></p>`));
  }
  res.send(page("Registrado", `<h1 class="ok">Registrado: ${e(LABEL[s])}</h1>${caseSummary(r.lead)}`));
});

// ── funnel ───────────────────────────────────────────────────────────────────
router.get("/leads/funnel", (req, res) => {
  const admin = process.env.ADMIN_TOKEN && req.get("x-admin-token") === process.env.ADMIN_TOKEN;
  if (!admin && !verifySigned("funnel", clean(req.query.t, 64))) return res.status(404).send(page("No encontrado", "<h1>Enlace no válido</h1>"));
  const days = Math.min(400, Math.max(1, parseInt(req.query.days) || 30));
  const since = Date.now() - days * 86400000;
  const ev = eventTotals(new Date(since).toISOString().slice(0, 10));
  const lf = leadFunnel({ sinceMs: since });
  const stages = [
    ["Visitas", ev.visita],
    ["Consultas iniciadas", ev.consulta_iniciada],
    ["Resultados mostrados", ev.resultados],
    ["Solicitudes recibidas (registradas con número)", lf.solicitudes],
    ["Leads calificados", lf.calificados],
    ["Cotizaciones", lf.cotizaciones],
    ["Clientes", lf.clientes],
  ];
  if (req.query.format === "json") return res.json({ days, stages: Object.fromEntries(stages), events: ev, leads: lf });
  const rows = stages.map(([k, v], i) => `<tr><td>${i + 1}. ${e(k)}</td><td class="n">${v}</td><td class="muted">${i && stages[i - 1][1] ? `${Math.round((v / stages[i - 1][1]) * 100)}% del paso anterior` : ""}</td></tr>`).join("");
  res.send(
    page(
      "Embudo SEAL SmartTrade",
      `<h1>Embudo — últimos ${days} días</h1><div class="card"><table>${rows}</table></div>
      <div class="card"><table>
        <tr><td>Clics en WhatsApp (no son leads: no se sabe si escribieron)</td><td class="n">${ev.whatsapp_clic}</td></tr>
        <tr><td>Formularios de contacto abiertos</td><td class="n">${ev.contacto_abierto}</td></tr>
        <tr><td>Envíos repetidos agrupados en el mismo caso</td><td class="n">${lf.repetidasAgrupadas}</td></tr>
        <tr><td>Casos sin contacto registrado</td><td class="n">${lf.sinAtender}</td></tr>
        <tr><td>Casos cuyo correo a SEAL falló (revisar)</td><td class="n">${lf.sinNotificar}</td></tr>
        <tr><td>Contactados / descartados</td><td class="n">${lf.contactados} / ${lf.descartados}</td></tr>
      </table></div>
      <p class="muted">Visitas, consultas y resultados se cuentan una vez por navegador y día. Calificados, cotizaciones y clientes se registran a mano desde el correo de cada caso. Excluye registros de prueba. <a href="?t=${e(clean(req.query.t, 64))}&days=7">7 días</a> · <a href="?t=${e(clean(req.query.t, 64))}&days=30">30 días</a> · <a href="?t=${e(clean(req.query.t, 64))}&days=90">90 días</a></p>`,
    ),
  );
});

// ── reminder: cases with no recorded contact after a day ────────────────────
const REMIND_AFTER = (parseFloat(process.env.LEAD_REMIND_HOURS) || 24) * 3600000;
export async function remindPending(base, now = Date.now()) {
  const due = dueForReminder(REMIND_AFTER, now);
  if (!due.length) return 0;
  await sendFollowUpReminder(due, (l) => linksFor(l, base));
  for (const l of due) markReminded(l.id, now);
  return due.length;
}
if (process.env.PUBLIC_API_URL && process.env.RESEND_API_KEY) {
  setInterval(() => remindPending(process.env.PUBLIC_API_URL).catch((err) => console.error("⚠️ reminder failed:", err.message)), 3600000).unref();
}
// without PUBLIC_API_URL the base is learned from the first request (index.js)
let learnedBase = "";
export function learnBase(req, _res, next) {
  if (!learnedBase && !process.env.PUBLIC_API_URL && req.get("host")) {
    learnedBase = baseUrl(req);
    if (process.env.RESEND_API_KEY)
      setInterval(() => remindPending(learnedBase).catch((err) => console.error("⚠️ reminder failed:", err.message)), 3600000).unref();
  }
  next();
}

export default router;
