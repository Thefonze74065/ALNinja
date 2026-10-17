import { db } from "./db.ts";
import { getGameMeta } from "./gamedata.ts";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

interface PriceRow {
  item: string;
  region: string;
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

export interface MarketRow {
  item: string;
  name: string;
  category: string;
  level: number;
  variant: string;
  /** Lower-quartile ask (falls back to best bid for buy-only items). */
  price: number | null;
  lowest: number | null;
  median: number | null;
  bestBid: number | null;
  sellers: number;
  buyers: number;
  quantity: number;
  npcValue: number | null;
  change24h: number | null;
  change7d: number | null;
  /** Estimated units sold by merchants (sell side) / bought via buy orders, per day. */
  soldPerDay: number;
  boughtPerDay: number;
  sparkline: (number | null)[];
  updated: number;
  stale: boolean;
}

const stmts = {
  history: db.prepare("SELECT * FROM price_history WHERE region = ? AND bucket >= ? ORDER BY bucket"),
  itemHistory: db.prepare(
    "SELECT * FROM price_history WHERE item = ? AND region = ? AND bucket >= ? ORDER BY bucket"),
  salesByKey: db.prepare(`
    SELECT item, level, variant, side, SUM(quantity) AS units FROM sales
    WHERE at >= ?1 AND (?2 = 'ALL' OR region = ?2)
    GROUP BY item, level, variant, side`),
  trackingSince: db.prepare("SELECT MIN(fetched_at) AS t FROM polls WHERE error IS NULL"),
  lastPoll: db.prepare("SELECT MAX(id) AS id, MAX(fetched_at) AS at FROM polls WHERE error IS NULL"),
  openListings: db.prepare(`
    SELECT l.merchant, l.side, l.level, l.variant, l.price, l.quantity, l.first_seen,
      m.last_seen, m.server_region, m.server_identifier, m.map, m.x, m.y
    FROM listings l JOIN merchants m ON m.id = l.merchant
    WHERE l.item = ?1 AND l.closed_at IS NULL AND (?2 = 'ALL' OR m.server_region = ?2)
    ORDER BY l.side, l.level, l.price`),
  itemDailySales: db.prepare(`
    SELECT level, variant, side, at / 86400000 AS day, COUNT(*) AS trades, SUM(quantity) AS units FROM sales
    WHERE item = ?1 AND (?2 = 'ALL' OR region = ?2) AND at >= ?3
    GROUP BY level, variant, side, day ORDER BY day`),
  recentSales: db.prepare(`
    SELECT merchant, side, item, level, variant, region, price, quantity, listed_at, at FROM sales
    WHERE (?1 IS NULL OR item = ?1) AND (?2 = 'ALL' OR region = ?2) AND at >= ?3
    ORDER BY at DESC LIMIT ?4`),
  // Each sell listing opened in the window, priced against the market index at the hour it appeared.
  listingOutcomes: db.prepare(`
    SELECT l.level, l.variant, l.price, ph.sell_p25 AS market, l.first_seen, l.closed_at, l.close_reason
    FROM listings l
    JOIN price_history ph ON ph.item = l.item AND ph.region = ?2 AND ph.level = l.level
      AND ph.variant = l.variant AND ph.bucket = (l.first_seen / 3600000) * 3600000
    WHERE l.item = ?1 AND l.side = 'sell' AND l.first_seen >= ?3 AND ph.sell_p25 IS NOT NULL
      AND (?2 = 'ALL' OR l.server_region = ?2)`),
};

/** `?region=US` etc.; anything missing or malformed means all regions. */
export function regionParam(raw: string | undefined): string {
  const region = (raw ?? "").toUpperCase();
  return /^[A-Z]{1,8}$/.test(region) ? region : "ALL";
}

export function lastPoll(): { id: number | null; at: number | null } {
  return stmts.lastPoll.get() as { id: number | null; at: number | null };
}

/** Days of sales data available, capped at the 7-day averaging window and floored at one day. */
function salesWindowDays(now: number): number {
  const since = (stmts.trackingSince.get() as { t: number | null }).t ?? now;
  return Math.min(7, Math.max(1, (now - since) / DAY));
}

/** Price change against the last observation at or before `target` (within `tolerance`), ask-to-ask only. */
function changeSince(series: PriceRow[], latest: PriceRow, target: number, tolerance: number): number | null {
  let base: PriceRow | undefined;
  for (const r of series) {
    if (r.bucket > target) break;
    base = r;
  }
  if (!base || base.bucket < target - tolerance) return null;
  // Single-seller prices swing on one stand; don't report a change unless both ends have competition.
  if (base.sell_count < 2 || latest.sell_count < 2 || !base.sell_p25 || latest.sell_p25 == null) return null;
  return (latest.sell_p25 - base.sell_p25) / base.sell_p25;
}

const key = (r: { item: string; level: number; variant: string }) => `${r.item}\u0000${r.level}\u0000${r.variant}`;

function computeSnapshot(region: string, now: number): MarketRow[] {
  const rows = stmts.history.all(region, now - 7 * DAY - 6 * HOUR) as unknown as PriceRow[];
  const byKey = new Map<string, PriceRow[]>();
  for (const r of rows) {
    const k = key(r);
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(r);
  }

  const days = salesWindowDays(now);
  const sales = new Map<string, { sold: number; bought: number }>();
  for (const s of stmts.salesByKey.all(now - 7 * DAY, region) as any[]) {
    const k = key(s);
    const v = sales.get(k) ?? { sold: 0, bought: 0 };
    if (s.side === "sell") v.sold += s.units;
    else v.bought += s.units;
    sales.set(k, v);
  }

  const currentBucket = Math.floor(now / HOUR) * HOUR;
  const meta = getGameMeta().items;
  const headline = (r: PriceRow) => r.sell_p25 ?? r.buy_max;
  return [...byKey.entries()].map(([k, series]) => {
    const latest = series[series.length - 1];
    // One sparkline point per day over the last 7 days: the last observation of that day.
    const daily = new Map<number, number | null>();
    for (const r of series) if (r.bucket >= now - 7 * DAY) daily.set(Math.floor(r.bucket / DAY), headline(r));
    const m = meta[latest.item];
    const s = sales.get(k);
    return {
      item: latest.item,
      name: m?.name ?? latest.item,
      category: m?.category ?? "Other",
      level: latest.level,
      variant: latest.variant,
      price: headline(latest),
      lowest: latest.sell_min,
      median: latest.sell_median,
      bestBid: latest.buy_max,
      sellers: latest.sell_count,
      buyers: latest.buy_count,
      quantity: latest.sell_qty,
      npcValue: m?.value ?? null,
      change24h: changeSince(series, latest, now - DAY, 3 * HOUR),
      change7d: changeSince(series, latest, now - 7 * DAY, 6 * HOUR),
      soldPerDay: s ? s.sold / days : 0,
      boughtPerDay: s ? s.bought / days : 0,
      sparkline: [...daily.values()],
      updated: latest.bucket,
      // Previous hour still counts as current: the new hour has no bucket until the next poll.
      stale: latest.bucket < currentBucket - HOUR,
    };
  });
}

// Snapshots only change when a poll lands, so cache them per region until the next one.
const cache = new Map<string, { pollId: number | null; rows: MarketRow[] }>();

export function snapshot(region: string): MarketRow[] {
  const { id } = lastPoll();
  const hit = cache.get(region);
  if (hit && hit.pollId === id) return hit.rows;
  const rows = computeSnapshot(region, Date.now());
  cache.set(region, { pollId: id, rows });
  return rows;
}

export function movers(region: string, window: "24h" | "7d", minSellers: number, limit: number) {
  const field = window === "24h" ? "change24h" : "change7d";
  const rows = snapshot(region).filter((r) => r[field] != null && r.sellers >= minSellers);
  const byChange = [...rows].sort((a, b) => b[field]! - a[field]!);
  return {
    gainers: byChange.filter((r) => r[field]! > 0).slice(0, limit),
    losers: byChange.filter((r) => r[field]! < 0).reverse().slice(0, limit),
    mostTraded: snapshot(region)
      .filter((r) => r.soldPerDay + r.boughtPerDay > 0)
      .sort((a, b) => b.soldPerDay + b.boughtPerDay - (a.soldPerDay + a.boughtPerDay))
      .slice(0, limit),
  };
}

export function history(item: string, region: string, days: number) {
  const rows = stmts.itemHistory.all(item, region, Date.now() - days * DAY) as unknown as PriceRow[];
  const variants = new Map<string, { level: number; variant: string; points: unknown[] }>();
  for (const r of rows) {
    const k = `${r.level}\u0000${r.variant}`;
    if (!variants.has(k)) variants.set(k, { level: r.level, variant: r.variant, points: [] });
    variants.get(k)!.points.push({
      t: r.bucket, price: r.sell_p25 ?? r.buy_max, lowest: r.sell_min, median: r.sell_median,
      bestBid: r.buy_max, sellers: r.sell_count, buyers: r.buy_count, quantity: r.sell_qty,
    });
  }
  return [...variants.values()].sort((a, b) => a.level - b.level || a.variant.localeCompare(b.variant));
}

export function openListings(item: string, region: string) {
  return (stmts.openListings.all(item, region) as any[]).map((l) => ({
    merchant: l.merchant,
    side: l.side,
    level: l.level,
    variant: l.variant,
    price: l.price,
    quantity: l.quantity,
    region: l.server_region,
    server: l.server_identifier,
    map: l.map,
    x: l.x,
    y: l.y,
    listedAt: l.first_seen,
    merchantSeenAt: l.last_seen,
  }));
}

export function recentSales(item: string | null, region: string, since: number, limit: number) {
  return (stmts.recentSales.all(item, region, since, limit) as any[]).map((s) => ({
    item: s.item,
    side: s.side,
    level: s.level,
    variant: s.variant,
    price: s.price,
    quantity: s.quantity,
    merchant: s.merchant,
    region: s.region,
    listedAt: s.listed_at,
    at: s.at,
  }));
}

const BANDS = [
  { label: "Under 90%", max: 0.9 },
  { label: "90–110%", max: 1.1 },
  { label: "110–150%", max: 1.5 },
  { label: "Over 150%", max: Infinity },
];

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
};

