import { config } from "./config.ts";
import { db } from "./db.ts";
import { capAtShop, getGameMeta, npcSellValue, npcShopPrice } from "./gamedata.ts";

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
  /**
   * What one unit costs: the lower-quartile player ask, capped at the NPC shop price. Falls back to the
   * shop price, then the best bid, when nobody is selling.
   */
  price: number | null;
  /** Price an NPC shop sells one unit for, or null if no shop sells it. */
  npcPrice: number | null;
  lowest: number | null;
  median: number | null;
  bestBid: number | null;
  sellers: number;
  buyers: number;
  quantity: number;
  /** Gold an NPC pays for one unit at this level. */
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
  firstHourly: db.prepare("SELECT MIN(bucket) AS t FROM price_history"),
  itemDaily: db.prepare(
    "SELECT * FROM price_daily WHERE item = ? AND region = ? AND day >= ? AND day < ? ORDER BY day"),
  salesByKey: db.prepare(`
    SELECT item, level, variant, side, SUM(quantity) AS units FROM sales
    WHERE at >= ?1 AND (?2 = 'ALL' OR region = ?2)
    GROUP BY item, level, variant, side`),
  trackingSince: db.prepare("SELECT MIN(fetched_at) AS t FROM polls WHERE error IS NULL"),
  lastPoll: db.prepare("SELECT MAX(id) AS id, MAX(fetched_at) AS at FROM polls WHERE error IS NULL"),
  freshListings: db.prepare(`
    SELECT l.id, l.merchant, l.side, l.item, l.level, l.variant, l.flags, l.price, l.quantity, l.first_seen,
      m.last_seen, m.server_region, m.server_identifier, m.map, m.x, m.y
    FROM listings l JOIN merchants m ON m.id = l.merchant
    WHERE l.closed_at IS NULL AND m.last_seen >= ?1 AND (?2 = 'ALL' OR m.server_region = ?2)`),
  openListings: db.prepare(`
    SELECT l.merchant, l.side, l.level, l.variant, l.price, l.quantity, l.first_seen,
      m.last_seen, m.server_region, m.server_identifier, m.map, m.x, m.y
    FROM listings l JOIN merchants m ON m.id = l.merchant
    WHERE l.item = ?1 AND l.closed_at IS NULL AND (?2 = 'ALL' OR m.server_region = ?2)
    ORDER BY l.side, l.level, l.price`),
  // Trades bucketed by ?4 ms (an hour or a day). Bound JS numbers arrive as REAL, so cast for
  // integer division.
  itemSalesBuckets: db.prepare(`
    SELECT level, variant, side, at / CAST(?4 AS INTEGER) AS slot, COUNT(*) AS trades, SUM(quantity) AS units FROM sales
    WHERE item = ?1 AND (?2 = 'ALL' OR region = ?2) AND at >= ?3
    GROUP BY level, variant, side, slot ORDER BY slot`),
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

/**
 * Price change against the last observation at or before `target` (within `tolerance`), ask-to-ask only,
 * with both ends capped at the NPC shop price (`shop`) so asks above it can't fake a move.
 */
