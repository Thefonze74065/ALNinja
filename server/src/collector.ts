import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fetchMerchants, type Merchant, type MerchantSlot } from "./aldata.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";
import { capAtShop, npcShopPrice } from "./gamedata.ts";

const HOUR = 3_600_000;

interface Offer {
  slot: string;
  side: "sell" | "buy";
  item: string;
  level: number;
  variant: string;
  price: number;
  quantity: number;
  /** Comma-separated: 'gift' (NPCs pay 1 gold), 'expires' (NPCs pay 1/8). Not part of the price key. */
  flags: string;
}

interface OpenListing extends Offer {
  id: number;
  first_seen: number;
}

interface PendingListing extends OpenListing {
  closed_at: number;
  server_region: string | null;
}

/**
 * How long a vanished listing waits before counting as sold. Merchants take stock down and put it back
 * (restocking, repricing) across separate updates; if the same goods return within this window it was
 * a withdrawal or reprice, not a sale.
 */
export const SALE_CONFIRM_MS = 2 * HOUR;

export type Stats = { updated: number; opened: number; closed: number; sales: number };

/** Turns a raw merchant slot into a priced offer, or null if it shouldn't count toward prices. */
export function toOffer(slot: string, s: MerchantSlot | null): Offer | null {
  if (!s || typeof s.name !== "string") return null;
  if (s.giveaway || s.want) return null;
  if (typeof s.price !== "number" || !Number.isFinite(s.price) || s.price <= 0) return null;
  return {
    slot,
    side: s.b ? "buy" : "sell",
    item: s.name,
    level: s.level ?? 0,
    variant: [s.p, s.data].filter((v) => typeof v === "string" && v).join("/"),
    price: Math.round(s.price),
    quantity: s.q ?? 1,
    flags: [s.gift && "gift", s.expires && "expires"].filter(Boolean).join(","),
  };
}

const sameGoods = (a: Offer, b: Offer) =>
  a.side === b.side && a.item === b.item && a.level === b.level && a.variant === b.variant && a.flags === b.flags;
const sameOffer = (a: Offer, b: Offer) => a.slot === b.slot && sameGoods(a, b);

