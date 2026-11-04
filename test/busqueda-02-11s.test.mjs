// 02-11s — Ruta de búsqueda en un entorno aislado (axios simulado; nada sale a la red): el Web Unblocker con
// credenciales rechazadas (401) no se reintenta en cada búsqueda, el respaldo (Scraper API) responde, la ruta
// que respondió queda registrada y un fallo total devuelve una lista vacía sin colgarse.
import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import axios from "axios";

process.env.OXY_UNBLOCK_USER = "u-ficticio";
process.env.OXY_UNBLOCK_PASS = "p-ficticio";
process.env.OXY_USER = "s-ficticio";
process.env.OXY_PASS = "s-ficticio";
process.env.SEARCH_BUDGET_MS = "60000";
const { searchSuppliers, searchRoute } = await import("../src/services/alibaba.js");

const offers = [
  { title: "Disposable nitrile gloves latex free", companyName: "Ficticia Gloves Co", productId: 1, price: "$0.02-0.03", moq: "10000 pieces", goldSupplierYears: "5 yrs", badges: [{ name: "Verified" }] },
  { title: "Latex disposable gloves", companyName: "Otra Ficticia", productId: 2, price: "$0.02", moq: "10000 pieces", goldSupplierYears: "4 yrs" },
];
const page = `<html><script>window.__page__data_sse10._offer_list = ${JSON.stringify({ offerResultData: { offers } })};</script>${" ".repeat(210000)}</html>`;
let gets = 0;
let posts = 0;
beforeEach(() => {
  gets = 0;
  posts = 0;
  mock.restoreAll();
});
const reject401 = () => mock.method(axios, "get", async () => {
  gets++;
  throw Object.assign(new Error("Request failed with status code 401"), { response: { status: 401 } });
});

test("1 · Unblocker 401 → respaldo responde en la misma búsqueda, sin reintentos ni esperas", async () => {
  reject401();
  mock.method(axios, "post", async () => (posts++, { data: { results: [{ content: page }] } }));
  const t0 = Date.now();
  const r = await searchSuppliers({ keyword: "disposable gloves latex free", relevanceKeyword: "disposable gloves" });
  assert.equal(gets, 1, "un solo intento al Unblocker");
  assert.equal(posts, 1);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  assert.equal(r.offerCount, 2);
  assert.equal(searchRoute.last, "scraper_api:universal_ecommerce");
  assert.equal(searchRoute.unblocker, "rejected_401");
});

test("2 · la búsqueda siguiente ya no intenta el Unblocker rechazado", async () => {
  reject401();
  mock.method(axios, "post", async () => (posts++, { data: { results: [{ content: page }] } }));
  await searchSuppliers({ keyword: "disposable gloves latex free", relevanceKeyword: "disposable gloves" });
  assert.equal(gets, 0);
  assert.equal(posts, 1);
});

test("3 · fallo total del proveedor: lista vacía, sin excepción", async () => {
  reject401();
  mock.method(axios, "post", async () => {
    posts++;
    throw Object.assign(new Error("Request failed with status code 503"), { response: { status: 503, data: { error: "unavailable" } } });
  });
  const r = await searchSuppliers({ keyword: "screw air compressor 220v", budgetMs: 15000 });
  assert.deepEqual([...r], []);
  assert.ok(posts >= 1);
});
