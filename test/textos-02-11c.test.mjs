// 02-11c — textos del servidor que ve el cliente o el equipo: las insignias son de la plataforma, SEAL
// no verifica proveedores, y no se usan «calificado», «mejor proveedor» ni «verificado» como aval.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { scoreSuppliers, categorizeSuppliers } from "../src/services/scoring.js";

test("motivos y detalles del índice: insignias de la plataforma, valoración (no «calificación»), sin «proveedor verificado»", () => {
  const scored = scoreSuppliers([
    { name: "A", verifiedSupplier: true, goldSupplier: true, yearsInBusiness: 8, rating: 4.8, reviews: 30, price: 10, moq: 1 },
    { name: "B", price: 5, moq: 1 },
    { name: "C", goldSupplier: true, yearsInBusiness: 6, rating: 3.2, reviews: 40, price: 7, moq: 1 },
  ]);
  const a = scored.find((s) => s.name === "A");
  assert.equal(a.trustBreakdown[0].detail, "Insignia de la plataforma: Verified Supplier (auditoría de un tercero, no de SEAL)");
  const out = categorizeSuppliers(scored);
  const reasons = Object.fromEntries(out.filteredOut.map((f) => [f.name, f.reason]));
  assert.equal(reasons.B, "Sin insignias de la plataforma (ni Verified Supplier ni miembro Gold)");
  assert.match(reasons.C, /^Valoración 3\.2 por debajo de 4\.0$/);
  const all = JSON.stringify(out);
  assert.doesNotMatch(all, /proveedor verificado|calificad|mejor proveedor/i);
});

test("correos al equipo y al cliente: sin «calificados», «mejor proveedor», «costo total» ni «garantiza» afirmativos", () => {
  const src = fs.readFileSync("src/services/email.js", "utf8");
  for (const re of [/Proveedores calificados/, /Mejor proveedor/, /Costo total estimado/, /garantizamos/i]) assert.doesNotMatch(src, re);
});
