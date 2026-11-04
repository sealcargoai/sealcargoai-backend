// 02-11t / 02-11w: the voltage (and AC/DC type) of the EQUIPMENT a listing title states, compared with the one
// the client asked for. The same rules (and the same words) run on the page: frontend src/utils/voltage.ts.
// Keep them identical; test/fixtures/voltage-vectors.json is shared by both test suites.
//
// - Any voltage is read (3.7 V, 12 V, 24 V DC, 220 V AC, 380 V…), with its current type when the title or the
//   request says it: "24VDC", "24 V CC", "24 VCA", "DC 24V", "AC220V", "24 V de corriente continua".
//   A type that nobody wrote is never assumed.
// - A voltage the title gives to a component ("control panel 220 V", "220V control voltage", "fan 220V",
//   "adapter 100-240V", the input of an adapter that also states its output) is not the equipment's — unless
//   the client asks for that very component (a "cargador 12 V" is the equipment).
// - What the title rules out ("380 V compressor, not 220 V") is not offered.
// - The equipment states only other voltages, or the asked one with the other current type → incompatible.
// - It states the requested one and others: explicit variants ("220V/380V", "220 or 380V", "optional")
//   → confirm the variant; otherwise it is unclear which figure is the equipment's → to confirm.
// - The asked voltage with no AC/DC when the client said which → «Tipo de corriente por confirmar».
// - It states no voltage (or only a component's) → «Voltaje del equipo por confirmar».
// - It states only the requested one (or a narrow operating range that includes it) → match, per the listing.
// Hz, W, kW, kV, VA, mAh and Ah are never read as volts. Exclusions only count when the negation is about the
// voltage: "sin aceite 220 V" asks for 220 V (oil-free), "no quiero 110 V" rules 110 V out.

const NUM = String.raw`(?<![\d.,])\d{1,4}(?:\.\d{1,2})?`;
// "v", "volts", "voltios", "vac", "vca", "vdc", "vcc", optionally followed by "ac"/"dc"/"ca"/"cc"
const UNIT = String.raw`(?:v(?:olts?|oltios?|ac|ca|dc|cc)?)(?:\s*-?\s*(?:ac|dc|ca|cc)(?![a-z]))?(?![a-z0-9])`;
const PRE = String.raw`(?:\b(?:ac|dc)\s*-?\s*)?`;
const SEP = String.raw`\s*(?:[\/]|\bo\b|\bu\b|\bor\b)\s*`;
// one figure or a list of figures before one unit: "24V", "220/380V", "220 o 380 V", "12V/24V DC"
const VOLT = String.raw`${PRE}${NUM}(?:\s*${UNIT})?(?:${SEP}${PRE}${NUM}(?:\s*${UNIT})?)*\s*${UNIT}`;
const RANGE = new RegExp(String.raw`${PRE}(${NUM})\s*(?:v(?:olts?)?\s*)?(?:-|–|~|\bto\b|\ba\b)\s*(${NUM})\s*(${UNIT})`, "gi");

const COMP = String.raw`(?:control\s+panel|panel(?:es)?\s+de\s+control|panel|tablero(?:\s+de\s+control)?|control(?:es)?|controller|controlador|circuito\s+de\s+control|control\s+circuit|motor\s+auxiliar|auxiliary(?:\s+motor)?|cooling\s+fan|fan|ventilador(?:es)?|lamps?|lights?|lighting|l[aá]mparas?|display|pantalla|plc|sensors?|sensor(?:es)?|solenoid(?:e|es)?|coil|bobina|dryer|secador(?:a)?|heater|calentador|transformer|transformador|charger|cargador|adapters?|adaptador(?:es)?)`;
// the client asks for that component itself: then its voltage is the equipment's
const SAME_PART = [
  /\b(?:charger|cargador)/, /\b(?:transformer|transformador)/, /\b(?:adapter|adaptador)/, /\b(?:fan|ventilador)/,
  /\b(?:lamp|light|l[aá]mpara|luz|luces|iluminaci)/, /\b(?:controller|controlador)/, /\b(?:display|pantalla)/, /\bplc\b/,
  /\bsensor/, /\b(?:solenoid|solenoide|v[aá]lvula)/, /\b(?:coil|bobina)/, /\b(?:dryer|secador)/, /\b(?:heater|calentador)/,
  /\b(?:panel|tablero)/,
];
const PART_WORD = (w) => SAME_PART.find((re) => re.test(w));

