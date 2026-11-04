// 02-11u — La página nueva de resultados de la plataforma ya no trae el JSON de hidratación (registro de
// producción del 2026-11-04: «Hydration marker not found»). Se leen las tarjetas que vienen en el HTML.
// Ficha ficticia con la estructura observada; nada sale a la red.
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import axios from "axios";

process.env.OXY_UNBLOCK_DISABLED = "1";
process.env.OXY_USER = "s-ficticio";
process.env.OXY_PASS = "s-ficticio";
const { extractOffersFromCards, searchSuppliers, searchRoute } = await import("../src/services/alibaba.js");
const cards = fs.readFileSync(new URL("./fixtures/alibaba-cards-2026-11.html", import.meta.url), "utf8");

test("1 · cada tarjeta: título, proveedor, precio en US$, pedido mínimo, años, valoración e insignia Verified", () => {
  const o = extractOffersFromCards(cards).offerResultData.offers;
  assert.equal(o.length, 4);
  assert.deepEqual(
    { title: o[0].title, company: o[0].companyName, price: o[0].price, moq: o[0].moq, years: o[0].goldSupplierYears, rating: o[0].reviewScore, reviews: o[0].reviewCount, badges: o[0].badges, url: o[0].productUrl },
    { title: "[PRUEBA] Industrial screw air compressor 380 V, control panel 220 V, 22kW", company: "[PRUEBA] Ficticia Compresores Co., Ltd.", price: "US$ 2,800.00-3,100.00", moq: "1 set", years: "6 yrs", rating: "4.7", reviews: "21", badges: [{ name: "Verified" }], url: "//www.alibaba.com/product-detail/Ficticio-Screw-Compressor_1600000000001.html" },
  );
  assert.deepEqual(o[2].badges, [], "sin la imagen Verified no se inventa la insignia");
  assert.equal(o[2].reviewScore, "");
  assert.equal(o[3].price, "", "un precio en quetzales de una página localizada no se lee como dólares");
});

test("2 · recorrido: Scraper API → tarjetas → proveedores, con la ruta y el lector registrados", async () => {
  const page = `${cards}<!-- ${" ".repeat(210000)} -->`;
  mock.method(axios, "post", async () => ({ data: { results: [{ content: page }] } }));
  const r = await searchSuppliers({ keyword: "screw air compressor 220v", relevanceKeyword: "screw air compressor" });
  mock.restoreAll();
  assert.equal(r.offerCount, 4);
  // the Spanish title (localized page) does not match the English keyword: left out by relevance, as before
  assert.deepEqual(r.map((s) => s.itemId).sort(), ["1600000000001", "1600000000002", "1600000000003"]);
  const v = r.find((s) => s.itemId === "1600000000002");
  assert.deepEqual([v.price, v.moq, v.saleUnit, v.verifiedSupplier, v.goldSupplier, v.yearsInBusiness, v.rating, v.reviews], [1450, 2, "piece", true, true, 4, 4.9, 8]);
  assert.equal(searchRoute.last, "scraper_api:universal_ecommerce");
  assert.equal(searchRoute.parser, "result_cards");
});

test("3 · una página sin tarjetas ni JSON sigue dando lista vacía (no se inventa nada)", () => {
  assert.equal(extractOffersFromCards("<html><body><a href='/x'>nada</a></body></html>"), null);
});

// 02-11v — los números del TÍTULO no se leen como datos del proveedor
const trampa = fs.readFileSync(new URL("./fixtures/alibaba-cards-titulo-trampa.html", import.meta.url), "utf8");

test("4 · «2 years warranty», «5/5» y «$99» del título no son años, valoración ni precio", () => {
  const o = extractOffersFromCards(trampa).offerResultData.offers;
  assert.equal(o.length, 2);
  assert.equal(o[0].title, "[PRUEBA] Screw air compressor 2 years warranty 5/5 star quality $99 parts free");
  assert.deepEqual([o[0].goldSupplierYears, o[0].reviewScore, o[0].reviewCount, o[0].price, o[0].companyName],
    ["8 yrs", "", "", "US$1,200.00", "[PRUEBA] Trampa Compresores Co., Ltd."]);
  // sin bloque de años del proveedor y con precio en quetzales: todo queda vacío, nada sale del título
  assert.deepEqual([o[1].goldSupplierYears, o[1].reviewScore, o[1].price], ["", "", ""]);
});

test("5 · sin JSON ni tarjetas, /health no se queda con el lector de la búsqueda anterior", async () => {
  searchRoute.parser = "result_cards";
  const page = `<html><body><p>sin resultados</p></body></html><!-- ${" ".repeat(210000)} -->`;
  mock.method(axios, "post", async () => ({ data: { results: [{ content: page }] } }));
  const r = await searchSuppliers({ keyword: "screw air compressor 220v", relevanceKeyword: "screw air compressor" });
  mock.restoreAll();
  assert.equal(r.length, 0);
  assert.equal(searchRoute.parser, "none");
});
