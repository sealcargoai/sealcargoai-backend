// 02-11t: the voltage of the EQUIPMENT a listing title states, compared with the one the client asked for.
// The same rules (and the same words) run on the page: frontend src/utils/voltage.ts. Keep them identical;
// test/fixtures/voltage-vectors.json is shared by both test suites.
//
// - A voltage the title gives to a component ("control panel 220 V", "220V control voltage", "fan 220V")
//   is not the equipment's voltage.
// - The equipment states only other voltages → incompatible.
// - It states the requested one and others: explicit variants ("220V/380V", "220 or 380V", "optional")
//   → confirm the variant; otherwise it is unclear which figure is the equipment's → to confirm.
// - It states no voltage (or only a component's) → «Voltaje del equipo por confirmar».
// - It states only the requested one (or a narrow operating range that includes it) → match, per the listing.
// Hz, W, kW, kV, mAh… are never read as volts.

// "220V", "220/380V", "220 o 380 V", "220 or 380V" (several values before one unit)
const VOLT = String.raw`\d{2,3}(?:\s*(?:[\/-]|\bo\b|\bu\b|\bor\b)\s*\d{2,3})*\s*(?:v|volts?|voltios?|vac|vca)(?![a-z])`;
const COMP = String.raw`(?:control\s+panel|panel(?:es)?\s+de\s+control|panel|tablero(?:\s+de\s+control)?|control(?:es)?|controller|controlador|circuito\s+de\s+control|control\s+circuit|motor\s+auxiliar|auxiliary(?:\s+motor)?|cooling\s+fan|fan|ventilador(?:es)?|lamps?|lights?|lighting|l[aá]mparas?|display|pantalla|plc|sensors?|sensor(?:es)?|solenoid(?:e|es)?|coil|bobina|dryer|secador(?:a)?|heater|calentador|transformer|transformador|charger|cargador)`;
// "control panel 220 V", "panel de control: 220V"
const COMP_BEFORE = new RegExp(String.raw`\b${COMP}\b(?:\s+[a-záéíóúñ]+){0,2}?\s*[:(]?\s*${VOLT}`, "gi");
// "220V control voltage", "220 V para el panel", "220v for the fan"
const COMP_AFTER = new RegExp(String.raw`${VOLT}\s+(?:(?:for|para|de|del)\s+(?:the\s+|el\s+|la\s+)?)?${COMP}\b`, "gi");
const NEG = String.raw`(?:no|ni|sin|excepto|salvo|not|nor|except|excluding|without)`;
const NEG_VOLTS = new RegExp(String.raw`\b${NEG}\s+(?:[a-záéíóúüñ]+\s+){0,3}?(\d{2,3})\s*(?:v|volts?|voltios?|vac)\b`, "gi");
const VARIANT = /\b\d{2,3}\s*(?:v|volts?)?\s*\/\s*\d{2,3}\s*(?:v|volts?|vac)\b|\b\d{2,3}\s*(?:v|volts?|vac)\s*\/\s*\d{2,3}|\b\d{2,3}\s*(?:v|volts?)?\s+(?:or|o|u)\s+\d{2,3}\s*(?:v|volts?)\b|\b(?:optional|opcional(?:es)?|customi[sz]\w*|personaliz\w*|available|disponibles?|variants?|variantes?|options?|opciones)\s+(?:de\s+|in\s+)?(?:voltage|voltaje|\d{2,3}\s*v\b)|\b(?:voltage|voltaje)\s+(?:optional|opcional|customi[sz]\w*|personaliz\w*|options?|opciones|can\s+be\s+customi[sz]ed)/i;

function volts(text) {
  const ranges = [];
  const rest = text.replace(/(\d{3})\s*(?:-|–|~|to|a)\s*(\d{3})\s*(?:v|volts?|voltios?|vac|vca)(?![a-z])/gi, (_m, a, b) => {
    const lo = Math.min(+a, +b);
    const hi = Math.max(+a, +b);
    if (lo >= 100 && hi <= 690) ranges.push([lo, hi]);
    return " ";
  });
  const list = [...new Set([...rest.matchAll(new RegExp(VOLT, "gi"))].flatMap((m) => m[0].match(/\d{2,3}/g).map(Number).filter((v) => v >= 100 && v <= 690)))];
  return { list, ranges };
}
const fmt = (e) => [...e.ranges.map(([a, b]) => `${a}-${b} V`), ...e.list.map((v) => `${v} V`)].join(" / ");

