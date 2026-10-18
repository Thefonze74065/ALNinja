import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { app, db, HOUR, merchant } from "./helpers.ts";

const { ingest } = app.collector;
const { recordReport, accuracy } = app.observed;
const { recentSales } = app.market;
const MINUTE = 60_000;
const now = Date.now();

const post = (body: unknown, token: string | null = "test-token") =>
  app.v1.request("/observations", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
const sale = (over: Record<string, unknown> = {}) => ({
  at: now, seller: "StandOwner", buyer: "Shopper", slot: "trade1", item: { name: "t_obs", price: 100, q: 2 }, ...over,
});
const rows = (merchantName: string) =>
  db.prepare("SELECT * FROM observed_sales WHERE merchant = ? ORDER BY id").all(merchantName) as any[];

describe("POST /observations", () => {
  test("requires the report token", async () => {
    assert.equal((await post({ reporter: "Me", sentAt: now }, null)).status, 401);
    assert.equal((await post({ reporter: "Me", sentAt: now }, "wrong")).status, 401);
    assert.equal((await post({ reporter: "Me", sentAt: now })).status, 200);
  });

  test("rejects malformed reports with a reason", async () => {
    const res = await post({ reporter: "bad name!", sentAt: now });
    assert.equal(res.status, 400);
    assert.match((await res.json()).error, /reporter/);
    const res2 = await post({ reporter: "Me", sentAt: now, sales: [sale({ item: { name: "t_obs", price: 1.5 } })] });
    assert.equal(res2.status, 400);
    assert.match((await res2.json()).error, /price/);
  });

  test("a stand purchase names the stand owner as seller; a filled buy order as buyer", async () => {
    await post({
      reporter: "Me", sentAt: now, region: "US", server: "II", map: "main",
      sales: [
        sale({ seller: "SideA", buyer: "Shopper", item: { name: "t_side", level: 3, p: "shiny", price: 500, q: 1 } }),
        sale({ seller: "Shopper", buyer: "SideB", filledBuyOrder: true, item: { name: "t_side", price: 40, q: 5 } }),
      ],
    });
    const [a] = rows("SideA");
    assert.deepEqual([a.side, a.counterparty, a.level, a.variant, a.quantity, a.region], ["sell", "Shopper", 3, "shiny", 1, "US"]);
    const [b] = rows("SideB");
    assert.deepEqual([b.side, b.counterparty, b.price, b.quantity], ["buy", "Shopper", 40, 5]);
  });

  test("corrects the reporter's clock skew", () => {
    // The reporter's clock runs an hour slow: it says it sent at now-1h, but we received at now.
    recordReport({ reporter: "Slow", sentAt: now - HOUR, sales: [sale({ at: now - HOUR - MINUTE, seller: "Skewed" })] }, now);
    assert.equal(rows("Skewed")[0].at, now - MINUTE);
  });

  test("the same trade seen by two characters is stored once", () => {
    recordReport({ reporter: "Char1", sentAt: now, sales: [sale({ seller: "Dupe" })] }, now);
    const r = recordReport({ reporter: "Char2", sentAt: now, sales: [sale({ seller: "Dupe", at: now + 20_000 })] }, now);
    assert.equal(r.duplicates, 1);
    assert.equal(rows("Dupe").length, 1);
  });

  test("identical trades reported by the same character are separate trades", () => {
    const r = recordReport({
      reporter: "Char3", sentAt: now,
      sales: [sale({ seller: "Twice", at: now }), sale({ seller: "Twice", at: now + 30_000 })],
    }, now);
    assert.equal(r.stored, 2);
    assert.equal(rows("Twice").length, 2);
  });

  test("merchants in view build coverage intervals; a long gap starts a new one", () => {
    for (const t of [0, 30_000, 60_000, 90_000, 10 * MINUTE]) {
      recordReport({ reporter: "Watcher", sentAt: now + t, inView: ["Watched"] }, now + t);
    }
    const cov = db.prepare("SELECT start, end FROM observer_coverage WHERE merchant = 'Watched' ORDER BY start").all() as any[];
    assert.deepEqual(cov.map((c) => [c.start - now, c.end - now]), [[0, 90_000], [10 * MINUTE, 10 * MINUTE]]);
  });
});

describe("accuracy", () => {
  // Inferred: t_acc drops 10 -> 7 (3 sold, observed), t_acc2 drops 5 -> 4 (not observed: false positive).
  // Observed: 3 x t_acc (matched), 1 x t_acc3 whose stand never changed (missed), 1 x untracked merchant.
  const t1 = now - HOUR;
  const t0 = t1 - 30 * MINUTE;
  const stand = (t: number, a: number, b: number) =>
    merchant("AccM", t, {
      trade1: { name: "t_acc", price: 100, q: a },
      trade2: { name: "t_acc2", price: 100, q: b },
      trade3: { name: "t_acc3", price: 100, q: 5 },
    });
  ingest([stand(t0, 10, 5)], t0);
  ingest([stand(t1, 7, 4)], t1);
  for (let t = t1 - 40 * MINUTE; t <= t1 + 5 * MINUTE; t += 60_000) {
    recordReport({ reporter: "Watcher2", sentAt: t, inView: ["AccM"] }, t);
  }
  recordReport({
    reporter: "Watcher2", sentAt: t1,
    sales: [
      { at: t1 - 2 * MINUTE, seller: "AccM", buyer: "B1", item: { name: "t_acc", price: 100, q: 3 } },
      { at: t1 - MINUTE, seller: "AccM", buyer: "B2", item: { name: "t_acc3", price: 100, q: 1 } },
      { at: t1 - MINUTE, seller: "Ghost", buyer: "B3", item: { name: "t_acc", price: 100, q: 1 } },
    ],
  }, t1);

  test("recall, precision and miss reasons", () => {
    const a = accuracy(1);
    // Reports at merchants never seen offering those goods (Ghost, plus earlier tests' names) can't be
    // verified against a listing, so they're set aside rather than counted.
    const unseen = (db.prepare("SELECT COUNT(*) AS n FROM observed_sales WHERE merchant NOT IN (SELECT id FROM merchants)").get() as any).n;
    assert.ok(unseen >= 1);
    assert.equal(a.observed.unverified, unseen);
    assert.equal(a.observed.untracked, 0);
    assert.equal(a.recall, 3 / 4);
    assert.equal(a.precision, 3 / 4);
    assert.deepEqual(a.missedReasons, { "still listed (change not seen)": 1 });
    assert.deepEqual(a.falsePositives.map((f) => [f.item, f.unconfirmed]), [["t_acc2", 1]]);
  });

  test("sales lists show observed trades, plus only the unexplained part of estimates", () => {
    const acc = recentSales("t_acc", "ALL", now - 2 * HOUR, 50).filter((s) => s.merchant === "AccM");
    assert.deepEqual(acc.map((s) => [s.source, s.quantity, s.counterparty]), [["observed", 3, "B1"]]);
    const acc2 = recentSales("t_acc2", "ALL", now - 2 * HOUR, 50);
    assert.deepEqual(acc2.map((s) => [s.source, s.quantity]), [["estimated", 1]]);
  });
});

describe("watched stands", () => {
  // Listed at tA, vanished at tB, confirmation due by tC. Each merchant reports its own trade history.
  const tA = now - 5 * HOUR;
  const tB = tA + HOUR;
  const tC = tB + 3 * HOUR;
  const keep = { trade1: { name: "t_keep_w", price: 1 } };
  const stands = (t: number, up: boolean) => [
    merchant("OwnPulled", t, { ...keep, ...(up ? { trade2: { name: "t_own", price: 100 } } : {}) }),
    merchant("OwnSold", t, { ...keep, ...(up ? { trade2: { name: "t_own", price: 100 } } : {}) }),
    merchant("Unwatched", t, { ...keep, ...(up ? { trade2: { name: "t_own", price: 100 } } : {}) }),
  ];
  const listing = (m: string) =>
    db.prepare("SELECT close_reason FROM listings WHERE merchant = ? AND item = 't_own'").get(m) as any;
  const salesAt = (m: string) => db.prepare("SELECT quantity FROM sales WHERE merchant = ?").all(m) as any[];

  test("a stand watched the whole time with no trade seen is unsold, not a sale", () => {
    ingest(stands(tA, true), tA);
    for (let t = tA - MINUTE; t <= tB + 5 * MINUTE; t += MINUTE) {
      for (const reporter of ["OwnPulled", "OwnSold"]) {
        const history = reporter === "OwnSold" && t === tB - 10 * MINUTE
          ? [{ at: t, event: "sell" as const, counterparty: "Buyer", item: { name: "t_own" }, total: 100 }]
          : [];
        recordReport({ reporter, sentAt: t, history }, t);
      }
    }
    ingest(stands(tB, false), tB);
    ingest(stands(tC, false), tC);
    assert.equal(listing("OwnPulled").close_reason, "unsold");
    assert.equal(salesAt("OwnPulled").length, 0);
    assert.equal(listing("OwnSold").close_reason, "gone");
    assert.deepEqual(salesAt("OwnSold").map((s) => s.quantity), [1]);
    assert.equal(listing("Unwatched").close_reason, "gone", "nobody watching: still an estimated sale");
  });

  test("refuted estimates count against precision", () => {
    const fp = accuracy(1).falsePositives.filter((f) => f.item === "t_own");
    assert.deepEqual(fp.map((f) => [f.merchant, f.unconfirmed]), [["OwnPulled", 1]]);
  });
});