// what is ruled out: a negation followed only by words about the voltage ("no quiero 110 V", "not for 220V",
// "excepto los de 110 o 127 V") — never "sin aceite 220 V" / "no oil 220V", which ask for 220 V
const NEG = String.raw`(?:no|ni|sin|excepto|salvo|menos|excluy\w*|exclu[iy]\w*|descart\w*|evit\w*|not|nor|non|except|excluding|exclude\w*|without|avoid\w*)`;
const FILLER = String.raw`(?:quiero|necesito|deseo|busco|que|sea|sean|es|son|de|del|el|la|los|las|un|una|uno|para|apto|apta|aptos|compatible|con|a|en|uso|usar|funciona|trabaja|modelo|modelos|versi[oó]n|versiones|tipo|voltaje|tensi[oó]n|alimentaci[oó]n|i|we|want|need|for|is|it|the|an|any|suitable|with|use|used|rated|at|in|work|works|working|model|models|version|versions|type|voltage|supply|power|available|supported|compatible)`;
// "110 V ni 220 V", "110V or 127V" (each with its unit) — or bare figures with one unit: "110, 127 ni 220 V"
const NEG_LIST = String.raw`(?:${PRE}${NUM}\s*${UNIT}(?:\s*(?:[\/]|\bo\b|\bu\b|\bor\b|\bni\b|\bnor\b)\s*(?:(?:no|not)\s+)?${PRE}${NUM}\s*${UNIT})*|${PRE}${NUM}(?:\s*(?:[\/,]|\bo\b|\bu\b|\bor\b|\bni\b|\bnor\b|\by\b|\band\b)\s*${NUM})*\s*${UNIT})`;
const NEG_BEFORE = new RegExp(String.raw`\b${NEG}[\s-]+(?:${FILLER}\s+){0,4}?(${NEG_LIST})`, "gi");
const NEG_AFTER = new RegExp(String.raw`(${VOLT})\s+(?:(?:is\s+|are\s+)?not\s+(?:supported|available|compatible|included|accepted)|no\s+(?:es\s+)?(?:disponible|compatible|incluid[oa]|aceptad[oa]|soportad[oa]))\b`, "gi");
const NEG_CURRENT = /\b(?:no|ni|sin|excepto|not|nor|non|without|except|excluding)[\s-]+(?:(?:de|en|con|for|in|the|a|una|un)\s+)?(ac|dc|ca|cc|corriente\s+(?:alterna|continua|directa)|alternating\s+current|direct\s+current)\b/gi;

const curOf = (u) => {
  const s = String(u || "").toLowerCase().replace(/\s|-/g, "");
  if (/(?:dc|cc)$/.test(s) || /^dc/.test(s)) return "dc";
  if (/(?:ac|ca)$/.test(s) || /^ac/.test(s)) return "ac";
  return "";
};
// "24 V de corriente continua", "DC water pump 24V": one type word for the whole text
function textCurrent(t) {
  const dc = /\b(?:dc|corriente\s+(?:continua|directa)|direct\s+current)\b/.test(t);
  const ac = /\b(?:ac|corriente\s+alterna|alternating\s+current)\b/.test(t);
  if (/\bac\s*\/\s*dc\b|\bdc\s*\/\s*ac\b|\bac\s*(?:or|o|and|y)\s*dc\b/.test(t)) return "any";
  return dc && !ac ? "dc" : ac && !dc ? "ac" : "";
}
const ok = (v) => v > 0 && v <= 1500;