/** The title without the voltages it gives to components, and those component voltages. */
export function equipmentPart(title) {
  const comp = [];
  const t = ` ${String(title || "").toLowerCase()} `
    .replace(COMP_BEFORE, (m) => (comp.push(...volts(m).list), " "))
    .replace(COMP_AFTER, (m) => (comp.push(...volts(m).list), " "));
  return { text: t, componentVolts: [...new Set(comp)] };
}

/**
 * null when the client asked nothing about voltage. Otherwise { verdict, es, en }:
 * verdict "match" | "confirm" | "incompatible" and the reason in both languages.
 */
export function voltageCheck(description, title) {
  const ruled = [];
  const d = ` ${String(description || "").toLowerCase()} `.replace(NEG_VOLTS, (_m, v) => (ruled.push(+v), " "));
  const want = volts(d);
  want.list = want.list.filter((v) => !ruled.includes(v));
  const asked = want.list.length + want.ranges.length > 0;
  if (!asked && !ruled.length) return null;
  const eq = equipmentPart(title);
  const got = volts(eq.text);
  // a narrow operating range ("220-240V") is one rating; a wide one ("220-380V") is a list of variants
  const narrow = got.ranges.filter(([a, b]) => b - a <= 40);
  const wide = got.ranges.filter(([a, b]) => b - a > 40);
  const options = [...got.list, ...wide.flat()];
  const meets = (v) => options.includes(v) || narrow.some(([a, b]) => v >= a && v <= b);
  const wantTxt = fmt(want);
  const comp = eq.componentVolts.length ? eq.componentVolts.map((v) => `${v} V`).join(" / ") : "";
  if (!options.length && !narrow.length) {
    if (!asked) return null;
    return {
      verdict: "confirm",
      es: `Voltaje del equipo por confirmar${comp ? ` (el título indica ${comp} solo para un componente, no para el equipo)` : ""}; pediste ${wantTxt}`,
      en: `Equipment voltage to confirm${comp ? ` (the title states ${comp} only for a component, not for the equipment)` : ""}; you asked for ${wantTxt}`,
    };
  }
  const gotTxt = fmt({ list: got.list, ranges: got.ranges });
  if (!asked) {
    const all = [...got.list, ...got.ranges.flat()];
    if (all.length && all.every((v) => ruled.includes(v)))
      return { verdict: "incompatible", es: `Esta publicación indica ${gotTxt}, que excluiste`, en: `This listing states ${gotTxt}, which you ruled out` };
    return null;
  }
  const wanted = [...want.list, ...want.ranges.flat()];
  const hit = want.list.some(meets) || want.ranges.some(([a, b]) => options.some((v) => v >= a && v <= b) || narrow.some(([c, e]) => c <= b && e >= a));
  if (!hit)
    return {
      verdict: "incompatible",
      es: `Esta publicación indica ${gotTxt}${comp ? ` para el equipo (${comp} es de un componente)` : ""}; solicitaste ${wantTxt}`,
      en: `This listing states ${gotTxt}${comp ? ` for the equipment (${comp} is for a component)` : ""}; you asked for ${wantTxt}`,
    };
  const others = options.filter((v) => !wanted.includes(v) && !want.ranges.some(([a, b]) => v >= a && v <= b));
  // «220 o 380 V»: the client hasn't decided; the uncertainty stays (never a match on its own)
  if (wanted.length > 1 && !want.ranges.length)
    return { verdict: "confirm", es: `Indica ${gotTxt}; mencionaste ${wantTxt}: confirma qué voltaje necesitas`, en: `States ${gotTxt}; you mentioned ${wantTxt}: confirm which voltage you need` };
  if (!others.length) return { verdict: "match", es: `Indica la alimentación pedida: ${wantTxt}`, en: `States the requested power supply: ${wantTxt}` };
  if (wide.length || VARIANT.test(eq.text))
    return { verdict: "confirm", es: `Confirma que te coticen la variante de ${wantTxt} (el título ofrece ${gotTxt})`, en: `Confirm they quote the ${wantTxt} variant (the title offers ${gotTxt})` };
  return {
    verdict: "confirm",
    es: `Voltaje del equipo por confirmar: el título indica ${gotTxt} sin decir a qué corresponde cada cifra; pediste ${wantTxt}`,
    en: `Equipment voltage to confirm: the title states ${gotTxt} without saying what each figure refers to; you asked for ${wantTxt}`,
  };
}
