import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { app, HOUR, merchant } from "./helpers.ts";

const { setGameData } = await import("../src/gamedata.ts");
const { suggestedValue } = await import("../src/value.ts");
const { ingest } = app.collector;

setGameData({
  version: 1,
  multipliers: { buy_to_sell: 0.6 },
  items: {
    t_val: { name: "Val", type: "weapon", g: 100, upgrade: {}, grades: [9, 10, 11, 12] },
    t_old: { name: "Old", type: "material", g: 10 },
    scroll0: { g: 10 },
  },
  upgrades: { 0: { 1: 0.5, 2: 0.5, 3: 0.5 } },
  npcs: { scrolls: { name: "Scrolls", items: ["scroll0"] } },
  maps: { main: { npcs: [{ id: "scrolls", position: [0, 0] }] } },
});

const now = Date.now();
const t0 = now - 5 * HOUR;
const keep = { trade9: { name: "t_keep_v", price: 1 } };
const stands = (t: number, sold: boolean) => [
  merchant("ValA", t, {
    ...keep,
    trade1: { name: "t_val", price: 1000 },
    ...(sold ? {} : { trade2: { name: "t_val", level: 1, price: 3000 } }),
  }),
  merchant("ValB", t, { ...keep, trade1: { name: "t_val", price: 1200 }, trade2: { name: "t_val", level: 2, price: 50, b: true } }),
  merchant("Mine", t, { ...keep, trade1: { name: "t_val", price: 900 } }),
];
ingest(stands(t0, false), t0);
ingest(stands(t0 + HOUR, true), t0 + HOUR); // +1 at 3000 vanishes...
ingest(stands(now - HOUR, true), now - HOUR); // ...and is confirmed sold

const value = (level: number, exclude?: string) => suggestedValue("t_val", level, "", "ALL", exclude);

describe("suggested value", () => {
  test("the cheapest competing ask, leaving out the seller's own listings", () => {
    assert.deepEqual([value(0).basis, value(0).suggested], ["asks", 900]);
    const v = value(0, "mine");
    assert.deepEqual([v.basis, v.suggested, v.asks?.sellers], ["asks", 1000, 2]);
  });

  test("with nothing listed, recent sales", () => {
    const v = value(1);
    assert.deepEqual([v.basis, v.suggested, v.sales?.count], ["sales", 3000, 1]);
  });

  test("with no market at all, the cost to make", () => {
    const v = value(3);
    assert.equal(v.basis, "cost_to_make");
    assert.equal(v.suggested, Math.round(v.costToMake!.expected));
    assert.ok(v.suggested > 900);
  });

  test("never below what a buy order pays", () => {
    const v = value(2);
    assert.equal(v.bestBid, 50);
    assert.equal(v.basis, "cost_to_make", "a 50 bid is no asking price, and under the cost to make");
    assert.equal(v.suggested, 3660); // ((900 + 10) / 0.5 + 10) / 0.5
  });

  test("asks above the cost to make are capped at it", () => {
    ingest([...stands(now, true), merchant("Greedy", now, { ...keep, trade1: { name: "t_val", level: 3, price: 1e6 } })], now);
    const v = value(3);
    assert.deepEqual([v.basis, v.suggested, v.asks?.lowest], ["cost_to_make", 7340, 1e6]);
  });

  test("sales from long ago guide the price when nothing is listed; fresh ones beat higher asks", () => {
    const DAY = 24 * HOUR;
    // Sold at 500 sixty days ago (listed, vanished, confirmed), and nothing listed since.
    const old = now - 60 * DAY;
    const shop = (t: number, slots: object) => merchant("OldShop", t, { ...keep, ...slots });
    ingest([shop(old, { trade1: { name: "t_old", price: 500 } })], old);
    ingest([shop(old + HOUR, {})], old + HOUR);
    ingest([shop(old + 4 * HOUR, {})], old + 4 * HOUR);
    const v = suggestedValue("t_old", 0, "", "ALL");
    assert.deepEqual([v.basis, v.suggested, v.sales?.lastAt], ["sales", 500, old + HOUR]);

    // This week it sold at 400 and someone now asks 900: asks above what it sells for aren't the guide.
    const recent = now - 2 * DAY;
    ingest([shop(recent, { trade1: { name: "t_old", price: 400 } })], recent);
    ingest([shop(recent + HOUR, {})], recent + HOUR);
    ingest([shop(now, {}), merchant("Asker", now, { ...keep, trade1: { name: "t_old", price: 900 } })], now);
    const w = suggestedValue("t_old", 0, "", "ALL");
    assert.equal(w.asks?.lowest, 900);
    assert.deepEqual([w.basis, w.suggested, w.sales?.count], ["sales", 450, 2]); // median of 400 and 500
  });
});
