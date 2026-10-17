import { Hono } from "hono";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { getGameMeta } from "./gamedata.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface PriceRow {
  item: string;
  level: number;
  variant: string;
  bucket: number;
  sell_min: number | null;
  sell_p25: number | null;
  sell_median: number | null;
  buy_max: number | null;
  sell_count: number;
  buy_count: number;
  sell_qty: number;
}

const stmts = {
  history: db.prepare("SELECT * FROM price_history WHERE region = ? AND bucket >= ? ORDER BY bucket"),
  itemHistory: db.prepare(
    "SELECT * FROM price_history WHERE item = ? AND region = ? AND bucket >= ? ORDER BY bucket"),
  openListings: db.prepare(`
    SELECT l.merchant, l.side, l.level, l.variant, l.price, l.quantity, l.first_seen,
      m.last_seen, m.server_region, m.server_identifier, m.map, m.x, m.y
    FROM listings l JOIN merchants m ON m.id = l.merchant
    WHERE l.item = ?1 AND l.closed_at IS NULL AND (?2 = 'ALL' OR m.server_region = ?2)
    ORDER BY l.side, l.level, l.price`),
  closedListings: db.prepare(`
    SELECT merchant, side, level, variant, price, initial_quantity, quantity, first_seen, closed_at,
      close_reason, server_region, server_identifier
    FROM listings WHERE item = ?1 AND closed_at IS NOT NULL AND close_reason != 'expired'
      AND (?2 = 'ALL' OR server_region = ?2)
    ORDER BY closed_at DESC LIMIT 100`),
  lastPoll: db.prepare("SELECT * FROM polls ORDER BY id DESC LIMIT 1"),
  lastGoodPoll: db.prepare("SELECT * FROM polls WHERE error IS NULL ORDER BY id DESC LIMIT 1"),
  counts: db.prepare(`
    SELECT (SELECT COUNT(*) FROM listings WHERE closed_at IS NULL) AS open_listings,
           (SELECT COUNT(*) FROM listings) AS total_listings,
           (SELECT COUNT(*) FROM merchants) AS merchants,
           (SELECT MIN(fetched_at) FROM polls WHERE error IS NULL) AS tracking_since`),
  regions: db.prepare(
    "SELECT DISTINCT server_region AS region FROM merchants WHERE server_region IS NOT NULL ORDER BY 1"),
};

/** `?region=US` etc.; anything missing or malformed means all regions. */
function regionParam(raw: string | undefined): string {
  const region = (raw ?? "").toUpperCase();
  return /^[A-Z]{1,8}$/.test(region) ? region : "ALL";
}

/** The price we headline: lowest-quartile ask, falling back to the best bid for buy-only items. */
const headline = (r: PriceRow) => r.sell_p25 ?? r.buy_max;

function overview(region: string) {
  const now = Date.now();
  const rows = stmts.history.all(region, now - 7 * DAY) as unknown as PriceRow[];
  const byKey = new Map<string, PriceRow[]>();
  for (const r of rows) {
    const k = `${r.item}\u0000${r.level}\u0000${r.variant}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }

  const currentBucket = Math.floor(now / HOUR) * HOUR;
  const meta = getGameMeta().items;
  return [...byKey.values()].map((series) => {
    const latest = series[series.length - 1];
    // One sparkline point per day: the last observation of that day.
    const daily = new Map<number, number | null>();
    for (const r of series) daily.set(Math.floor(r.bucket / DAY), headline(r));
    const firstPrice = series.map(headline).find((p) => p != null) ?? null;
    const price = headline(latest);
    const m = meta[latest.item];
    return {
      item: latest.item,
      name: m?.name ?? latest.item,
      category: m?.category ?? "Other",
      level: latest.level,
      variant: latest.variant,
      price,
      sellMin: latest.sell_min,
      buyMax: latest.buy_max,
      sellCount: latest.sell_count,
      buyCount: latest.buy_count,
      quantity: latest.sell_qty,
      npcValue: m?.value ?? null,
      change7d: price != null && firstPrice ? (price - firstPrice) / firstPrice : null,
      sparkline: [...daily.values()],
      updated: latest.bucket,
      // Previous hour still counts as current: the new hour has no bucket until the next poll.
      stale: latest.bucket < currentBucket - HOUR,
    };
  });
}

export const api = new Hono();

api.get("/meta", (c) => {
  c.header("cache-control", "public, max-age=3600");
  return c.json(getGameMeta());
});

api.get("/status", (c) => {
  return c.json({
    lastPoll: stmts.lastPoll.get() ?? null,
    lastSuccessfulPoll: stmts.lastGoodPoll.get() ?? null,
    pollIntervalMinutes: config.pollIntervalMinutes,
    freshHours: config.freshHours,
    regions: (stmts.regions.all() as { region: string }[]).map((r) => r.region),
    ...(stmts.counts.get() as object),
  });
});

api.get("/overview", (c) => c.json(overview(regionParam(c.req.query("region")))));

api.get("/items/:item", (c) => {
  const item = c.req.param("item");
  const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 3650);
  const region = regionParam(c.req.query("region"));
  const rows = stmts.itemHistory.all(item, region, Date.now() - days * DAY) as unknown as PriceRow[];

  const variants = new Map<string, { level: number; variant: string; history: unknown[] }>();
  for (const r of rows) {
    const k = `${r.level}\u0000${r.variant}`;
    if (!variants.has(k)) variants.set(k, { level: r.level, variant: r.variant, history: [] });
    variants.get(k)!.history.push({
      t: r.bucket, min: r.sell_min, p25: r.sell_p25, median: r.sell_median, buy: r.buy_max,
      sellCount: r.sell_count, buyCount: r.buy_count, quantity: r.sell_qty,
    });
  }

  return c.json({
    item,
    region,
    meta: getGameMeta().items[item] ?? null,
    variants: [...variants.values()].sort((a, b) => a.level - b.level || a.variant.localeCompare(b.variant)),
    listings: stmts.openListings.all(item, region),
    recentlyClosed: stmts.closedListings.all(item, region),
  });
});
