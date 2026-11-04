// 02-11s: explicit contradictions between what the client asked (their ORIGINAL description, ES/EN) and a
// listing title. Applied to every search path (first keyword, shorter retry, any fallback) BEFORE scoring and
// ordering, so a 380 V compressor, a latex glove or a steel toe boot never takes a place in the
// recommendations of a «220 V» / «sin látex» / «puntera compuesta» request. Only what is written counts:
// a title that says nothing is NOT excluded here (the page shows it as «por confirmar»). These rules are a
// subset of the page's own comparison (frontend utils/differences.ts), so the server never drops a listing
// the page would recommend.

import { voltageCheck } from "./voltage.js";

const NEG = String.raw`(?:no|ni|sin|excepto|salvo|not|nor|except|excluding|without)`;
const low = (t) => ` ${String(t || "").toLowerCase()} `;

// ── latex ──────────────────────────────────────────────────────────────────────
const LATEX = /l[aá]tex/;
// "sin látex", "libre(s) de látex", "latex-free", "free of latex", "non-latex", "no latex", "without latex"
const NO_LATEX = /\b(?:sin|libres?\s+de|free\s+of|without|non|no)[\s-]+(?:contenido\s+de\s+)?l[aá]tex\b|\bl[aá]tex[\s-]*free\b/g;
const wantsNoLatex = (d) => NO_LATEX.test(low(d)) && ((NO_LATEX.lastIndex = 0), true);
function latexIssue(desc, title) {
  NO_LATEX.lastIndex = 0;
  if (!wantsNoLatex(desc)) return "";
  NO_LATEX.lastIndex = 0;
  const rest = low(title).replace(NO_LATEX, " ");
  return LATEX.test(rest) ? { es: "La publicación indica látex, un material que excluiste", en: "The listing states latex, a material you ruled out" } : "";
}

// ── voltage and phase ──────────────────────────────────────────────────────────
const RANGE = /(\d{3})\s*(?:-|–|~|to|a)\s*(\d{3})\s*(?:v|volts?|voltios?|vac|vca)\b/g;
const VOLTS = /(\d{2,3})(?:\s*(?:\/|\bo\b|\bu\b|\bor\b)\s*(\d{2,3}))*\s*(?:v|volts?|voltios?|vac|vca)\b/g;
const NEG_VOLTS = new RegExp(String.raw`\b${NEG}\s+(?:[a-záéíóúüñ]+\s+){0,3}?(\d{2,3})\s*(?:v|volts?|voltios?|vac)\b`, "g");
function electric(text) {
  const ranges = [];
  const rest = text.replace(RANGE, (_m, a, b) => {
    const lo = Math.min(+a, +b);
    const hi = Math.max(+a, +b);
    if (lo >= 100 && hi <= 690) ranges.push([lo, hi]);
    return " ";
  });
  const volts = [...new Set([...rest.matchAll(VOLTS)].flatMap((m) => m[0].match(/\d{2,3}/g).map(Number).filter((v) => v >= 100 && v <= 690)))];
  return { volts, ranges };
}
const SINGLE = /\b(?:monof[aá]sic[oa]s?|single[\s-]*phase|1[\s-]*(?:phase|fase|ph)\b)/;
const THREE = /\b(?:trif[aá]sic[oa]s?|three[\s-]*phase|3[\s-]*(?:phase|fases?|ph)\b)/;
// 02-11t: the equipment's voltage only (a component's "control panel 220 V" is not the equipment's), with
// the same rules and words as the page (services/voltage.js ⇄ frontend utils/voltage.ts)
function voltageIssue(desc, title) {
  const v = voltageCheck(desc, title);
  return v?.verdict === "incompatible" ? { es: v.es, en: v.en } : "";
}
function phaseIssue(desc, title) {
  const d = low(desc).replace(new RegExp(String.raw`\b${NEG}\s+(?:[a-záéíóúüñ]+\s+){0,3}?(?:monof[aá]sic\w*|trif[aá]sic\w*|single[\s-]*phase|three[\s-]*phase)`, "g"), " ");
  const want = SINGLE.test(d) && !THREE.test(d) ? "single" : THREE.test(d) && !SINGLE.test(d) ? "three" : "";
  if (!want) return "";
  const t = low(title);
  const got = SINGLE.test(t) && !THREE.test(t) ? "single" : THREE.test(t) && !SINGLE.test(t) ? "three" : "";
  const es = (p) => (p === "single" ? "monofásico" : "trifásico");
  const en = (p) => (p === "single" ? "single-phase" : "three-phase");
  if (got && got !== want) return { es: `La publicación indica ${es(got)}; solicitaste ${es(want)}`, en: `The listing states ${en(got)}; you asked for ${en(want)}` };
  return "";
}

