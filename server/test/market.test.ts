import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { app, HOUR, merchant } from "./helpers.ts";

const { ingest } = app.collector;
const { deals, dealOptions, snapshot } = app.market;
const { setGameData, npcSellValue } = await import("../src/gamedata.ts");

setGameData({
  version: 1,
  multipliers: { buy_to_sell: 0.6 },
  items: {
    t_npc: { name: "NPC Bait", type: "material", g: 1000 },
    t_cash: { name: "Cash Item", type: "misc", g: 1000, cash: 1 },
    t_ring: { name: "Ring", type: "ring", g: 1000, compound: {}, grades: [2, 3] },
    t_bow: { name: "Bow", type: "weapon", g: 1000, upgrade: {} },
    scroll0: { g: 1000 }, scroll1: { g: 40000 }, scroll2: { g: 1600000 },
    cscroll0: { g: 6400 }, cscroll1: { g: 240000 }, cscroll2: { g: 9200000 },
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
