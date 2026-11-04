// 02-11s: explicit contradictions between what the client asked (their ORIGINAL description, ES/EN) and a
// listing title. Applied to every search path (first keyword, shorter retry, any fallback) BEFORE scoring and
// ordering, so a 380 V compressor, a latex glove or a steel toe boot never takes a place in the
// recommendations of a «220 V» / «sin látex» / «puntera compuesta» request. Only what is written counts:
// a title that says nothing is NOT excluded here (the page shows it as «por confirmar»). These rules are a
// subset of the page's own comparison (frontend utils/differences.ts), so the server never drops a listing
// the page would recommend.

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
const VOLTS = /(\d{2,3})(?:\s*\/\s*(\d{2,3}))*\s*(?:v|volts?|voltios?|vac|vca)\b/g;
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
function voltageIssue(desc, title) {
  let d = low(desc);
  const ruled = [];
  d = d.replace(NEG_VOLTS, (_m, v) => (ruled.push(+v), " "));
  const want = electric(d);
  want.volts = want.volts.filter((v) => !ruled.includes(v));
  const got = electric(low(title));
  const gotAny = got.volts.length + got.ranges.length > 0;
  if (!gotAny) return "";
  const meets = (v) => got.volts.includes(v) || got.ranges.some(([a, b]) => v >= a && v <= b);
  const wantAny = want.volts.length + want.ranges.length > 0;
  const ok =
    want.volts.some(meets) ||
    want.ranges.some(([a, b]) => got.volts.some((v) => v >= a && v <= b) || got.ranges.some(([c, e]) => c <= b && e >= a));
  const g = [...got.ranges.map(([a, b]) => `${a}-${b} V`), ...got.volts.map((v) => `${v} V`)].join(" / ");
  const w = [...want.ranges.map(([a, b]) => `${a}-${b} V`), ...want.volts.map((v) => `${v} V`)].join(" / ");
  if (wantAny && !ok) return { es: `La publicación indica ${g}; solicitaste ${w}`, en: `The listing states ${g}; you asked for ${w}` };
  if (!wantAny && ruled.length && got.ranges.length === 0 && got.volts.every((v) => ruled.includes(v)))
    return { es: `La publicación indica ${got.volts.join(" / ")} V, que excluiste`, en: `The listing states ${got.volts.join(" / ")} V, which you ruled out` };
  return "";
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
  if (want === "composite" && steel && !comp) return { es: "Indica puntera de acero; pediste puntera de material compuesto", en: "States a steel toe cap; you asked for a composite one" };
  if (want === "steel" && comp && !steel) return { es: "Indica puntera de material compuesto; pediste puntera de acero", en: "States a composite toe cap; you asked for a steel one" };
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
    else kept.push(s);
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
  const v = e.volts.find((x) => !ruled.includes(x));
  if (v) out.push(`${v}v`);
  else if (e.ranges.length) out.push(`${e.ranges[0][0]}-${e.ranges[0][1]}v`);
  const toe = toeWanted(description);
  if (toe) out.push(`${toe} toe`);
  return out;
}
/**
 * The keyword the platform is asked for, and the one titles are compared with (relevance). A ruled-out
 * material that slipped into the keyword ("guantes sin látex" → "latex gloves") is taken out of both; the
 * client's requirements are added to the platform query only, so they don't lower the relevance share.
 */
export function constrainKeyword(keyword, description) {
  let k = String(keyword || "").replace(/\s+/g, " ").trim();
  NO_LATEX.lastIndex = 0;
  if (wantsNoLatex(description) && !/l[aá]tex[\s-]*free|non[\s-]*l[aá]tex/i.test(k)) k = k.replace(/\bl[aá]tex\b/gi, " ").replace(/\s+/g, " ").trim();
  NO_LATEX.lastIndex = 0;
  const relevanceKeyword = k.replace(/\b(?:l[aá]tex[\s-]*free|non[\s-]*l[aá]tex)\b/gi, " ").replace(/\s+/g, " ").trim() || k;
  const kl = k.toLowerCase();
  const add = constraintTerms(description).filter((term) => !kl.includes(term) && !(/^\d/.test(term) && kl.includes(term.replace(/v$/, ""))));
  return { searchKeyword: add.length ? `${k} ${add.join(" ")}`.trim() : k, relevanceKeyword };
}
