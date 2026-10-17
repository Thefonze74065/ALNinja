import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { describe, test } from "node:test";
import { app, DAY, db, HOUR, merchant } from "./helpers.ts";

const { ingest } = app.collector;
const { maintain, archivePath, archiveFile, listArchive } = app.archive;
const { history } = app.market;

const today = Math.floor(Date.now() / DAY) * DAY;
const oldDay = today - 10 * DAY; // past the 8-day retention used in tests
const recentDay = today - 2 * DAY;

const readCsv = (file: string) => zlib.gunzipSync(fs.readFileSync(file)).toString().trim().split("\n");
const stand = (t: number, price: number, extra = {}) => [
  merchant("ArcA", t, { trade1: { name: "t_arc", price }, ...extra }),
  merchant("ArcB", t, { trade1: { name: "t_arc", price: price * 2 } }),
];

describe("archive maintenance", () => {
  // Two hourly buckets on the old day (price 100 then 80), one on the recent day; a sale on the old day.
  ingest(stand(oldDay + 1 * HOUR, 100, { trade2: { name: "t_arc_sold", price: 10 } }), oldDay + 1 * HOUR);
  ingest(stand(oldDay + 5 * HOUR, 80, { trade2: null }), oldDay + 5 * HOUR);
  ingest(stand(recentDay + 3 * HOUR, 90), recentDay + 3 * HOUR);
  const first = maintain();

  test("completed days are exported to gzipped CSV", () => {
    const prices = readCsv(archivePath("prices", oldDay));
    assert.equal(prices[0], "time,bucket_ms,item,region,level,variant,price,lowest,median,best_bid,sellers,buyers,quantity");
    const arc = prices.filter((l) => l.includes(",t_arc,ALL,"));
    assert.equal(arc.length, 2, "one row per hourly bucket");
    assert.ok(arc[0].startsWith(new Date(oldDay + HOUR).toISOString()));

    const sales = readCsv(archivePath("sales", oldDay));
    assert.equal(sales.length, 2, "header + the one sale");
    assert.match(sales[1], /,t_arc_sold,0,,US,sell,10,1,ArcA,/);
    assert.ok(fs.existsSync(archivePath("prices", recentDay)));
    assert.ok(!fs.existsSync(archivePath("prices", today)), "today isn't complete yet");
  });

  test("days are summarized into price_daily", () => {
    const d = db.prepare("SELECT * FROM price_daily WHERE item = 't_arc' AND region = 'ALL' AND day = ?").get(oldDay) as any;
    assert.equal(d.close, 80);
    assert.equal(d.low, 80);
    assert.equal(d.high, 100);
    assert.equal(d.lowest, 80);
    assert.equal(d.sellers, 2);
    assert.equal(d.hours, 2);
  });

  test("hourly rows past retention leave the database; recent ones stay", () => {
    const count = (from: number, to: number) =>
      (db.prepare("SELECT COUNT(*) AS n FROM price_history WHERE bucket >= ? AND bucket < ?").get(from, to) as any).n;
    assert.equal(count(oldDay, oldDay + DAY), 0);
    assert.ok(count(recentDay, recentDay + DAY) > 0);
    assert.ok(first.retired > 0);
  });

  test("maintenance is idempotent", () => {
    assert.deepEqual(maintain(), { exported: 0, retired: 0 });
  });

  test("history uses daily closes before the hourly data", () => {
    const [v] = history("t_arc", "ALL", 30);
    assert.equal(v.hourlyFrom, recentDay);
    const points = v.points as { t: number; price: number }[];
    assert.deepEqual(points.map((p) => [p.t, p.price]), [[oldDay, 80], [recentDay + 3 * HOUR, 90]]);
  });

  test("archive listing and file lookup reject anything outside the archive", () => {
    const files = listArchive();
    assert.ok(files.some((f) => f.kind === "prices" && f.date === new Date(oldDay).toISOString().slice(0, 10)));
    const name = new Date(oldDay).toISOString().slice(0, 10) + ".csv.gz";
    assert.ok(archiveFile("prices", name));
    assert.equal(archiveFile("prices", "../../alninja.sqlite"), null);
    assert.equal(archiveFile("raw", name), null);
    assert.equal(archiveFile("prices", "2001-01-01.csv.gz"), null);
  });
});
