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
});
