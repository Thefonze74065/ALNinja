import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { app, HOUR, merchant } from "./helpers.ts";

const { ingest } = app.collector;
const { deals, dealOptions, snapshot } = app.market;
const { setGameData, npcSellValue, npcShopPrice } = await import("../src/gamedata.ts");

setGameData({
  version: 1,
  multipliers: { buy_to_sell: 0.6 },
  items: {
    t_npc: { name: "NPC Bait", type: "material", g: 1000 },
    t_cash: { name: "Cash Item", type: "misc", g: 1000, cash: 1 },
    t_ring: { name: "Ring", type: "ring", g: 1000, compound: {}, grades: [2, 3] },
    t_bow: { name: "Bow", type: "weapon", g: 1000, upgrade: {} },
    t_shop: { name: "Shop Scroll", type: "uscroll", g: 1000 },
    t_cashshop: { name: "Cash Shop Item", type: "misc", g: 50, cash: 1 },
    t_retired: { name: "Retired Shop Item", type: "misc", g: 10 },
    scroll0: { g: 1000 }, scroll1: { g: 40000 }, scroll2: { g: 1600000 },
    cscroll0: { g: 6400 }, cscroll1: { g: 240000 }, cscroll2: { g: 9200000 },
  },
  npcs: {
    shopkeeper: { name: "Lucas", items: ["t_shop", "t_cashshop", null] },
    oldkeeper: { name: "Old", items: ["t_retired"] },
  },
  maps: {
    main: { npcs: [{ id: "shopkeeper", position: [-464, -96] }] },
    old_main: { ignore: true, npcs: [{ id: "oldkeeper", position: [0, 0] }] },
  },
});

const all = (overrides: Record<string, string> = {}) => dealOptions((name) => overrides[name]);
const now = Date.now();

describe("npcSellValue", () => {
  test("base, cash, gift and temporary items", () => {
    assert.equal(npcSellValue("t_npc", 0), 600);
    assert.equal(npcSellValue("t_cash", 0), 1000);
    assert.equal(npcSellValue("t_npc", 0, "gift"), 1);
    assert.equal(npcSellValue("t_npc", 0, "expires"), 75);
    assert.equal(npcSellValue("t_unknown", 0), 0);
  });

  test("levels multiply value and add scroll costs", () => {
    // compound +1: 600 * 3.2 + 6400 / 2.4
    assert.equal(npcSellValue("t_ring", 1), Math.round(600 * 3.2 + 6400 / 2.4));
    // upgrade +1: 600 + 1000 / 2
    assert.equal(npcSellValue("t_bow", 1), 1100);
  });
});