// ── toe cap material ───────────────────────────────────────────────────────────
const TOE = String.raw`(?:toes?|toe\s*caps?|toecaps?)`;
const T_STEEL = new RegExp(String.raw`\b(?:steel|metal(?:lic)?)[\s-]+${TOE}\b`);
const T_COMP = new RegExp(String.raw`\b(?:composite|non[\s-]*metal(?:lic)?|fiberglass|fibreglass|kevlar|plastic)[\s-]+${TOE}\b`);
function toeWanted(desc) {
  const d = low(desc);
  if (/\bpunteras?\s+(?:de\s+)?(?:material\s+)?compuest[oa]s?\b|\bpunteras?\s+no\s+met[aá]lic[oa]s?\b|\bpunteras?\s+(?:de\s+)?(?:fibra|composite)\b|\bcomposite\s+toe|\bnon[\s-]*metal(?:lic)?\s+toe/.test(d)) return "composite";
  if (/\bpunteras?\s+(?:de\s+)?(?:acero|met[aá]lic[oa]s?)\b|\bsteel\s+toe/.test(d)) return "steel";
  return "";
}
function toeIssue(desc, title) {
  const want = toeWanted(desc);
  if (!want) return "";
  const t = low(title);
  const steel = T_STEEL.test(t);
  const comp = T_COMP.test(t);
  if (want === "composite" && steel && !comp) return { es: "Indica puntera de acero; pediste puntera de material compuesto", en: "States a steel toe cap; you asked for composite" };
  if (want === "steel" && comp && !steel) return { es: "Indica puntera de material compuesto; pediste puntera de acero", en: "States a composite toe cap; you asked for steel" };
  return "";
}

// ── a part or accessory instead of the product ────────────────────────────────
const PART = /\b(?:spare\s+parts?|parts?\s+for|accessor(?:y|ies)\s+for|replacement\s+parts?|repair\s+kits?|toe\s*caps?\s+for|filter\s+elements?\s+for)\b/;
const ASKS_PART = /\b(?:repuestos?|piezas?|partes?|accesorios?|kit|punteras?\s+para|spare|parts?|accessor(?:y|ies)|replacement)\b/;
function partIssue(desc, title) {
  if (ASKS_PART.test(low(desc))) return "";
  return PART.test(low(title)) ? { es: "Parece un repuesto o accesorio, no el producto completo", en: "Looks like a spare part or accessory, not the complete product" } : "";
}

const CHECKS = [latexIssue, voltageIssue, phaseIssue, toeIssue, partIssue];
/** The first explicit contradiction as { es, en } ("" when there is none). */
export function contradiction(description, title) {
  for (const c of CHECKS) {
    const r = c(description, title);
    if (r) return r;
  }
  return "";
}

// what the page says when the title is silent about something asked (same words as frontend materialUnstated)
const OTHER_GLOVE_MATERIAL = /\b(?:nitri(?:le|lo)|vin(?:yl|ilo)|pvc|tpe|neopren[eo]|polyethylene|polietileno|pe)\b/;
function unstated(desc, title) {
  const t = low(title);
  const out = [];
  NO_LATEX.lastIndex = 0;
  const noLatex = wantsNoLatex(desc);
  NO_LATEX.lastIndex = 0;
  if (noLatex && !NO_LATEX.test(t) && !LATEX.test(t) && !OTHER_GLOVE_MATERIAL.test(t))
    out.push({ es: "La publicación no indica si contiene látex (lo excluiste); confírmalo con el proveedor.", en: "The listing does not state whether it contains latex (you ruled it out); confirm it with the supplier." });
  NO_LATEX.lastIndex = 0;
  const toe = toeWanted(desc);
  if (toe && !T_STEEL.test(t) && !T_COMP.test(t))
    out.push(
      toe === "composite"
        ? { es: "La publicación no indica de qué es la puntera (pediste material compuesto); confírmalo con el proveedor.", en: "The listing does not state what the toe cap is made of (you asked for composite); confirm it with the supplier." }
        : { es: "La publicación no indica de qué es la puntera (pediste acero); confírmalo con el proveedor.", en: "The listing does not state what the toe cap is made of (you asked for steel); confirm it with the supplier." },
    );
  return out;
}

/**
 * 02-11t: the verdict the page shows for the properties checked here: "incompatible" (with the reason),
 * "confirm" (something asked is not stated, or several voltages) or "match" (per the listing, not verified).
 */
export function specVerdict(description, title) {
  const bad = contradiction(description, title);
  if (bad) return { verdict: "incompatible", reasons: [bad], toConfirm: [] };
  const v = voltageCheck(description, title);
  const toConfirm = [...(v?.verdict === "confirm" ? [{ es: v.es, en: v.en }] : []), ...unstated(description, title)];
  return { verdict: toConfirm.length ? "confirm" : "match", reasons: [], toConfirm };
}

/**
 * Removes the listings whose title contradicts the description. Keeps the list's offerCount and adds
 * specExcluded (count) and specReasons (up to 5 examples as { es, en }, no client text).
 */
