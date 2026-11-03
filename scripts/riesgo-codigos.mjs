// 02-11n — Riesgo de adivinar un código de verificación (fuerza bruta distribuida), calculado con los
// parámetros REALES del código (services/verifyStore.js). Uso: node scripts/riesgo-codigos.mjs
//
// Modelo (atacante óptimo):
//   N  = alfabeto^longitud                       combinaciones posibles
//   V  = códigos vigentes a la vez para un buzón  ≤ maxCodesPerHour (el atacante los pide todos juntos al
//        inicio de cada hora; cada uno vale codeMinutes ≥ el tiempo que necesita para gastar sus intentos)
//   g  = intentos por IP y hora                    failsPerIpHour (cada IP puede gastarlos dentro de la
//        ventana en que los V códigos están vigentes)
//   K  = conexiones distintas (IPv4, o /64 en IPv6) que controla el atacante
//   H  = horas de ataque sostenido
// Cada intento acierta con probabilidad ≤ V/N. Con G = g·K·H intentos:
//   cota conservadora  P ≤ 1 − (1 − V/N)^G ≈ G·V/N
// Probabilidad «esperada» si el atacante NO concentra los pedidos (los reparte en la hora): en promedio
// hay V_prom = maxCodesPerHour·codeMinutes/60 códigos vigentes, y P ≈ G·V_prom/N.
// Son estimaciones de un modelo, no garantías: no cubren fallas de implementación ni robo del buzón.
import { codeRiskParams } from "../src/services/verifyStore.js";

export function risk({ alphabet, length, codeMinutes, maxCodesPerHour, failsPerIpHour }, K, hours) {
  const N = alphabet ** length;
  const G = failsPerIpHour * K * hours;
  const Vmax = maxCodesPerHour; // all valid at once (worst case)
  const Vavg = Math.min(maxCodesPerHour, (maxCodesPerHour * codeMinutes) / 60);
  // 1 − (1 − p)^G, stable for tiny p
  const atLeastOne = (p) => -Math.expm1(G * Math.log1p(-p));
  return { N, G, bound: atLeastOne(Vmax / N), expected: atLeastOne(Vavg / N) };
}
export const fmt = (p) => (p < 1e-12 ? "<1e-12" : p.toExponential(2));

if (import.meta.url === `file://${process.argv[1]}`) {
  const P = codeRiskParams({});
  console.log("Parámetros:", JSON.stringify(P));
  for (const len of [8, P.length]) {
    for (const K of [1_000, 10_000, 100_000]) {
      const r = risk({ ...P, length: len }, K, 24 * 365);
      console.log(`longitud ${len} · K=${K} IP · 1 año: N=${r.N.toExponential(3)} G=${r.G.toExponential(2)} cota=${fmt(r.bound)} esperada=${fmt(r.expected)}`);
    }
  }
}
