// TEST FIXTURE: replaces services/alibaba.js with fictitious [PRUEBA] listings (no network).
const mk = (i, o) => ({
  id: i,
  itemId: "fx" + i,
  name: o.name,
  productName: o.title,
  productImage: "",
  images: [],
  rating: o.rating ?? null,
  reviews: o.reviews ?? 0,
  moq: o.moq ?? 1,
  moqText: `${o.moq ?? 1} ${o.unit || "pieces"}`,
  saleUnit: o.unit || "pieces",
  price: o.price,
  priceRange: `$${o.price}`,
  verified: !!o.gold,
  location: "CN",
  yearsInBusiness: o.years || 0,
  responseRate: null,
  tags: [],
  storeRating: o.store ?? null,
  certifications: o.certs || [],
  badges: o.verifiedBadge ? ["Verified"] : [],
  verifiedSupplier: o.verifiedBadge ? true : null,
  tradeAssurance: null,
  goldSupplier: !!o.gold,
  contactEmail: "",
  contactPhone: "",
  productUrl: `https://example.invalid/p/${i}`,
  storeUrl: `https://example.invalid/s/${i}`,
  relevance: o.rel ?? 0.9,
});
export async function searchSuppliers({ keyword, relevanceKeyword }) {
  // 02-11s: STUB_KW_LOG records what the platform was asked; STUB_OFFERS = JSON array of listing titles
  if (process.env.STUB_KW_LOG) (await import("node:fs")).appendFileSync(process.env.STUB_KW_LOG, JSON.stringify({ keyword, relevanceKeyword }) + "\n");
  if (process.env.STUB_OFFERS) {
    const titles = JSON.parse(process.env.STUB_OFFERS);
    const r = titles.map((title, i) => mk(i + 1, { name: `[PRUEBA] Proveedor ficticio ${i + 1}`, title, price: 100 + i * 10, moq: 1, unit: "pieces", gold: true, years: 6, verifiedBadge: true, rating: 4.6, reviews: 20, store: 4.5 }));
    r.offerCount = r.length;
    return r;
  }
  if (/vac[ií]o|nothingfound/i.test(keyword)) {
    const r = [];
    r.offerCount = 0;
    return r;
  }
  const list = [
    mk(1, {
      name: "[PRUEBA] Ficticia Compresores Co., Ltd.",
      title: `${keyword} 500L oil free`,
      price: 1250.5,
      moq: 1,
      unit: "sets",
      gold: true,
      years: 8,
      verifiedBadge: true,
      rating: 4.8,
      reviews: 30,
      store: 4.7,
      certs: ["CE"],
    }),
    mk(2, { name: "[PRUEBA] Demo Industrial Machinery", title: `${keyword} screw type`, price: 980, moq: 2, unit: "sets", gold: true, years: 5, rating: 4.5, reviews: 12 }),
    mk(3, { name: "[PRUEBA] Ejemplo Air Tech", title: `${keyword} 220v`, price: 1499.99, moq: 1, unit: "units", gold: true, years: 4, store: 4.2 }),
    mk(4, { name: "[PRUEBA] Sin Insignia Trading", title: `${keyword}`, price: 700, moq: 1, unit: "pieces" }),
  ];
  list.offerCount = list.length;
  return list;
}

// 02-11s: the real module exports the route of the last search (for /health)
export const searchRoute = { last: "stub", lastAt: null, unblocker: "stub" };
