import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fetchMerchants, type Merchant, type MerchantSlot } from "./aldata.ts";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";

const HOUR = 3_600_000;

interface Offer {
  slot: string;
  side: "sell" | "buy";
  item: string;
  level: number;
  variant: string;
  price: number;
  quantity: number;
}

interface OpenListing extends Offer {
  id: number;
}

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
  };
}

const sameOffer = (a: Offer, b: Offer) =>
  a.slot === b.slot && a.side === b.side && a.item === b.item &&
  a.level === b.level && a.variant === b.variant;

const stmts = {
  getMerchant: db.prepare("SELECT last_seen FROM merchants WHERE id = ?"),
  upsertMerchant: db.prepare(`
    INSERT INTO merchants (id, server_region, server_identifier, map, x, y, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (id) DO UPDATE SET server_region = excluded.server_region,
      server_identifier = excluded.server_identifier, map = excluded.map,
      x = excluded.x, y = excluded.y, last_seen = excluded.last_seen`),
  openListings: db.prepare(`
    SELECT id, slot, side, item, level, variant, price, quantity
    FROM listings WHERE merchant = ? AND closed_at IS NULL`),
  touch: db.prepare("UPDATE listings SET last_seen = ?, quantity = ? WHERE id = ?"),
  close: db.prepare("UPDATE listings SET closed_at = ?, close_reason = ? WHERE id = ?"),
  insert: db.prepare(`
    INSERT INTO listings (merchant, slot, side, item, level, variant, price, quantity, initial_quantity,
      server_region, server_identifier, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  staleMerchants: db.prepare(`
    SELECT DISTINCT m.id, m.last_seen FROM merchants m
    JOIN listings l ON l.merchant = m.id AND l.closed_at IS NULL`),
  freshOpen: db.prepare(`
    SELECT l.merchant, l.side, l.item, l.level, l.variant, l.price, l.quantity
    FROM listings l JOIN merchants m ON m.id = l.merchant
    WHERE l.closed_at IS NULL AND m.last_seen >= ?`),
  clearBucket: db.prepare("DELETE FROM price_history WHERE bucket = ?"),
  insertPrice: db.prepare(`
    INSERT INTO price_history (item, level, variant, bucket, sell_min, sell_p25, sell_median, buy_max,
      sell_count, buy_count, sell_qty)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  logPoll: db.prepare(`
    INSERT INTO polls (fetched_at, merchants, updated, opened, closed, error) VALUES (?, ?, ?, ?, ?, ?)`),
};

/** Reconciles one merchant's current stand against its open listings. */
function syncMerchant(m: Merchant, stats: { updated: number; opened: number; closed: number }) {
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

  const unmatched = new Set(current);
  for (const listing of open) {
    const match = current.find((o) => unmatched.has(o) && sameOffer(o, listing) && o.price === listing.price);
    if (match) {
      unmatched.delete(match);
      stmts.touch.run(seen, match.quantity, listing.id);
    } else {
      const repriced = current.some((o) => sameOffer(o, listing));
      stmts.close.run(seen, repriced ? "repriced" : "gone", listing.id);
      stats.closed++;
    }
  }
  for (const o of unmatched) {
    stmts.insert.run(m.id, o.slot, o.side, o.item, o.level, o.variant, o.price, o.quantity, o.quantity,
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
 * a dozen slots at a silly price can't drag the quartiles around.
 */
export function recomputePrices(now = Date.now()) {
  const rows = stmts.freshOpen.all(now - config.freshHours * HOUR) as unknown as (Offer & { merchant: string })[];
  const groups = new Map<string, { key: Offer; sell: Map<string, number>; buy: Map<string, number>; qty: number }>();
  for (const r of rows) {
    const k = `${r.item}\u0000${r.level}\u0000${r.variant}`;
    let g = groups.get(k);
    if (!g) groups.set(k, (g = { key: r, sell: new Map(), buy: new Map(), qty: 0 }));
    if (r.side === "sell") {
      g.sell.set(r.merchant, Math.min(r.price, g.sell.get(r.merchant) ?? Infinity));
      g.qty += r.quantity;
    } else {
      g.buy.set(r.merchant, Math.max(r.price, g.buy.get(r.merchant) ?? 0));
    }
  }

  const bucket = Math.floor(now / HOUR) * HOUR;
  stmts.clearBucket.run(bucket);
  for (const g of groups.values()) {
    const { key, qty } = g;
    const sell = [...g.sell.values()].sort((a, b) => a - b);
    const buy = [...g.buy.values()];
    stmts.insertPrice.run(key.item, key.level, key.variant, bucket,
      sell.length ? sell[0] : null,
      sell.length ? quantile(sell, 0.25) : null,
      sell.length ? quantile(sell, 0.5) : null,
      buy.length ? Math.max(...buy) : null,
      sell.length, buy.length, qty);
  }
  return groups.size;
}

function archive(raw: string, at: Date) {
  const iso = at.toISOString();
  const dir = path.join(config.rawDir, iso.slice(0, 10));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${iso.slice(11, 19).replaceAll(":", "-")}.json.gz`), zlib.gzipSync(raw));
}

export async function poll() {
  const now = new Date();
  try {
    const { merchants, raw } = await fetchMerchants();
    if (config.archiveRaw) archive(raw, now);

    const stats = { updated: 0, opened: 0, closed: 0 };
    const keys = transaction(() => {
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

      const keys = recomputePrices(now.getTime());
      stmts.logPoll.run(now.getTime(), merchants.length, stats.updated, stats.opened, stats.closed, null);
      return keys;
    });
    console.log(`[poll] ${merchants.length} merchants (${stats.updated} updated), ` +
      `+${stats.opened}/-${stats.closed} listings, ${keys} priced items`);
  } catch (err) {
    const msg = (err as Error).message;
    console.error(`[poll] failed: ${msg}`);
    stmts.logPoll.run(now.getTime(), null, null, null, null, msg);
  }
}