describe("deals", () => {
  test("npc: NPC pays more than the ask, but not for gifted items", () => {
    ingest([
      merchant("NpcA", now, { trade1: { name: "t_npc", price: 500, q: 4 }, trade2: { name: "t_npc", price: 400, gift: 1 } }),
    ], now);
    const found = deals("ALL", all({ kind: "npc" }));
    assert.equal(found.length, 1);
    assert.equal(found[0].profitPerUnit, 100);
    assert.equal(found[0].totalProfit, 400);
    assert.equal(found[0].seller.merchant, "NpcA");
  });

  test("identical listings from one merchant merge into one deal", () => {
    ingest([
      merchant("NpcB", now, { trade1: { name: "t_npc", price: 300 }, trade2: { name: "t_npc", price: 300 }, trade3: { name: "t_npc", price: 300 } }),
    ], now);
    const found = deals("ALL", all({ kind: "npc" })).filter((d) => d.seller.merchant === "NpcB");
    assert.deepEqual(found.map((d) => [d.quantity, d.totalProfit]), [[3, 900]]);
  });

  test("underpriced: compared with the cheapest competing ask, needs enough sellers", () => {
    ingest([
      ...["U1", "U2", "U3", "U4"].map((id) => merchant(id, now, { trade1: { name: "t_under", price: 100 } })),
      merchant("Cheap", now, { trade1: { name: "t_under", price: 50 } }),
    ], now);
    const found = deals("ALL", all({ kind: "underpriced" }));
    assert.equal(found.length, 1);
    assert.equal(found[0].seller.merchant, "Cheap");
    assert.equal(found[0].reference, 100);
    assert.equal(found[0].discount, 0.5);
    assert.equal(deals("ALL", all({ kind: "underpriced", min_sellers: "6" })).length, 0);
    assert.equal(deals("ALL", all({ kind: "underpriced", min_discount: "0.6" })).length, 0);
  });

  test("underpriced: the reference is the next-cheapest other merchant, not the median", () => {
    ingest([
      merchant("Spread1", now, { trade1: { name: "t_spread", price: 50 }, trade2: { name: "t_spread", price: 60 } }),
      merchant("Spread2", now, { trade1: { name: "t_spread", price: 70 } }),
      merchant("Spread3", now, { trade1: { name: "t_spread", price: 200 } }),
      merchant("Spread4", now, { trade1: { name: "t_spread", price: 200 } }),
    ], now);
    const found = deals("ALL", all({ kind: "underpriced" })).filter((d) => d.item === "t_spread");
    // Spread1's own 60 doesn't count as competition; 70 does.
    assert.deepEqual(found.map((d) => [d.price, d.reference]), [[50, 70]]);
    assert.equal(found[0].sellers, 4);
  });

  test("flip: a bid above someone else's ask, sized to the smaller side", () => {
    ingest([
      merchant("FlipSeller", now, { trade1: { name: "t_flip", price: 100, q: 5 }, trade2: { name: "t_flip", price: 500, b: true } }),
      merchant("FlipBuyer", now, { trade1: { name: "t_flip", price: 150, b: true, q: 2 } }),
    ], now);
    const [flip, ...rest] = deals("ALL", all({ kind: "flip" }));
    assert.equal(rest.length, 0, "the seller's own bid doesn't count");
    assert.equal(flip.buyer?.merchant, "FlipBuyer");
    assert.equal(flip.quantity, 2);
    assert.equal(flip.totalProfit, 100);
  });

  test("region filter limits both sides", () => {
    ingest([
      merchant("EuSeller", now, { trade1: { name: "t_rflip", price: 100 } }, "EU"),
      merchant("UsBuyer", now, { trade1: { name: "t_rflip", price: 150, b: true } }, "US"),
    ], now);
    assert.equal(deals("ALL", all({ kind: "flip" })).filter((d) => d.item === "t_rflip").length, 1);
    assert.equal(deals("EU", all({ kind: "flip" })).filter((d) => d.item === "t_rflip").length, 0);
  });

  test("options are clamped", () => {
    const o = all({ kind: "bogus,npc", min_discount: "5", limit: "100000" });
    assert.deepEqual(o.kinds, ["npc"]);
    assert.equal(o.minDiscount, 0.99);
    assert.equal(o.limit, 500);
  });
});

describe("price changes", () => {
  test("24h change needs two sellers at both ends", () => {
    const then = now - 24.5 * HOUR;
    const two = (t: number, price: number) => [
      merchant("Ch1", t, { trade1: { name: "t_change", price }, trade2: { name: "t_solo", price } }),
      merchant("Ch2", t, { trade1: { name: "t_change", price } }),
    ];
    ingest(two(then, 100), then);
    ingest(two(now, 120), now);
    const rows = snapshot("ALL");
    const change = rows.find((r) => r.item === "t_change")!;
    assert.ok(Math.abs(change.change24h! - 0.2) < 1e-9);
    assert.equal(rows.find((r) => r.item === "t_solo")!.change24h, null);
    assert.equal(change.change7d, null, "no 7-day history yet");
  });
});

