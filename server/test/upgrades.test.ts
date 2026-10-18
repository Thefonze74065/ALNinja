import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { app, merchant } from "./helpers.ts";

const { setGameData } = await import("../src/gamedata.ts");
const { upgradeCosts: costsFrom, itemGrade } = await import("../src/upgrades.ts");
const { deals, dealOptions, snapshot } = app.market;
const upgradeCosts = (item: string, region: string) => costsFrom(item, region, snapshot(region));

setGameData({
  version: 1,
  items: {
    t_star: { name: "Star", type: "weapon", g: 100, upgrade: {}, grades: [2, 3, 10, 12] },
    t_belt: { name: "Belt", type: "belt", g: 100, compound: {}, grades: [1, 5, 6, 7] },
    t_rare: { name: "Rare", type: "weapon", g: 100, upgrade: {}, grades: [0, 0, 10, 12] },
    t_plain: { name: "Plain", type: "material", g: 100 },
    scroll0: { g: 10 }, scroll1: { g: 40000 }, scroll2: { g: 1600000 }, cscroll0: { g: 5 },
  },
  upgrades: {
    0: { 1: 0.5, 2: 0.5, 3: 0.25, 4: 0.1 },
    1: { 1: 0.4 },
    2: { 1: 0.3 },
  },
  compounds: { 0: { 1: 0.5, 2: 0.5, 3: 0.5 }, 1: { 4: 0.25 } },
  npcs: { scrolls: { name: "Scrolls", items: ["scroll0", "cscroll0"] } },
  maps: { main: { npcs: [{ id: "scrolls", position: [0, 0] }] } },
});

const now = Date.now();
app.collector.ingest([merchant("UpgShop", now, {
  trade1: { name: "t_star", price: 100 },
  trade2: { name: "t_star", level: 3, price: 1000 },
  trade3: { name: "scroll1", price: 200 },
  trade4: { name: "scroll2", price: 50 },
  trade5: { name: "t_belt", price: 10 },
  trade6: { name: "t_star", level: 4, price: 5000 },
}), merchant("UpgShop2", now, {
  trade1: { name: "t_star", level: 3, price: 1200 },
  trade2: { name: "t_star", level: 4, price: 30000 },
})], now);

describe("upgrade costs", () => {
  test("item grade follows the game's calculate_item_grade", () => {
    const def = { upgradeable: true, compoundable: false, grades: [2, 3, 10, 12] };
    assert.deepEqual([0, 1, 2, 3, 9, 10, 12].map((l) => itemGrade(def, l)), [0, 0, 1, 2, 2, 3, 4]);
    assert.equal(itemGrade({ upgradeable: false, compoundable: false }, 5), 0);
  });

  test("expected cost compounds failures, and the cheapest route buys a lower level when that's cheaper", () => {
    const c = upgradeCosts("t_star", "ALL")!;
    assert.equal(c.kind, "upgrade");
    assert.equal(c.base.price, 100);
    const [l1, l2, l3, l4] = c.steps;
    assert.deepEqual([l1.scroll, l1.scrollPrice, l1.fromBase], ["scroll0", 10, 220]); // (100 + 10) / 0.5, shop scroll
    assert.equal(l2.fromBase, 460);
    assert.deepEqual([l3.scroll, l3.scrollPrice, l3.fromBase], ["scroll1", 200, 2640]); // grade 1 at +2: market scroll
    assert.deepEqual([l3.market, l3.cheapest, l3.buyAt], [1000, 1000, 3]);
    assert.deepEqual([l3.made, l3.madeFrom], [2640, 0]);
    assert.deepEqual([l4.scroll, l4.fromBase, l4.made, l4.madeFrom], ["scroll2", 26900, 10500, 3]); // (1000 + 50) / 0.1
    assert.deepEqual([l4.market, l4.cheapest, l4.buyAt], [5000, 5000, 4]);
    assert.equal(l4.baseCopies, 1 / (0.5 * 0.5 * 0.25 * 0.1));
    assert.equal(c.steps.length, 4, "stops where the game has no chance for the next level");
  });

  test("compounding takes three copies, and from +3 uses the grade two levels down", () => {
    const c = upgradeCosts("t_belt", "ALL")!;
    assert.equal(c.kind, "compound");
    assert.deepEqual([c.steps[0].scroll, c.steps[0].fromBase, c.steps[0].baseCopies], ["cscroll0", 70, 6]);
    assert.equal(c.steps[3].chance, 0.25);
    assert.equal(c.steps[3].scroll, "cscroll1");
    assert.equal(c.steps[3].fromBase, null, "no cscroll1 price");
  });

  test("items that start high grade use that grade's table; plain items have none", () => {
    assert.equal(upgradeCosts("t_rare", "ALL")!.steps[0].chance, 0.3);
    assert.equal(upgradeCosts("t_plain", "ALL"), null);
  });
});

describe("craft deals", () => {
  test("upgraded items listed well under their cost to make", () => {
    const found = deals("ALL", dealOptions((n) => ({ kind: "craft" } as Record<string, string>)[n]))
      .filter((d) => d.item === "t_star");
    // +3 at 1000: the next seller asks 1200, under the 2640 cost to make, and 1000 isn't 20% under 1200.
    // +4 at 5000: making one (10500) beats the next seller (30000).
    assert.deepEqual(found.map((d) => [d.level, d.price, d.reference, d.madeFrom, d.nextAsk]), [[4, 5000, 10500, 3, 30000]]);
  });
});
