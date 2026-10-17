import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { app, HOUR, listingsOf, merchant, priceOf, salesOf, T0 } from "./helpers.ts";

const { ingest, toOffer } = app.collector;

describe("toOffer", () => {
  test("skips giveaways, barter, and unpriced slots", () => {
    assert.equal(toOffer("trade1", null), null);
    assert.equal(toOffer("trade1", { name: "ring", price: 1, giveaway: 1 }), null);
    assert.equal(toOffer("trade1", { name: "ring", want: { name: "broom" } }), null);
    assert.equal(toOffer("trade1", { name: "ring" }), null);
    assert.equal(toOffer("trade1", { name: "ring", price: 0 }), null);
  });

  test("reads side, level, quantity, variant and flags", () => {
    assert.deepEqual(toOffer("trade3", { name: "mpot1", price: 90, b: true, q: 400 }), {
      slot: "trade3", side: "buy", item: "mpot1", level: 0, variant: "", price: 90, quantity: 400, flags: "",
    });
    const shiny = toOffer("trade1", { name: "staff", level: 3, p: "shiny", price: 1e6, gift: 1 })!;
    assert.equal(shiny.variant, "shiny");
    assert.equal(shiny.level, 3);
    assert.equal(shiny.flags, "gift");
    assert.equal(toOffer("trade1", { name: "cxjar", data: "hat410", price: 5e6 })!.variant, "hat410");
  });
});

describe("listing lifecycle", () => {
  test("a listing that stays up is one row; an unchanged lastSeen is a no-op", () => {
    const slots = { trade1: { name: "t_keep", price: 100 } };
    ingest([merchant("Keep", T0, slots)], T0);
    const r = ingest([merchant("Keep", T0, slots)], T0 + 600_000);
    assert.equal(r.updated, 0);
    ingest([merchant("Keep", T0 + HOUR, slots)], T0 + HOUR);
    const rows = listingsOf("Keep");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].first_seen, T0);
    assert.equal(rows[0].last_seen, T0 + HOUR);
    assert.equal(rows[0].closed_at, null);
  });

  test("a shrinking stack is a partial sale", () => {
    ingest([merchant("Partial", T0, { trade1: { name: "t_stack", price: 50, q: 10 } })], T0);
    ingest([merchant("Partial", T0 + HOUR, { trade1: { name: "t_stack", price: 50, q: 7 } })], T0 + HOUR);
    const [sale] = salesOf("Partial");
    assert.equal(sale.quantity, 3);
    assert.equal(sale.price, 50);
    assert.equal(sale.listed_at, T0);
    assert.equal(listingsOf("Partial")[0].quantity, 7);
  });

  test("a listing vanishing while the stand stays up is a sale", () => {
    const a = { name: "t_sold", price: 1000 };
    const b = { name: "t_other", price: 5 };
    ingest([merchant("Sold", T0, { trade1: a, trade2: b })], T0);
    ingest([merchant("Sold", T0 + 2 * HOUR, { trade2: b })], T0 + 2 * HOUR);
    const sold = listingsOf("Sold").find((l) => l.item === "t_sold");
    assert.equal(sold.close_reason, "gone");
    assert.equal(sold.closed_at, T0 + 2 * HOUR);
    const [sale] = salesOf("Sold");
    assert.equal(sale.item, "t_sold");
    assert.equal(sale.at - sale.listed_at, 2 * HOUR);
  });

  test("a price change in the same slot is a reprice, not a sale", () => {
    ingest([merchant("Reprice", T0, { trade1: { name: "t_rep", price: 100 }, trade2: { name: "t_x", price: 1 } })], T0);
    ingest([merchant("Reprice", T0 + HOUR, { trade1: { name: "t_rep", price: 90 }, trade2: { name: "t_x", price: 1 } })], T0 + HOUR);
    const rows = listingsOf("Reprice").filter((l) => l.item === "t_rep");
    assert.deepEqual(rows.map((l) => [l.price, l.close_reason]), [[100, "repriced"], [90, null]]);
    assert.equal(salesOf("Reprice").length, 0);
  });

  test("moving the same offer to another slot keeps the listing", () => {
    ingest([merchant("Move", T0, { trade1: { name: "t_move", price: 100 } })], T0);
    ingest([merchant("Move", T0 + HOUR, { trade7: { name: "t_move", price: 100 } })], T0 + HOUR);
    const rows = listingsOf("Move");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slot, "trade7");
    assert.equal(rows[0].closed_at, null);
    assert.equal(salesOf("Move").length, 0);
  });

  test("a stand emptying all at once is withdrawn, not a sell-out", () => {
    const slots = Object.fromEntries([1, 2, 3].map((i) => [`trade${i}`, { name: `t_pack${i}`, price: 10 }]));
    ingest([merchant("Pack", T0, slots)], T0);
    ingest([merchant("Pack", T0 + HOUR, {})], T0 + HOUR);
    assert.deepEqual(listingsOf("Pack").map((l) => l.close_reason), ["withdrawn", "withdrawn", "withdrawn"]);
    assert.equal(salesOf("Pack").length, 0);
  });

  test("offers far from market (placeholders, lowball bids) are withdrawals", () => {
    const keep = { trade9: { name: "t_keep2", price: 1 } };
    ingest([
      merchant("Market", T0, { trade1: { name: "t_park", price: 1000 } }),
      merchant("Parker", T0, { ...keep, trade1: { name: "t_park", price: 99_999_999_999 }, trade2: { name: "t_park", price: 100, b: true } }),
    ], T0);
    ingest([
      merchant("Market", T0, { trade1: { name: "t_park", price: 1000 } }),
      merchant("Parker", T0 + HOUR, keep),
    ], T0 + HOUR);
    const closed = listingsOf("Parker").filter((l) => l.item === "t_park");
    assert.deepEqual(closed.map((l) => l.close_reason), ["withdrawn", "withdrawn"]);
    assert.equal(salesOf("Parker").length, 0);
  });

  test("a buy order filled near market is a purchase", () => {
    const keep = { trade9: { name: "t_keep3", price: 1 } };
    ingest([
      merchant("Seller", T0, { trade1: { name: "t_bid", price: 1000 } }),
      merchant("Bidder", T0, { ...keep, trade1: { name: "t_bid", price: 900, b: true, q: 5 } }),
    ], T0);
    ingest([
      merchant("Seller", T0, { trade1: { name: "t_bid", price: 1000 } }),
      merchant("Bidder", T0 + HOUR, { ...keep, trade1: { name: "t_bid", price: 900, b: true, q: 2 } }),
    ], T0 + HOUR);
    const [sale] = salesOf("Bidder");
    assert.equal(sale.side, "buy");
    assert.equal(sale.quantity, 3);
  });

  test("merchants that drop out of the feed expire at their last sighting", () => {
    ingest([merchant("Gone", T0, { trade1: { name: "t_exp", price: 10 } })], T0);
    ingest([merchant("Someone", T0 + HOUR, {})], T0 + HOUR);
    const [l] = listingsOf("Gone");
    assert.equal(l.close_reason, "expired");
    assert.equal(l.closed_at, T0);
    assert.equal(salesOf("Gone").length, 0);
  });

  test("flags are stored with the listing", () => {
    ingest([merchant("Gifter", T0, { trade1: { name: "t_gift", level: 3, price: 10, gift: 1 } })], T0);
    assert.equal(listingsOf("Gifter")[0].flags, "gift");
  });
});