/** The voltages a text states: single figures and lists ({ v, cur }) and ranges ({ a, b, cur }). */
export function readVolts(text) {
  // 02-11w: "4V belt", "V-belt" are belt sections, not volts; "AC/DC" (both types) is read once for the text
  const both = /\bac\s*\/\s*dc\b|\bdc\s*\/\s*ac\b|\bac\s*(?:or|o|and|y)\s*dc\b/.test(String(text || "").toLowerCase());
  const t = String(text || "")
    .toLowerCase()
    .replace(/\b\d{1,2}\s*v[\s-]*(?:belts?|grooves?|pulleys?|fajas?|correas?)\b/g, " ")
    .replace(/\bac\s*\/\s*dc\b|\bdc\s*\/\s*ac\b|\bac\s*(?:or|o|and|y)\s*dc\b/g, " ");
  const ranges = [];
  const rest = t.replace(RANGE, (m, a, b, u) => {
    const lo = Math.min(+a, +b);
    const hi = Math.max(+a, +b);
    if (ok(lo) && ok(hi) && lo < hi) ranges.push({ a: lo, b: hi, cur: curOf(u) || curOf(m.slice(0, 3)) });
    return " ";
  });
  const list = [];
  for (const m of rest.matchAll(new RegExp(VOLT, "gi"))) {
    const parts = m[0].split(new RegExp(SEP, "i"));
    const last = curOf((m[0].match(new RegExp(String.raw`${UNIT}\s*$`, "i")) || [""])[0]) || curOf(m[0].trim().slice(0, 3));
    for (const p of parts) {
      const v = parseFloat((p.match(/\d{1,4}(?:\.\d{1,2})?/) || [])[0]);
      if (!ok(v)) continue;
      const own = curOf((p.match(new RegExp(`${UNIT}\\s*$`, "i")) || [""])[0]) || (/^\s*(?:ac|dc)/.test(p) ? curOf(p.trim().slice(0, 2)) : "");
      const cur = own || last;
      if (!list.some((x) => x.v === v && x.cur === cur)) list.push({ v, cur });
    }
  }
  // a type written once for the whole text applies to the figures that don't say it
  const whole = both ? "any" : textCurrent(rest);
  if (whole) {
    for (const x of list) if (!x.cur) x.cur = whole;
    for (const r of ranges) if (!r.cur) r.cur = whole;
  }
  // "24 V DC … output 24V": one figure; a typed one wins over the same figure without type
  const uniq = list.filter((x, i) => list.findIndex((y) => y.v === x.v && y.cur === x.cur) === i && !(!x.cur && list.some((y) => y.v === x.v && y.cur)));
  return { list: uniq, ranges };
}
const curTxt = (c) => (c === "dc" ? " DC" : c === "ac" ? " AC" : c === "any" ? " AC/DC" : "");
const num = (v) => String(v);
export function fmtVolts(e) {
  return [...e.ranges.map((r) => `${num(r.a)}-${num(r.b)} V${curTxt(r.cur)}`), ...e.list.map((x) => `${num(x.v)} V${curTxt(x.cur)}`)].join(" / ");
}

/** What a text rules out (figures, and a current type) and the text without those parts. */
export function negatedVolts(text) {
  const ruled = [];
  const ruledCur = [];
  const rest = ` ${String(text || "").toLowerCase()} `
    .replace(NEG_BEFORE, (m, list) => {
      const e = readVolts(list.replace(/\b(?:ni|nor|y|and|no|not)\b/g, "/").replace(/,/g, "/"));
      ruled.push(...e.list.map((x) => x.v), ...e.ranges.flatMap((r) => [r.a, r.b]));
      return " ";
    })
    .replace(NEG_AFTER, (_m, list) => (ruled.push(...readVolts(list).list.map((x) => x.v)), " "))
    .replace(NEG_CURRENT, (_m, w) => (ruledCur.push(/^(?:dc|cc)$|continua|directa|direct/.test(w) ? "dc" : "ac"), " "));
  return { ruled: [...new Set(ruled)], ruledCur: [...new Set(ruledCur)], rest };
}

// an adapter or power supply that states its output: its input figures are not the equipment's
const INPUT = new RegExp(String.raw`\b(?:input|entrada)(?:\s+(?:voltage|de\s+voltaje|volt(?:aje|age)))?\s*[:=]?\s*(?:${PRE}(?:${NUM})\s*(?:v(?:olts?)?\s*)?(?:-|–|~|\bto\b|\ba\b)\s*(?:${NUM})\s*${UNIT}|${VOLT})|(?:${VOLT})\s+(?:input|de\s+entrada)\b`, "gi");
const HAS_OUTPUT = /\b(?:output|salida)\b/;

/**
 * The client's request: the voltages asked (without what they rule out and without the input of an adapter
 * when they also say the output), and what they rule out.
 */
export function requestedVolts(description) {
  const d0 = ` ${String(description || "").toLowerCase()} `;
  const n = negatedVolts(d0);
  const d = HAS_OUTPUT.test(n.rest) ? n.rest.replace(INPUT, " ") : n.rest;
  const want = readVolts(d);
  want.list = want.list.filter((x) => !n.ruled.includes(x.v));
  return { ...want, ruled: n.ruled, ruledCur: n.ruledCur };
}