/** Sales per day and time-to-sell by price band (relative to market at listing time), per variant. */
export function velocity(item: string, region: string, days: number) {
  const since = Date.now() - days * DAY;
  const result = new Map<string, { level: number; variant: string; daily: any[]; bands: any[]; medianHoursToSell: number | null }>();
  const get = (level: number, variant: string) => {
    const k = `${level}\u0000${variant}`;
    if (!result.has(k)) result.set(k, { level, variant, daily: [], bands: [], medianHoursToSell: null });
    return result.get(k)!;
  };

  const daily = new Map<string, Map<number, { day: number; sold: number; bought: number; trades: number }>>();
  for (const r of stmts.itemDailySales.all(item, region, since) as any[]) {
    get(r.level, r.variant);
    const k = `${r.level}\u0000${r.variant}`;
    const byDay = daily.get(k) ?? daily.set(k, new Map()).get(k)!;
    const d = byDay.get(r.day) ?? { day: r.day * DAY, sold: 0, bought: 0, trades: 0 };
    if (r.side === "sell") d.sold += r.units;
    else d.bought += r.units;
    d.trades += r.trades;
    byDay.set(r.day, d);
  }
  for (const [k, byDay] of daily) result.get(k)!.daily = [...byDay.values()];

  const outcomes = new Map<string, any[]>();
  for (const l of stmts.listingOutcomes.all(item, region, since) as any[]) {
    get(l.level, l.variant);
    const k = `${l.level}\u0000${l.variant}`;
    (outcomes.get(k) ?? outcomes.set(k, []).get(k)!).push(l);
  }
  for (const [k, listings] of outcomes) {
    const v = result.get(k)!;
    const soldHours = (ls: any[]) =>
      ls.filter((l) => l.close_reason === "gone").map((l) => (l.closed_at - l.first_seen) / HOUR);
    v.medianHoursToSell = median(soldHours(listings));
    let lower = 0;
    v.bands = BANDS.map((b) => {
      const inBand = listings.filter((l) => l.price / l.market > lower && l.price / l.market <= b.max);
      lower = b.max;
      const sold = inBand.filter((l) => l.close_reason === "gone").length;
      const pulled = inBand.filter((l) => l.closed_at != null && l.close_reason !== "gone").length;
      return {
        band: b.label,
        listings: inBand.length,
        sold,
        pulled,
        open: inBand.length - sold - pulled,
        sellThrough: sold + pulled ? sold / (sold + pulled) : null,
        medianHoursToSell: median(soldHours(inBand)),
      };
    });
  }

  return [...result.values()];
}