describe("price index", () => {
  test("each merchant counts once, at its cheapest offer", () => {
    const flood = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`trade${i}`, { name: "t_idx", price: 10 * i }]));
    ingest([
      merchant("Flood", T0, flood),
      merchant("B", T0, { trade1: { name: "t_idx", price: 100 } }),
      merchant("C", T0, { trade1: { name: "t_idx", price: 100 } }, "EU"),
      merchant("D", T0, { trade1: { name: "t_idx", price: 100 }, trade2: { name: "t_idx", price: 80, b: true, q: 3 } }, "EU"),
    ], T0);
    const all = priceOf("t_idx");
    assert.equal(all.sell_count, 4);
    assert.equal(all.sell_min, 10);
    assert.equal(all.sell_p25, 10);
    assert.equal(all.sell_median, 100);
    assert.equal(all.buy_max, 80);
    assert.equal(all.sell_qty, 8);
  });

  test("prices are also indexed per region", () => {
    const us = priceOf("t_idx", "US");
    const eu = priceOf("t_idx", "EU");
    assert.equal(us.sell_count, 2);
    assert.equal(eu.sell_count, 2);
    assert.equal(eu.sell_min, 100);
    assert.equal(eu.buy_max, 80);
  });

  test("merchants not seen within FRESH_HOURS are left out", () => {
    ingest([
      merchant("Fresh", T0, { trade1: { name: "t_fresh", price: 200 } }),
      merchant("Stale", T0 - 49 * HOUR, { trade1: { name: "t_fresh", price: 5 } }),
    ], T0);
    const p = priceOf("t_fresh");
    assert.equal(p.sell_count, 1);
    assert.equal(p.sell_min, 200);
  });
});