function changeSince(
  series: PriceRow[], latest: PriceRow, target: number, tolerance: number, shop: number | null,
): number | null {
  let base: PriceRow | undefined;
  for (const r of series) {
    if (r.bucket > target) break;
    base = r;
  }
  if (!base || base.bucket < target - tolerance) return null;
  // Single-seller prices swing on one stand; don't report a change unless both ends have competition.
  if (base.sell_count < 2 || latest.sell_count < 2 || !base.sell_p25 || latest.sell_p25 == null) return null;
  const then = shop == null ? base.sell_p25 : Math.min(base.sell_p25, shop);
  const now = shop == null ? latest.sell_p25 : Math.min(latest.sell_p25, shop);
  return (now - then) / then;
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
  return [...byKey.entries()].map(([k, series]) => {
    const latest = series[series.length - 1];
    const shop = npcShopPrice(latest.item, latest.level, latest.variant);
    const headline = (r: PriceRow) =>
      r.sell_p25 != null ? (shop == null ? r.sell_p25 : Math.min(r.sell_p25, shop)) : (shop ?? r.buy_max);
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
      npcPrice: shop,
      lowest: latest.sell_min,
      median: latest.sell_median,
      bestBid: latest.buy_max,
      sellers: latest.sell_count,
      buyers: latest.buy_count,
      quantity: latest.sell_qty,
      npcValue: m ? npcSellValue(latest.item, latest.level) : null,
      change24h: changeSince(series, latest, now - DAY, 3 * HOUR, shop),
      change7d: changeSince(series, latest, now - 7 * DAY, 6 * HOUR, shop),
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

/**
 * Price history per level/variant: hourly points where the database still has them, preceded by daily
 * closes (from price_daily) for older parts of the range. `hourlyFrom` marks where hourly data starts.
 */
export function history(item: string, region: string, days: number) {
  const since = Date.now() - days * DAY;
  const firstHourly = (stmts.firstHourly.get() as { t: number | null }).t;
  const hourlyFrom = firstHourly == null ? Date.now() : Math.floor(firstHourly / DAY) * DAY;

  type Out = {
    level: number; variant: string; npcValue: number; npcPrice: number | null; hourlyFrom: number; points: unknown[];
  };
  const variants = new Map<string, Out>();
  const get = (level: number, variant: string) => {
    const k = `${level}\u0000${variant}`;
    if (!variants.has(k)) {
      variants.set(k, {
        level, variant, npcValue: npcSellValue(item, level), npcPrice: npcShopPrice(item, level, variant),
        hourlyFrom, points: [],
      });
    }
    return variants.get(k)!;
  };

  if (since < hourlyFrom) {
    for (const d of stmts.itemDaily.all(item, region, since, hourlyFrom) as any[]) {
      get(d.level, d.variant).points.push({
        t: d.day, price: d.close ?? d.best_bid, lowest: d.lowest, median: d.median, bestBid: d.best_bid,
        sellers: Math.round(d.sellers), buyers: Math.round(d.buyers), quantity: Math.round(d.quantity),
      });
    }
  }
  for (const r of stmts.itemHistory.all(item, region, since) as unknown as PriceRow[]) {
    get(r.level, r.variant).points.push({
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

/**
 * Trades over time and time-to-sell by price band (relative to market at listing time), per variant.
 * Trades are per hour for ranges up to two days, per UTC day beyond that (`bucket`).
 */
export function velocity(item: string, region: string, days: number) {
  const since = Date.now() - days * DAY;
  const bucketMs = days <= 2 ? HOUR : DAY;
  const bucket = bucketMs === HOUR ? "hour" : "day";
  type Slot = { t: number; sold: number; bought: number; trades: number };
  type Out = {
    level: number; variant: string; bucket: string; trades: Slot[]; bands: any[]; medianHoursToSell: number | null;
  };
  const result = new Map<string, Out>();
  const get = (level: number, variant: string) => {
    const k = `${level}\u0000${variant}`;
    if (!result.has(k)) result.set(k, { level, variant, bucket, trades: [], bands: [], medianHoursToSell: null });
    return result.get(k)!;
  };

  const slots = new Map<string, Map<number, Slot>>();
  for (const r of stmts.itemSalesBuckets.all(item, region, since, bucketMs) as any[]) {
    get(r.level, r.variant);
    const k = `${r.level}\u0000${r.variant}`;
    const bySlot = slots.get(k) ?? slots.set(k, new Map()).get(k)!;
    const d = bySlot.get(r.slot) ?? { t: r.slot * bucketMs, sold: 0, bought: 0, trades: 0 };
    if (r.side === "sell") d.sold += r.units;
    else d.bought += r.units;
    d.trades += r.trades;
    bySlot.set(r.slot, d);
  }
  for (const [k, bySlot] of slots) result.get(k)!.trades = [...bySlot.values()];

  const outcomes = new Map<string, any[]>();
  for (const l of stmts.listingOutcomes.all(item, region, since) as any[]) {
    get(l.level, l.variant);
    l.market = capAtShop(l.market, item, l.level, l.variant);
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
      // 'pending' listings haven't resolved yet, so they count as still up.
      const pulled = inBand.filter((l) => l.closed_at != null && !["gone", "pending"].includes(l.close_reason)).length;
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

export type DealKind = "npc" | "underpriced" | "flip";

interface Where {
  merchant: string;
  region: string;
  server: string;
  map: string;
  x: number;
  y: number;
  merchantSeenAt: number;
}

export interface Deal {
  kind: DealKind;
  item: string;
  name: string;
  level: number;
  variant: string;
  flags: string;
  /** Price to buy one unit from the seller. */
  price: number;
  /** What a unit is worth: NPC sell value, cheapest competing ask, or the buyer's bid. */
  reference: number;
  profitPerUnit: number;
  /** Price as a share below the reference (0.25 = 25% under). */
  discount: number;
  quantity: number;
  totalProfit: number;
  /** Merchants selling this item/level/variant (underpriced deals). */
  sellers: number | null;
  /** Who sells: a player merchant, or an NPC shop (flips where the shop is the cheapest source). */
  source: "merchant" | "npc";
  /** For an NPC shop: region/server are "", listedAt is null and merchantSeenAt is the time of the request. */
  seller: Where & { listedAt: number | null };
  /** Flips only: the buy order to sell into. */
  buyer: (Where & { price: number; quantity: number }) | null;
}

export interface DealOptions {
  kinds: DealKind[];
  minDiscount: number;
  minSellers: number;
  minProfit: number;
  sort: "profit" | "discount";
  limit: number;
}

function where(l: any): Where {
  return {
    merchant: l.merchant, region: l.server_region, server: l.server_identifier, map: l.map, x: l.x, y: l.y,
    merchantSeenAt: l.last_seen,
  };
}

// Cached per option set until the next poll; bounded since options come from public query strings.
const dealCache = new Map<string, Deal[]>();
let dealCachePoll: number | null = null;

/**
 * Buyable listings from merchants seen within FRESH_HOURS that are worth more elsewhere:
 * - npc: an NPC pays more than the asking price (gifted items pay 1, temporary ones 1/8).
 * - underpriced: at least minDiscount under the cheapest competing ask or NPC shop price (what you
 *   could relist at), for items with at least minSellers merchants selling. A resale estimate.
 * - flip: someone's buy order pays more than the cheapest source: another merchant's ask, or an NPC
 *   shop (merchant asks above the shop price are skipped; the shop is the better source).
 */
export function deals(region: string, opts: DealOptions): Deal[] {
  const cacheKey = `${region}|${JSON.stringify(opts)}`;
  const { id } = lastPoll();
  if (id !== dealCachePoll || dealCache.size > 200) {
    dealCache.clear();
    dealCachePoll = id;
  }
  const hit = dealCache.get(cacheKey);
  if (hit) return hit;

  const listings = stmts.freshListings.all(Date.now() - config.freshHours * HOUR, region) as any[];
  const names = getGameMeta().items;
  const out: Deal[] = [];
  const make = (kind: DealKind, l: any, reference: number, quantity: number, extra: Partial<Deal> = {}): Deal => ({
    kind,
    item: l.item,
    name: names[l.item]?.name ?? l.item,
    level: l.level,
    variant: l.variant,
    flags: l.flags,
    price: l.price,
    reference,
    profitPerUnit: reference - l.price,
    discount: 1 - l.price / reference,
    quantity,
    totalProfit: (reference - l.price) * quantity,
    sellers: null,
    source: "merchant",
    seller: { ...where(l), listedAt: l.first_seen },
    buyer: null,
    ...extra,
  });

  // Identical listings from one merchant (six belts at the same price) are one deal with their quantities summed.
  const merged = new Map<string, any>();
  for (const l of listings) {
    if (l.side !== "sell") continue;
    const k = `${l.merchant}\u0000${key(l)}\u0000${l.price}\u0000${l.flags}`;
    const m = merged.get(k);
    if (m) m.quantity += l.quantity;
    else merged.set(k, { ...l });
  }
  const sells = [...merged.values()];
  if (opts.kinds.includes("npc")) {
    for (const l of sells) {
      const npc = npcSellValue(l.item, l.level, l.flags);
      if (npc > l.price) out.push(make("npc", l, npc, l.quantity));
    }
  }
  if (opts.kinds.includes("underpriced")) {
    // Each merchant's cheapest ask per item/level/variant.
    const asks = new Map<string, Map<string, number>>();
    for (const l of sells) {
      const byMerchant = asks.get(key(l)) ?? asks.set(key(l), new Map()).get(key(l))!;
      byMerchant.set(l.merchant, Math.min(l.price, byMerchant.get(l.merchant) ?? Infinity));
    }
    for (const l of sells) {
      const byMerchant = asks.get(key(l))!;
      if (byMerchant.size < opts.minSellers) continue;
      let competing = npcShopPrice(l.item, l.level, l.variant) ?? Infinity;
      for (const [m, price] of byMerchant) if (m !== l.merchant) competing = Math.min(competing, price);
      if (l.price <= competing * (1 - opts.minDiscount)) {
        out.push(make("underpriced", l, competing, l.quantity, { sellers: byMerchant.size }));
      }
    }
  }
  if (opts.kinds.includes("flip")) {
    const bids = new Map<string, any[]>();
    for (const b of listings) if (b.side === "buy") (bids.get(key(b)) ?? bids.set(key(b), []).get(key(b))!).push(b);
    for (const l of sells) {
      const shop = npcShopPrice(l.item, l.level, l.variant);
      if (shop != null && l.price >= shop) continue;
      // The best bid from anyone but the seller themselves.
      const best = (bids.get(key(l)) ?? [])
        .filter((b) => b.merchant !== l.merchant && b.price > l.price)
        .sort((a, b) => b.price - a.price)[0];
      if (!best) continue;
      const quantity = Math.min(l.quantity, best.quantity);
      out.push(make("flip", l, best.price, quantity, {
        buyer: { ...where(best), price: best.price, quantity: best.quantity },
      }));
    }
    // Buy orders paying more than an NPC shop charges: buy from the shop, sell into the order.
    const now = Date.now();
    for (const orders of bids.values()) {
      const best = [...orders].sort((a, b) => b.price - a.price)[0];
      const shopItem = names[best.item]?.npcShop;
      const shop = npcShopPrice(best.item, best.level, best.variant);
      if (shop == null || !shopItem || best.price <= shop) continue;
      const npc = {
        item: best.item, level: best.level, variant: best.variant, flags: "", price: shop, merchant: shopItem.npc,
        server_region: "", server_identifier: "", map: shopItem.map, x: shopItem.x, y: shopItem.y,
        last_seen: now, first_seen: null,
      };
      out.push(make("flip", npc, best.price, best.quantity, {
        source: "npc",
        buyer: { ...where(best), price: best.price, quantity: best.quantity },
      }));
    }
  }

  const result = out
    .filter((d) => d.profitPerUnit >= opts.minProfit)
    .sort((a, b) => (opts.sort === "discount" ? b.discount - a.discount : 0) || b.totalProfit - a.totalProfit)
    .slice(0, opts.limit);
  dealCache.set(cacheKey, result);
  return result;
}

const DEAL_KINDS: DealKind[] = ["npc", "underpriced", "flip"];

/** Parses deal query parameters (shared by the UI and public endpoints), clamping to sane ranges. */
export function dealOptions(q: (name: string) => string | undefined): DealOptions {
  const num = (name: string, fallback: number, min: number, max: number) => {
    const n = Number(q(name));
    return q(name) !== undefined && q(name) !== "" && Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
  };
  const kinds = (q("kind") ?? "").split(",").filter((k): k is DealKind => DEAL_KINDS.includes(k as DealKind));
  return {
    kinds: kinds.length ? kinds : DEAL_KINDS,
    minDiscount: num("min_discount", 0.2, 0, 0.99),
    minSellers: num("min_sellers", 3, 1, 1000),
    minProfit: num("min_profit", 1, 0, 1e12),
    sort: q("sort") === "discount" ? "discount" : "profit",
    limit: num("limit", 100, 1, 500),
  };
}