/** The title without the voltages it gives to components (or rules out), and those voltages. */
export function equipmentPart(title, description) {
  const comp = [];
  const d = ` ${String(description || "").toLowerCase()} `;
  const keep = (m) => {
    const re = PART_WORD(m);
    return !!re && re.test(d);
  };
  const COMP_BEFORE = new RegExp(String.raw`\b${COMP}\b(?:\s+[a-záéíóúñ]+){0,2}?\s*[:(]?\s*(?:${PRE}${NUM}\s*(?:v(?:olts?)?\s*)?(?:-|–|~|\bto\b)\s*${NUM}\s*${UNIT}|${VOLT})`, "gi");
  const COMP_AFTER = new RegExp(String.raw`(?:${PRE}${NUM}\s*(?:v(?:olts?)?\s*)?(?:-|–|~|\bto\b)\s*${NUM}\s*${UNIT}|${VOLT})\s+(?:(?:for|para|de|del)\s+(?:the\s+|el\s+|la\s+)?)?(?:(?:car|auto|usb|wall|plug|power|external|externo|de\s+corriente|led)\s+)?${COMP}\b`, "gi");
  const strip = (m) => {
    if (keep(m)) return m;
    const e = readVolts(m);
    comp.push(...e.list.map((x) => x.v), ...e.ranges.map((r) => `${r.a}-${r.b}`));
    return " ";
  };
  let t = ` ${String(title || "").toLowerCase()} `;
  const n = negatedVolts(t);
  t = n.rest;
  if (HAS_OUTPUT.test(t)) t = t.replace(INPUT, strip);
  t = t.replace(COMP_BEFORE, strip).replace(COMP_AFTER, strip);
  return { text: t, componentVolts: [...new Set(comp)], excluded: n.ruled, excludedCur: n.ruledCur };
}

/**
 * null when the client asked nothing about voltage. Otherwise { verdict, es, en }:
 * verdict "match" | "confirm" | "incompatible" and the reason in both languages.
 */
