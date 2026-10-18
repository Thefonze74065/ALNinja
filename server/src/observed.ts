// Observed sales: ground truth reported by players' characters, which receive the game's "+$$" event
// for every stand trade within view. Used to show confirmed trades and to measure how accurate the
// sales inferred from ALData stand snapshots are.
import { db, transaction } from "./db.ts";
import { getGameMeta } from "./gamedata.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Coverage reports closer together than this extend the same interval (the snippet sends every 30s). */
const COVERAGE_GAP_MS = 2 * MINUTE;
/** An inferred sale is dated when ALData showed the change; the real trade was up to this much earlier. */
const DETECTION_LAG_MS = 15 * MINUTE;
/** ...and the reporter's report can be a little behind or ahead of that. */
const REPORT_SLACK_MS = 2 * MINUTE;

export interface ObservationReport {
  reporter: string;
  sentAt: number;
  region?: string;
  server?: string;
  map?: string;
  inView?: string[];
  sales?: {
    at: number;
    seller: string;
    buyer: string;
    slot?: string;
    filledBuyOrder?: boolean;
    item: { name: string; level?: number; p?: string | null; data?: string; q?: number; price: number };
  }[];
}

const stmts = {
  duplicate: db.prepare(`
    SELECT 1 FROM observed_sales WHERE merchant = ? AND counterparty = ? AND side = ? AND item = ? AND level = ?
      AND variant = ? AND price = ? AND quantity = ? AND at BETWEEN ? AND ? LIMIT 1`),
  insertSale: db.prepare(`
    INSERT INTO observed_sales (merchant, counterparty, side, item, level, variant, price, quantity, slot, region,
      server, map, at, reporter, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  openCoverage: db.prepare(`
    SELECT id FROM observer_coverage WHERE reporter = ? AND merchant = ? AND end >= ? ORDER BY end DESC LIMIT 1`),
  extendCoverage: db.prepare("UPDATE observer_coverage SET end = ? WHERE id = ?"),
  insertCoverage: db.prepare("INSERT INTO observer_coverage (reporter, merchant, start, end) VALUES (?, ?, ?, ?)"),
  observedSince: db.prepare("SELECT * FROM observed_sales WHERE at >= ? ORDER BY at"),
  observedRecent: db.prepare(`
    SELECT * FROM observed_sales WHERE (?1 IS NULL OR item = ?1) AND at >= ?2 AND (?3 = 'ALL' OR region = ?3)
    ORDER BY at DESC LIMIT ?4`),
  inferredSince: db.prepare(`
    SELECT s.*, l.close_reason FROM sales s JOIN listings l ON l.id = s.listing_id WHERE s.at >= ? ORDER BY s.at`),
  coverageSince: db.prepare("SELECT * FROM observer_coverage WHERE end >= ?"),
  listingNear: db.prepare(`
    SELECT close_reason, closed_at FROM listings WHERE merchant = ? AND item = ? AND level = ? AND variant = ? AND side = ?
      AND price = ? AND first_seen <= ? ORDER BY first_seen DESC LIMIT 1`),
  knownMerchant: db.prepare("SELECT 1 FROM merchants WHERE id = ?"),
};

// --- Validation -----------------------------------------------------------------------------------

const NAME = /^[A-Za-z0-9_]{1,40}$/;
const ITEM = /^[A-Za-z0-9_]{1,60}$/;
const CODE = /^[A-Za-z0-9_]{1,20}$/;
const int = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const num = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

/** Checks a report's shape; returns an error message or null. */
export function validateReport(body: unknown): string | null {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const r = body as ObservationReport;
  if (typeof r.reporter !== "string" || !NAME.test(r.reporter)) return "reporter: a character name";
  if (!num(r.sentAt, 0, 1e15)) return "sentAt: milliseconds since epoch";
  for (const f of ["region", "server", "map"] as const) {
    if (r[f] !== undefined && (typeof r[f] !== "string" || !CODE.test(r[f]!))) return `${f}: invalid`;
  }
  if (r.inView !== undefined) {
    if (!Array.isArray(r.inView) || r.inView.length > 500) return "inView: up to 500 names";
    if (!r.inView.every((n) => typeof n === "string" && NAME.test(n))) return "inView: character names";
  }
  if (r.sales !== undefined) {
    if (!Array.isArray(r.sales) || r.sales.length > 500) return "sales: up to 500 entries";
    for (const [i, s] of r.sales.entries()) {
      const bad = (m: string) => `sales[${i}].${m}`;
      if (!s || typeof s !== "object") return bad("must be an object");
      if (!num(s.at, 0, 1e15)) return bad("at: milliseconds since epoch");
      if (typeof s.seller !== "string" || !NAME.test(s.seller)) return bad("seller: a character name");
      if (typeof s.buyer !== "string" || !NAME.test(s.buyer)) return bad("buyer: a character name");
      if (s.slot !== undefined && (typeof s.slot !== "string" || !CODE.test(s.slot))) return bad("slot: invalid");
      const it = s.item;
      if (!it || typeof it !== "object" || typeof it.name !== "string" || !ITEM.test(it.name)) return bad("item.name");
      if (it.level !== undefined && !int(it.level, 0, 30)) return bad("item.level");
      if (!int(it.price, 1, 1e13)) return bad("item.price: a whole number of gold");
      if (it.q !== undefined && !int(it.q, 1, 1e7)) return bad("item.q");
      for (const f of ["p", "data"] as const) {
        if (it[f] != null && (typeof it[f] !== "string" || !CODE.test(it[f]!))) return bad(`item.${f}`);
      }
    }
  }
  return null;
}

// --- Ingestion ------------------------------------------------------------------------------------

/**
 * Stores one report: new observed sales (de-duplicated across reporters) and coverage of the
 * merchants in view. Times are shifted by the reporter's clock skew (receivedAt - sentAt).
 */
export function recordReport(r: ObservationReport, receivedAt: number) {
  const skew = receivedAt - r.sentAt;
  let stored = 0;
  let duplicates = 0;
  transaction(() => {
    for (const s of r.sales ?? []) {
      // "+$$" from a filled buy order names the stand owner as buyer; from a stand purchase, as seller.
      const side = s.filledBuyOrder ? "buy" : "sell";
      const merchant = s.filledBuyOrder ? s.buyer : s.seller;
      const counterparty = s.filledBuyOrder ? s.seller : s.buyer;
      const level = s.item.level ?? 0;
      const variant = [s.item.p, s.item.data].filter((v) => typeof v === "string" && v).join("/");
      const quantity = s.item.q ?? 1;
      const at = Math.round(s.at + skew);
      if (stmts.duplicate.get(merchant, counterparty, side, s.item.name, level, variant, s.item.price, quantity,
        at - MINUTE, at + MINUTE)) {
        duplicates++;
        continue;
      }
      stmts.insertSale.run(merchant, counterparty, side, s.item.name, level, variant, s.item.price, quantity,
        s.slot ?? null, r.region ?? null, r.server ?? null, r.map ?? null, at, r.reporter, receivedAt);
      stored++;
    }
    const seenAt = Math.round(r.sentAt + skew);
    for (const merchant of new Set(r.inView ?? [])) {
      const open = stmts.openCoverage.get(r.reporter, merchant, seenAt - COVERAGE_GAP_MS) as { id: number } | undefined;
      if (open) stmts.extendCoverage.run(seenAt, open.id);
      else stmts.insertCoverage.run(r.reporter, merchant, seenAt, seenAt);
    }
  });
  return { stored, duplicates, inView: r.inView?.length ?? 0 };
}

// --- Matching inferred sales against observed ones ------------------------------------------------

interface Observed {
  id: number; merchant: string; counterparty: string; side: string; item: string; level: number; variant: string;
  price: number; quantity: number; region: string | null; server: string | null; at: number;
}
export interface Inferred {
  id: number; listing_id: number; merchant: string; side: string; item: string; level: number; variant: string;
  region: string | null; price: number; quantity: number; listed_at: number; at: number; close_reason?: string;
}

const goodsKey = (s: { merchant: string; side: string; item: string; level: number; variant: string; price: number }) =>
  `${s.merchant}\u0000${s.side}\u0000${s.item}\u0000${s.level}\u0000${s.variant}\u0000${s.price}`;

/**
 * Pairs observed trades with inferred sales of the same goods at the same price by the same merchant.
 * An inferred sale is dated when ALData showed the change, so it can follow the real trade by up to
 * DETECTION_LAG_MS, and it can bundle several trades (quantity drops between polls). Units are
 * allocated greedily in time order.
 */
function match(observed: Observed[], inferred: Inferred[]) {
  const pool = new Map<string, { s: Inferred; left: number }[]>();
  for (const s of inferred) {
    const k = goodsKey(s);
    (pool.get(k) ?? pool.set(k, []).get(k)!).push({ s, left: s.quantity });
  }
  const matchedUnits = new Map<number, number>(); // observed id -> units matched
  const usedUnits = new Map<number, number>(); // inferred id -> units matched
  for (const o of observed) {
    let need = o.quantity;
    for (const c of pool.get(goodsKey(o)) ?? []) {
      if (need === 0) break;
      if (c.left === 0 || c.s.at < o.at - REPORT_SLACK_MS || c.s.at > o.at + DETECTION_LAG_MS) continue;
      const take = Math.min(need, c.left);
      c.left -= take;
      need -= take;
      matchedUnits.set(o.id, (matchedUnits.get(o.id) ?? 0) + take);
      usedUnits.set(c.s.id, (usedUnits.get(c.s.id) ?? 0) + take);
    }
  }
  return { matchedUnits, usedUnits };
}

/** True when some reporter had the merchant in view for the stretch in which an inferred sale happened. */
function covered(coverage: Map<string, { start: number; end: number }[]>, merchant: string, at: number) {
  return (coverage.get(merchant) ?? []).some((c) => c.start <= at - DETECTION_LAG_MS && c.end >= at - REPORT_SLACK_MS);
}

/** Why an observed trade wasn't matched: what our listing for those goods ended up as. */
function missReason(o: Observed): string {
  if (!stmts.knownMerchant.get(o.merchant)) return "merchant not in ALData";
  const l = stmts.listingNear.get(o.merchant, o.item, o.level, o.variant, o.side, o.price, o.at + DETECTION_LAG_MS) as
    { close_reason: string | null; closed_at: number | null } | undefined;
  if (!l) return "listing never seen";
  if (l.close_reason == null) return "still listed (change not seen)";
  if (l.close_reason === "pending") return "awaiting confirmation";
  if (l.close_reason === "gone") return "sold, but timing didn't line up";
  return `closed as ${l.close_reason}`;
}

const pct = (a: number, b: number) => (b ? a / b : null);

/** Accuracy of inferred sales against observed trades over the last `days`. */
export function accuracy(days: number) {
  const since = Date.now() - days * DAY;
  const observed = stmts.observedSince.all(since) as unknown as Observed[];
  // Inferred sales can trail observed ones by DETECTION_LAG_MS, so look a little further back for them.
  const inferred = (stmts.inferredSince.all(since - DETECTION_LAG_MS) as unknown as Inferred[]);
  const coverage = new Map<string, { start: number; end: number }[]>();
  let coveredMs = 0;
  const reporters = new Set<string>();
  for (const c of stmts.coverageSince.all(since) as { reporter: string; merchant: string; start: number; end: number }[]) {
    (coverage.get(c.merchant) ?? coverage.set(c.merchant, []).get(c.merchant)!).push(c);
    coveredMs += c.end - Math.max(c.start, since);
    reporters.add(c.reporter);
  }

  const { matchedUnits, usedUnits } = match(observed, inferred);
  const tracked = observed.filter((o) => stmts.knownMerchant.get(o.merchant));
  const observedUnits = tracked.reduce((a, o) => a + o.quantity, 0);
  const caughtUnits = tracked.reduce((a, o) => a + (matchedUnits.get(o.id) ?? 0), 0);

  const checkable = inferred.filter((s) => s.at >= since && covered(coverage, s.merchant, s.at));
  const checkableUnits = checkable.reduce((a, s) => a + s.quantity, 0);
  const confirmedUnits = checkable.reduce((a, s) => a + (usedUnits.get(s.id) ?? 0), 0);

  const names = getGameMeta().items;
  const missed = tracked
    .filter((o) => (matchedUnits.get(o.id) ?? 0) < o.quantity)
    .map((o) => ({ ...o, name: names[o.item]?.name ?? o.item, reason: missReason(o) }));
  const reasons: Record<string, number> = {};
  for (const m of missed) reasons[m.reason] = (reasons[m.reason] ?? 0) + 1;
  const falsePositives = checkable
    .filter((s) => (usedUnits.get(s.id) ?? 0) < s.quantity)
    .map((s) => ({
      merchant: s.merchant, side: s.side, item: s.item, name: names[s.item]?.name ?? s.item, level: s.level,
      variant: s.variant, price: s.price, quantity: s.quantity, unconfirmed: s.quantity - (usedUnits.get(s.id) ?? 0),
      listedAt: s.listed_at, at: s.at,
    }));

  return {
    days,
    reporters: reporters.size,
    merchantHoursObserved: coveredMs / HOUR,
    observed: { trades: observed.length, units: observed.reduce((a, o) => a + o.quantity, 0), untracked: observed.length - tracked.length },
    /** Share of observed units (at merchants ALData tracks) that we also inferred. */
    recall: pct(caughtUnits, observedUnits),
    /** Share of inferred units, at merchants a reporter was watching, that were really traded. */
    precision: pct(confirmedUnits, checkableUnits),
    checkable: { sales: checkable.length, units: checkableUnits },
    missedReasons: reasons,
    missed: missed.slice(-50).reverse(),
    falsePositives: falsePositives.slice(-50).reverse(),
  };
}

/**
 * Recent trades (for one item, or all with null): every observed trade (source "observed", with the
 * counterparty), plus inferred sales that no observed trade accounts for (source "estimated").
 */
export function mergedTrades(item: string | null, region: string, since: number, inferred: Inferred[], limit: number) {
  const observed = (stmts.observedRecent.all(item, since - DETECTION_LAG_MS, region, 5000) as unknown as Observed[])
    .reverse();
  const { usedUnits } = match(observed, [...inferred].sort((a, b) => a.at - b.at));
  const rows = [
    ...observed.filter((o) => o.at >= since).map((o) => ({
      source: "observed" as const, item: o.item, side: o.side, level: o.level, variant: o.variant, price: o.price,
      quantity: o.quantity, merchant: o.merchant, counterparty: o.counterparty as string | null, region: o.region,
      listedAt: null as number | null, at: o.at,
    })),
    ...inferred
      .filter((s) => (usedUnits.get(s.id) ?? 0) < s.quantity)
      .map((s) => ({
        source: "estimated" as const, item: s.item, side: s.side, level: s.level, variant: s.variant, price: s.price,
        quantity: s.quantity - (usedUnits.get(s.id) ?? 0), merchant: s.merchant, counterparty: null,
        region: s.region, listedAt: s.listed_at as number | null, at: s.at,
      })),
  ];
  return rows.sort((a, b) => b.at - a.at).slice(0, limit);
}