const stmts = {
  getMerchant: db.prepare("SELECT last_seen FROM merchants WHERE id = ?"),
  upsertMerchant: db.prepare(`
    INSERT INTO merchants (id, server_region, server_identifier, map, x, y, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET server_region = excluded.server_region,
      server_identifier = excluded.server_identifier, map = excluded.map,
      x = excluded.x, y = excluded.y, last_seen = excluded.last_seen`),
  openListings: db.prepare(`
    SELECT id, slot, side, item, level, variant, price, quantity, flags, first_seen
    FROM listings WHERE merchant = ? AND closed_at IS NULL`),
  touch: db.prepare("UPDATE listings SET last_seen = ?, quantity = ?, slot = ? WHERE id = ?"),
  // The last completed hour's market price (see plausibleTrade).
  marketPrice: db.prepare(`
    SELECT sell_p25 FROM price_history WHERE item = ? AND region = 'ALL' AND level = ? AND variant = ? AND bucket < ?
    ORDER BY bucket DESC LIMIT 1`),
  pendingFor: db.prepare(`
    SELECT id, slot, side, item, level, variant, price, quantity, flags, first_seen, closed_at, server_region
    FROM listings WHERE merchant = ? AND close_reason = 'pending' AND closed_at >= ? ORDER BY closed_at DESC`),
  duePending: db.prepare(`
    SELECT id, merchant, slot, side, item, level, variant, price, quantity, flags, first_seen, closed_at, server_region
    FROM listings WHERE close_reason = 'pending' AND closed_at < ? ORDER BY closed_at, id`),
  setReason: db.prepare("UPDATE listings SET close_reason = ? WHERE id = ?"),
  insertSale: db.prepare(`
    INSERT INTO sales (listing_id, merchant, side, item, level, variant, region, price, quantity, listed_at, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  close: db.prepare("UPDATE listings SET closed_at = ?, close_reason = ? WHERE id = ?"),
  insert: db.prepare(`
    INSERT INTO listings (merchant, slot, side, item, level, variant, flags, price, quantity, initial_quantity,
      server_region, server_identifier, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  staleMerchants: db.prepare(`
    SELECT DISTINCT m.id, m.last_seen FROM merchants m
    JOIN listings l ON l.merchant = m.id AND l.closed_at IS NULL`),
  freshOpen: db.prepare(`
    SELECT l.merchant, m.server_region AS region, l.side, l.item, l.level, l.variant, l.price, l.quantity
    FROM listings l JOIN merchants m ON m.id = l.merchant
    WHERE l.closed_at IS NULL AND m.last_seen >= ?`),
  clearBucket: db.prepare("DELETE FROM price_history WHERE bucket = ?"),
  insertPrice: db.prepare(`
    INSERT INTO price_history (item, region, level, variant, bucket, sell_min, sell_p25, sell_median, buy_max,
      sell_count, buy_count, sell_qty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  logPoll: db.prepare(`
    INSERT INTO polls (fetched_at, merchants, updated, opened, closed, error) VALUES (?, ?, ?, ?, ?, ?)`),
};

/**
 * Stands are also used as storage: items parked at absurd prices, or lowball buy orders, get pulled
 * without ever trading. Only offers priced near the market count as sales.
 */
export const PLACEHOLDER_PRICE = 1e10;
export const PLAUSIBLE_MARKUP = 3;
/**
 * Judges against the market as of the last completed hour (before `at`'s hour). The current hour's row
 * is rewritten by every poll; ignoring it means ingesting doesn't depend on mid-hour price updates,
 * which is what lets a rebuild recompute prices once per hour and still match live polling exactly.
 */
function plausibleTrade(l: Offer, at: number): boolean {
  const hour = Math.floor(at / HOUR) * HOUR;
  const p25 = (stmts.marketPrice.get(l.item, l.level, l.variant, hour) as { sell_p25: number | null } | undefined)
    ?.sell_p25 ?? null;
  // Nobody pays a player more than an NPC shop charges.
  const market = p25 == null ? npcShopPrice(l.item, l.level, l.variant) : capAtShop(p25, l.item, l.level, l.variant);
  if (!market) return l.price < PLACEHOLDER_PRICE;
  return l.side === "sell" ? l.price <= market * PLAUSIBLE_MARKUP : l.price >= market / PLAUSIBLE_MARKUP;
}

/** Reconciles one merchant's current stand against its open listings, recording estimated sales. */
function syncMerchant(m: Merchant, stats: Stats) {
  const seen = Date.parse(m.lastSeen);
  const prev = stmts.getMerchant.get(m.id) as { last_seen: number } | undefined;
  stmts.upsertMerchant.run(m.id, m.serverRegion, m.serverIdentifier, m.map, m.x, m.y, seen);
  // ALData hasn't received anything new for this merchant since our last poll.
  if (prev && prev.last_seen >= seen) return;
  stats.updated++;

  const current = Object.entries(m.slots ?? {})
    .map(([slot, s]) => toOffer(slot, s))
    .filter((o): o is Offer => o !== null);
  const open = stmts.openListings.all(m.id) as unknown as OpenListing[];

  const sale = (l: OpenListing, quantity: number, at = seen) => {
    stmts.insertSale.run(l.id, m.id, l.side, l.item, l.level, l.variant, m.serverRegion, l.price, quantity,
      l.first_seen, at);
    stats.sales++;
  };
  const unmatched = new Set(current);
  const take = (match: (o: Offer) => boolean) => {
    const o = current.find((o) => unmatched.has(o) && match(o));
    if (o) unmatched.delete(o);
    return o;
  };
  const keep = (l: OpenListing, o: Offer) => {
    stmts.touch.run(seen, o.quantity, o.slot, l.id);
    if (o.quantity < l.quantity && plausibleTrade(l, seen)) sale(l, l.quantity - o.quantity);
  };

  // Same slot first, then the same goods at the same price moved to another slot.
  const unplaced: OpenListing[] = [];
  for (const l of open) {
    const o = take((o) => sameOffer(o, l) && o.price === l.price);
    if (o) keep(l, o);
    else unplaced.push(l);
  }
  const gone: OpenListing[] = [];
  for (const l of unplaced) {
    const o = take((o) => sameGoods(o, l) && o.price === l.price);
    if (o) keep(l, o);
    else gone.push(l);
  }

  // A stand that emptied completely was packed up, not sold out between two polls.
  const standClosed = current.length === 0 && gone.length >= 3;
  // New offers that already account for a vanished listing; each can explain only one.
  const relistings = new Set<Offer>();
  const relisting = (l: Offer) => current.find((o) => unmatched.has(o) && !relistings.has(o) && sameGoods(o, l));
  /** The same goods came back (`o`): a reprice, or a withdrawal if at the same price. A smaller stack sold the difference. */
  const resolveRelisted = (l: OpenListing, o: Offer, at: number) => {
    relistings.add(o);
    if (o.quantity < l.quantity && plausibleTrade(l, seen)) sale(l, l.quantity - o.quantity, at);
    return o.price === l.price ? "withdrawn" : "repriced";
  };

  for (const l of gone) {
    let reason: string;
    if (standClosed) reason = "withdrawn";
    else {
      const o = relisting(l);
      if (o) reason = resolveRelisted(l, o, seen);
      // Not back yet: wait SALE_CONFIRM_MS before calling it a sale (see confirmPendingSales).
      else reason = plausibleTrade(l, seen) ? "pending" : "withdrawn";
    }
    stmts.close.run(seen, reason, l.id);
    stats.closed++;
  }

  // Goods that vanished in an earlier update and are back now were taken down, not sold.
  for (const p of stmts.pendingFor.all(m.id, seen - SALE_CONFIRM_MS) as unknown as PendingListing[]) {
    const o = relisting(p);
    if (o) stmts.setReason.run(resolveRelisted(p, o, p.closed_at), p.id);
  }
  for (const o of unmatched) {
    stmts.insert.run(m.id, o.slot, o.side, o.item, o.level, o.variant, o.flags, o.price, o.quantity, o.quantity,
      m.serverRegion, m.serverIdentifier, seen, seen);
    stats.opened++;
  }
}

function quantile(sorted: number[], q: number): number {
  return sorted[Math.floor((sorted.length - 1) * q)];
}

/**
 * Rebuilds the current hour's price index from listings of recently seen merchants.
 * Each merchant counts once per item variant (its best offer), so one stand filling
 * a dozen slots at a silly price can't drag the quartiles around. Every offer feeds both
 * the 'ALL' index and the index for its merchant's current server region.
 */
export function recomputePrices(now: number) {
  const rows = stmts.freshOpen.all(now - config.freshHours * HOUR) as unknown as
    (Offer & { merchant: string; region: string | null })[];
  type Group = { key: Offer; region: string; sell: Map<string, number>; buy: Map<string, number>; qty: number };
  const groups = new Map<string, Group>();
  for (const r of rows) {
    for (const region of r.region ? ["ALL", r.region] : ["ALL"]) {
      const k = `${region}\u0000${r.item}\u0000${r.level}\u0000${r.variant}`;
      let g = groups.get(k);
      if (!g) groups.set(k, (g = { key: r, region, sell: new Map(), buy: new Map(), qty: 0 }));
      if (r.side === "sell") {
        g.sell.set(r.merchant, Math.min(r.price, g.sell.get(r.merchant) ?? Infinity));
        g.qty += r.quantity;
      } else {
        g.buy.set(r.merchant, Math.max(r.price, g.buy.get(r.merchant) ?? 0));
      }
    }
  }

  const bucket = Math.floor(now / HOUR) * HOUR;
  stmts.clearBucket.run(bucket);
  for (const g of groups.values()) {
    const { key, region, qty } = g;
    const sell = [...g.sell.values()].sort((a, b) => a - b);
    const buy = [...g.buy.values()];
    stmts.insertPrice.run(key.item, region, key.level, key.variant, bucket,
      sell.length ? sell[0] : null,
      sell.length ? quantile(sell, 0.25) : null,
      sell.length ? quantile(sell, 0.5) : null,
      buy.length ? Math.max(...buy) : null,
      sell.length, buy.length, qty);
  }
  return [...groups.values()].filter((g) => g.region === "ALL").length;
}

function archive(raw: string, at: Date) {
  const iso = at.toISOString();
  const dir = path.join(config.rawDir, iso.slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${iso.slice(11, 19).replaceAll(":", "-")}.json.gz`), zlib.gzipSync(raw));
}

/** Vanished listings that weren't put back within SALE_CONFIRM_MS are sales, dated when they vanished. */
function confirmPendingSales(at: number, stats: Stats) {
  for (const l of stmts.duePending.all(at - SALE_CONFIRM_MS) as unknown as (PendingListing & { merchant: string })[]) {
    stmts.setReason.run("gone", l.id);
    stmts.insertSale.run(l.id, l.merchant, l.side, l.item, l.level, l.variant, l.server_region, l.price, l.quantity,
      l.first_seen, l.closed_at);
    stats.sales++;
  }
}

/**
 * Applies one /merchants snapshot taken at `at` (ms). Deterministic given the database state and the
 * snapshot, so replaying the raw archive in order reproduces what live polling recorded.
 *
 * `prices: false` skips recomputing the hour's price index. Only the last snapshot of each hour
 * determines it, and nothing during ingest reads the current hour's prices, so a rebuild skips it for
 * all but each hour's last snapshot. Live polling always recomputes so the site stays current.
 */
export function ingest(merchants: Merchant[], at: number, { prices = true } = {}): Stats & { priced: number } {
  const stats: Stats = { updated: 0, opened: 0, closed: 0, sales: 0 };
  return transaction(() => {
    for (const m of merchants) syncMerchant(m, stats);

    // Merchants that dropped out of the feed (ALData only keeps a week) close their listings.
    const present = new Set(merchants.map((m) => m.id));
    for (const s of stmts.staleMerchants.all() as { id: string; last_seen: number }[]) {
      if (present.has(s.id)) continue;
      for (const l of stmts.openListings.all(s.id) as unknown as OpenListing[]) {
        stmts.close.run(s.last_seen, "expired", l.id);
        stats.closed++;
      }
    }

    confirmPendingSales(at, stats);
    const priced = prices ? recomputePrices(at) : 0;
    stmts.logPoll.run(at, merchants.length, stats.updated, stats.opened, stats.closed, null);
    return { ...stats, priced };
  });
}

export async function poll() {
  const now = new Date();
  try {
    const { merchants, raw } = await fetchMerchants();
    if (config.archiveRaw) archive(raw, now);
    const r = ingest(merchants, now.getTime());
    console.log(`[poll] ${merchants.length} merchants (${r.updated} updated), ` +
      `+${r.opened}/-${r.closed} listings, ${r.sales} sales, ${r.priced} priced items`);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[poll] failed: ${msg}`);
    stmts.logPoll.run(now.getTime(), null, null, null, null, msg);
  }
}