export function voltageCheck(description, title) {
  const want = requestedVolts(description);
  const asked = want.list.length + want.ranges.length > 0;
  if (!asked && !want.ruled.length && !want.ruledCur.length) return null;
  const eq = equipmentPart(title, description);
  const got = readVolts(eq.text);
  const wantTxt = fmtVolts(want);
  const comp = eq.componentVolts.length ? eq.componentVolts.map((v) => `${v} V`).join(" / ") : "";
  const gotTxt = fmtVolts(got);
  const exclTxt = eq.excluded.map((v) => `${v} V`).join(" / ");
  // the title itself rules out the asked voltage ("380 V compressor, not 220 V")
  const wantedVals = [...want.list.map((x) => x.v), ...want.ranges.flatMap((r) => [r.a, r.b])];
  if (asked && eq.excluded.length && want.list.length && want.list.every((x) => eq.excluded.includes(x.v)))
    return gotTxt
      ? { verdict: "incompatible", es: `Esta publicación indica ${gotTxt} y excluye ${exclTxt}; solicitaste ${wantTxt}`, en: `This listing states ${gotTxt} and rules out ${exclTxt}; you asked for ${wantTxt}` }
      : { verdict: "incompatible", es: `Esta publicación excluye ${exclTxt}; solicitaste ${wantTxt}`, en: `This listing rules out ${exclTxt}; you asked for ${wantTxt}` };
  // a narrow operating range ("220-240V", "12-24V") is one rating; a wide one ("220-380V") is a list of variants
  const narrow = got.ranges.filter((r) => r.b - r.a <= 40);
  const wide = got.ranges.filter((r) => r.b - r.a > 40);
  const options = [...got.list, ...wide.flatMap((r) => [{ v: r.a, cur: r.cur }, { v: r.b, cur: r.cur }])];
  if (!options.length && !narrow.length) {
    if (!asked) return null;
    return {
      verdict: "confirm",
      es: `Voltaje del equipo por confirmar${comp ? ` (el título indica ${comp} solo para un componente, no para el equipo)` : ""}; pediste ${wantTxt}`,
      en: `Equipment voltage to confirm${comp ? ` (the title states ${comp} only for a component, not for the equipment)` : ""}; you asked for ${wantTxt}`,
    };
  }
  if (!asked) {
    const all = [...got.list.map((x) => x.v), ...got.ranges.flatMap((r) => [r.a, r.b])];
    if (want.ruled.length && all.length && all.every((v) => want.ruled.includes(v)))
      return { verdict: "incompatible", es: `Esta publicación indica ${gotTxt}, que excluiste`, en: `This listing states ${gotTxt}, which you ruled out` };
    const curs = [...got.list.map((x) => x.cur), ...got.ranges.map((r) => r.cur)];
    if (want.ruledCur.length && curs.length && curs.every((c) => c && c !== "any" && want.ruledCur.includes(c)))
      return { verdict: "incompatible", es: `Esta publicación indica ${gotTxt}, un tipo de corriente que excluiste`, en: `This listing states ${gotTxt}, a current type you ruled out` };
    return null;
  }
  // the figures of the title that carry an asked voltage
  const carriers = [];
  for (const w of want.list) {
    for (const o of options) if (o.v === w.v) carriers.push({ w, o });
    for (const r of narrow) if (w.v >= r.a && w.v <= r.b) carriers.push({ w, o: r });
  }
  for (const w of want.ranges) {
    for (const o of options) if (o.v >= w.a && o.v <= w.b) carriers.push({ w, o });
    for (const r of narrow) if (r.a <= w.b && r.b >= w.a) carriers.push({ w, o: r });
  }
  if (!carriers.length)
    return {
      verdict: "incompatible",
      es: `Esta publicación indica ${gotTxt}${comp ? ` para el equipo (${comp} es de un componente)` : ""}; solicitaste ${wantTxt}`,
      en: `This listing states ${gotTxt}${comp ? ` for the equipment (${comp} is for a component)` : ""}; you asked for ${wantTxt}`,
    };
  // AC/DC: compared only when both sides say it; a type the client ruled out counts as another type
  const curFits = (wc, oc) => !oc || oc === "any" || (wc ? oc === wc : !want.ruledCur.includes(oc));
  const fitting = carriers.filter(({ w, o }) => curFits(w.cur, o.cur));
  if (!fitting.length) {
    const listed = fmtVolts({ list: carriers.filter((c) => c.o.v !== undefined).map((c) => c.o), ranges: carriers.filter((c) => c.o.a !== undefined).map((c) => c.o) });
    const asks = want.list.some((x) => x.cur) || want.ranges.some((r) => r.cur);
    return asks
      ? { verdict: "incompatible", es: `Esta publicación indica ${listed}; solicitaste ${wantTxt}`, en: `This listing states ${listed}; you asked for ${wantTxt}` }
      : { verdict: "incompatible", es: `Esta publicación indica ${listed}, un tipo de corriente que excluiste`, en: `This listing states ${listed}, a current type you ruled out` };
  }
  const others = options.filter((o) => !wantedVals.includes(o.v) && !want.ranges.some((r) => o.v >= r.a && o.v <= r.b));
  // «220 o 380 V»: the client hasn't decided; the uncertainty stays (never a match on its own)
  if (want.list.length > 1 && !want.ranges.length)
    return { verdict: "confirm", es: `Indica ${gotTxt}; mencionaste ${wantTxt}: confirma qué voltaje necesitas`, en: `States ${gotTxt}; you mentioned ${wantTxt}: confirm which voltage you need` };
  if (others.length) {
    if (wide.length || VARIANT.test(eq.text))
      return { verdict: "confirm", es: `Confirma que te coticen la variante de ${wantTxt} (el título ofrece ${gotTxt})`, en: `Confirm they quote the ${wantTxt} variant (the title offers ${gotTxt})` };
    return {
      verdict: "confirm",
      es: `Voltaje del equipo por confirmar: el título indica ${gotTxt} sin decir a qué corresponde cada cifra; pediste ${wantTxt}`,
      en: `Equipment voltage to confirm: the title states ${gotTxt} without saying what each figure refers to; you asked for ${wantTxt}`,
    };
  }
  // the asked voltage is there; the type the client asked is not written for it
  const wantCur = [...want.list, ...want.ranges].map((x) => x.cur).find(Boolean) || "";
  if (wantCur && !fitting.some(({ o }) => o.cur === wantCur || o.cur === "any"))
    return {
      verdict: "confirm",
      es: `Tipo de corriente por confirmar: el título indica ${gotTxt} sin decir si es AC o DC; pediste ${wantTxt}`,
      en: `Current type to confirm: the title states ${gotTxt} without saying whether it is AC or DC; you asked for ${wantTxt}`,
    };
  return { verdict: "match", es: `Indica la alimentación pedida: ${wantTxt}`, en: `States the requested power supply: ${wantTxt}` };
}

const VARIANT = /\b\d{1,4}\s*v\b[^,;()]{0,30}?\s(?:or|o|u)\s+\d{1,4}\s*v\b|\b\d{1,4}\s*(?:v|volts?)?\s*\/\s*\d{1,4}\s*(?:v|volts?|vac|vdc)\b|\b\d{1,4}\s*(?:v|volts?|vac|vdc)\s*\/\s*\d{1,4}|\b\d{1,4}\s*(?:v|volts?)?\s+(?:or|o|u)\s+\d{1,4}\s*(?:v|volts?)\b|\b(?:optional|opcional(?:es)?|customi[sz]\w*|personaliz\w*|available|disponibles?|variants?|variantes?|options?|opciones)\s+(?:de\s+|in\s+)?(?:voltage|voltaje|\d{1,4}\s*v\b)|\b(?:voltage|voltaje)\s+(?:optional|opcional|customi[sz]\w*|personaliz\w*|options?|opciones|can\s+be\s+customi[sz]ed)/i;