export function gateBySpecs(list, description) {
  const src = Array.isArray(list) ? list : [];
  const kept = [];
  const reasons = [];
  for (const s of src) {
    const r = contradiction(description, s?.productName || "");
    if (r) reasons.push(r);
    else {
      const v = specVerdict(description, s?.productName || "");
      kept.push({ ...s, specVerdict: { verdict: v.verdict, notes: v.toConfirm.slice(0, 3) } });
    }
  }
  kept.offerCount = src.offerCount ?? src.length;
  kept.specExcluded = reasons.length;
  const seen = new Set();
  kept.specReasons = reasons.filter((r) => !seen.has(r.es) && seen.add(r.es)).slice(0, 5);
  return kept;
}

/**
 * The client's requirements in the platform's words, appended to the search keyword when the translated or
 * shortened keyword lost them ("guantes sin látex" → "disposable gloves" + "latex free").
 */
export function constraintTerms(description) {
  const d = low(description);
  const out = [];
  NO_LATEX.lastIndex = 0;
  if (wantsNoLatex(description)) out.push("latex free");
  NO_LATEX.lastIndex = 0;
  const ruled = [];
  const dd = d.replace(NEG_VOLTS, (_m, v) => (ruled.push(+v), " "));
  const e = electric(dd);
  const vs = e.volts.filter((x) => !ruled.includes(x));
  // one voltage asked: it goes in the query; several («220 o 380 V») stay undecided (nothing added)
  if (vs.length === 1 && !e.ranges.length) out.push(`${vs[0]}v`);
  else if (!vs.length && e.ranges.length === 1) out.push(`${e.ranges[0][0]}-${e.ranges[0][1]}v`);
  const toe = toeWanted(description);
  if (toe) out.push(`${toe} toe`);
  return out;
}
/**
 * The keyword the platform is asked for, and the one titles are compared with (relevance). A ruled-out
 * material that slipped into the keyword ("guantes sin látex" → "latex gloves") is taken out of both; the
 * client's requirements are added to the platform query only, so they don't lower the relevance share.
 */
// 02-11t: what the translation may add or change that the client never asked for. The ORIGINAL description
// decides: a voltage, phase or toe-cap material in the keyword that the description doesn't ask for (or rules
// out) is removed before the query is built ("220 V" translated as "industrial compressor 380v").
const KW_VOLT = /\b\d{2,3}(?:\s*[\/-]\s*\d{2,3})*\s*(?:v|volts?|vac)\b/gi;
const KW_PHASE = /\b(?:single|one|1|three|3)[\s-]*(?:phase|ph)\b/gi;
function sanitizeKeyword(keyword, description) {
  const d = low(description);
  const ruled = [];
  const dd = d.replace(NEG_VOLTS, (_m, v) => (ruled.push(+v), " "));
  NEG_VOLTS.lastIndex = 0;
  const e = electric(dd);
  const wanted = e.volts.filter((x) => !ruled.includes(x));
  const okVolt = (v) => wanted.includes(v) || e.ranges.some(([a, b]) => v >= a && v <= b);
  let k = String(keyword || "").replace(KW_VOLT, (m) => {
    const vs = (m.match(/\d{2,3}/g) || []).map(Number);
    return vs.length && vs.every(okVolt) ? m : " ";
  });
  const dSingle = SINGLE.test(d);
  const dThree = THREE.test(d);
  k = k.replace(KW_PHASE, (m) => {
    const single = /^(?:single|one|1)/i.test(m);
    return (single && dSingle) || (!single && dThree) ? m : " ";
  });
  const toe = toeWanted(description);
  if (toe !== "steel") k = k.replace(/\b(?:steel|metal(?:lic)?)(?=[\s-]+(?:toes?|toe\s*caps?|toecaps?)\b)/gi, " ");
  if (toe !== "composite") k = k.replace(/\b(?:composite|non[\s-]*metal(?:lic)?|fiberglass)(?=[\s-]+(?:toes?|toe\s*caps?|toecaps?)\b)/gi, " ");
  return k.replace(/\s+/g, " ").trim();
}

export function constrainKeyword(keyword, description) {
  let k = sanitizeKeyword(keyword, description);
  NO_LATEX.lastIndex = 0;
  if (wantsNoLatex(description) && !/l[aá]tex[\s-]*free|non[\s-]*l[aá]tex/i.test(k)) k = k.replace(/\bl[aá]tex\b/gi, " ").replace(/\s+/g, " ").trim();
  NO_LATEX.lastIndex = 0;
  const relevanceKeyword = k.replace(/\b(?:l[aá]tex[\s-]*free|non[\s-]*l[aá]tex)\b/gi, " ").replace(/\s+/g, " ").trim() || k;
  const kl = k.toLowerCase();
  const add = constraintTerms(description).filter((term) => !kl.includes(term) && !(/^\d/.test(term) && kl.includes(term.replace(/v$/, ""))));
  return { searchKeyword: add.length ? `${k} ${add.join(" ")}`.trim() : k, relevanceKeyword };
}