describe("NPC shop prices", () => {
  test("only plain +0 items sold for gold on active maps", () => {
    assert.equal(npcShopPrice("t_shop", 0, ""), 1000);
    assert.equal(npcShopPrice("t_shop", 1, ""), null);
    assert.equal(npcShopPrice("t_shop", 0, "shiny"), null);
    assert.equal(npcShopPrice("t_cashshop", 0, ""), null);
    assert.equal(npcShopPrice("t_retired", 0, ""), null);
  });

  test("headline price is capped at the shop price; raw asks are kept", () => {
    ingest([
      merchant("ShopA", now, { trade1: { name: "t_shop", price: 5000 } }),
      merchant("ShopB", now, { trade1: { name: "t_shop", price: 6000 } }),
    ], now);
    const row = snapshot("ALL").find((r) => r.item === "t_shop")!;
    assert.equal(row.price, 1000);
    assert.equal(row.npcPrice, 1000);
    assert.equal(row.lowest, 5000);
  });

  test("a cheap ask is not 'below market' when a shop sells for less (upgrade scroll case)", () => {
    ingest([
      merchant("ScrollCheap", now, { trade1: { name: "t_shop", price: 2000, q: 30 } }),
      ...["S1", "S2", "S3"].map((id) => merchant(id, now, { trade1: { name: "t_shop", price: 1_200_000 } })),
    ], now);
    assert.equal(deals("ALL", all({ kind: "underpriced" })).filter((d) => d.item === "t_shop").length, 0);
  });

  test("a listing under the shop price is still a deal, valued at the shop price", () => {
    ingest([
      merchant("ScrollDeal", now, { trade1: { name: "t_shop", price: 500 } }),
      ...["S1", "S2", "S3"].map((id) => merchant(id, now, { trade1: { name: "t_shop", price: 1_200_000 } })),
    ], now);
    const [d] = deals("ALL", all({ kind: "underpriced" })).filter((d) => d.item === "t_shop");
    assert.equal(d.reference, 1000);
    assert.equal(d.totalProfit, 500);
  });

  test("bids above the shop price are flips sourced from the shop; dearer merchant asks are skipped", () => {
    ingest([
      merchant("ShopBuyer", now, { trade1: { name: "t_shop", price: 1500, b: true, q: 3 } }),
      merchant("Pricey", now, { trade1: { name: "t_shop", price: 1200 } }),
    ], now);
    const flips = deals("ALL", all({ kind: "flip" })).filter((d) => d.item === "t_shop");
    assert.equal(flips.length, 1);
    assert.equal(flips[0].source, "npc");
    assert.equal(flips[0].seller.merchant, "Lucas");
    assert.equal(flips[0].seller.map, "main");
    assert.equal(flips[0].totalProfit, 1500);
  });

  test("asks above the shop price can't fake a price move", () => {
    const then = now - 24.5 * HOUR;
    const asks = (t: number, price: number) =>
      ["Mv1", "Mv2"].map((id) => merchant(id, t, { trade1: { name: "t_shop", price } }));
    ingest(asks(then, 5000), then);
    ingest(asks(now, 8000), now);
    assert.equal(snapshot("ALL").find((r) => r.item === "t_shop")!.change24h, 0);
  });

  test("a far-above-shop listing disappearing is a withdrawal, not a sale", () => {
    const keep = { trade9: { name: "t_keep_shop", price: 1 } };
    ingest([merchant("Hoarder", now, { ...keep, trade1: { name: "t_shop", price: 50_000 } })], now);
    ingest([merchant("Hoarder", now + 60_000, keep)], now + 60_000);
    const l = app.db.db.prepare("SELECT close_reason FROM listings WHERE merchant = 'Hoarder' AND item = 't_shop'").get() as any;
    assert.equal(l.close_reason, "withdrawn");
  });
});

describe("velocity", () => {
  test("trades land on whole hours / days of the viewer's clock", () => {
    const t = now - 3 * HOUR;
    ingest([merchant("VelA", t, { trade1: { name: "t_vel", price: 100, q: 10 } })], t);
    ingest([merchant("VelA", t + HOUR, { trade1: { name: "t_vel", price: 100, q: 6 } })], t + HOUR);
    const DAY = 24 * HOUR;
    const [daily] = app.market.velocity("t_vel", "ALL", 7);
    assert.equal(daily.bucket, "day");
    assert.equal(daily.trades[0].t % DAY, 0);
    assert.equal(daily.trades[0].sold, 4);
    const [hourly] = app.market.velocity("t_vel", "ALL", 1);
    assert.equal(hourly.bucket, "hour");
    assert.equal(hourly.trades[0].t, Math.floor((t + HOUR) / HOUR) * HOUR);
    // On the viewer's clock: a UTC-7 day starts at 07:00 UTC, a UTC+5:30 hour at half past.
    const [pacific] = app.market.velocity("t_vel", "ALL", 7, -7 * HOUR);
    assert.equal(pacific.trades[0].t % DAY, 7 * HOUR);
    assert.equal(pacific.trades.reduce((a, d) => a + d.sold, 0), 4);
    const [india] = app.market.velocity("t_vel", "ALL", 1, 5.5 * HOUR);
    assert.equal(india.trades[0].t % HOUR, HOUR / 2);
  });
});
