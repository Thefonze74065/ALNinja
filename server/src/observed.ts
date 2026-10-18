// Observed sales: ground truth reported by players' characters, which receive the game's "+$$" event
// for every stand trade within view. Used to show confirmed trades and to measure how accurate the
// sales inferred from ALData stand snapshots are.
import { db, transaction } from "./db.ts";
import { getGameMeta } from "./gamedata.ts";
import { isRevoked } from "./keys.ts";

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
  /**
   * New entries of the reporter's own trade history (the game's trade_history): trades they took part
   * in, wherever they were. `event` is "sell" if the reporter gave the item, "buy" if they received it.
   */
  history?: {
    at: number;
    event: "buy" | "sell";
    counterparty: string;
    item: { name: string; level?: number; p?: string | null; data?: string; q?: number };
    total: number;
  }[];
}

/**
 * A report is verified when ALNinja saw that merchant offering those goods at that price around the time
 * (15 minutes either side, for ALData's refresh lag). Unverified reports are kept but don't count.
 */
const VERIFIED = `EXISTS (SELECT 1 FROM listings l WHERE l.merchant = o.merchant AND l.side = o.side AND l.item = o.item
  AND l.level = o.level AND l.variant = o.variant AND l.price = o.price AND l.first_seen <= o.at + 900000
  AND (l.closed_at IS NULL OR l.closed_at >= o.at - 900000))`;

/** Verified, and neither the reporting character nor whoever vouched for it is revoked. */
const usable = (o: { verified: number; reporter: string; key_owner: string }) =>
  Boolean(o.verified) && !isRevoked(o.reporter) && !isRevoked(o.key_owner);

const stmts = {
  // The same trade reported by another character (one character's snippet never reports a trade twice,
  // so identical trades from the same reporter are separate trades).
  duplicate: db.prepare(`
    SELECT 1 FROM observed_sales WHERE merchant = ? AND counterparty = ? AND side = ? AND item = ? AND level = ?
      AND variant = ? AND price = ? AND quantity = ? AND at BETWEEN ? AND ? AND reporter != ? LIMIT 1`),
  insertSale: db.prepare(`
    INSERT INTO observed_sales (merchant, counterparty, side, item, level, variant, price, quantity, slot, region,
      server, map, at, reporter, received_at, key_owner)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  openCoverage: db.prepare(`
    SELECT id FROM observer_coverage WHERE reporter = ? AND merchant = ? AND end >= ? ORDER BY end DESC LIMIT 1`),
  extendCoverage: db.prepare("UPDATE observer_coverage SET end = ? WHERE id = ?"),
  insertCoverage: db.prepare("INSERT INTO observer_coverage (reporter, merchant, start, end) VALUES (?, ?, ?, ?)"),
  observedSince: db.prepare(`SELECT o.*, ${VERIFIED} AS verified FROM observed_sales o WHERE o.at >= ? ORDER BY o.at`),
  observedRecent: db.prepare(`
    SELECT o.*, ${VERIFIED} AS verified FROM observed_sales o
    WHERE (?1 IS NULL OR o.item = ?1) AND o.at >= ?2 AND (?3 = 'ALL' OR o.region = ?3)
    ORDER BY o.at DESC LIMIT ?4`),
  listingAt: db.prepare(`
    SELECT 1 FROM listings WHERE merchant = ? AND side = ? AND item = ? AND level = ? AND variant = ? AND price = ?
      AND first_seen <= ? AND (closed_at IS NULL OR closed_at >= ?) LIMIT 1`),
  inferredSince: db.prepare(`
    SELECT s.*, l.close_reason FROM sales s JOIN listings l ON l.id = s.listing_id WHERE s.at >= ? ORDER BY s.at`),
  coverageSince: db.prepare("SELECT * FROM observer_coverage WHERE end >= ?"),
  // Listings that would have been estimated as sold, but a reporter watched and saw no trade.
  unsoldSince: db.prepare(`
    SELECT merchant, side, item, level, variant, price, quantity, first_seen AS listed_at, closed_at AS at
    FROM listings WHERE close_reason = 'unsold' AND closed_at >= ? ORDER BY closed_at`),
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
  if (r.history !== undefined) {
    if (!Array.isArray(r.history) || r.history.length > 100) return "history: up to 100 entries";
    for (const [i, h] of r.history.entries()) {
      const bad = (m: string) => `history[${i}].${m}`;
      if (!h || typeof h !== "object") return bad("must be an object");
      if (!num(h.at, 0, 1e15)) return bad("at: milliseconds since epoch");
      if (h.event !== "buy" && h.event !== "sell") return bad('event: "buy" or "sell"');
      if (typeof h.counterparty !== "string" || !NAME.test(h.counterparty)) return bad("counterparty: a character name");
      const it = h.item;
      if (!it || typeof it !== "object" || typeof it.name !== "string" || !ITEM.test(it.name)) return bad("item.name");
      if (it.level !== undefined && !int(it.level, 0, 30)) return bad("item.level");
      if (it.q !== undefined && !int(it.q, 1, 1e7)) return bad("item.q");
      for (const f of ["p", "data"] as const) {
        if (it[f] != null && (typeof it[f] !== "string" || !CODE.test(it[f]!))) return bad(`item.${f}`);
      }
      if (!int(h.total, 1, 1e15)) return bad("total: whole gold");
    }
  }
  return null;
}

// --- Ingestion ------------------------------------------------------------------------------------

/**
 * Stores one report: new observed sales (de-duplicated across reporters) and coverage of the
 * merchants in view. Times are shifted by the reporter's clock skew (receivedAt - sentAt).
 */
export function recordReport(r: ObservationReport, receivedAt: number, keyOwner = "admin") {
  const skew = receivedAt - r.sentAt;
  let stored = 0;
  let duplicates = 0;
  let unresolved = 0;
  const store = (
    merchant: string, counterparty: string, side: string, item: string, level: number, variant: string,
    price: number, quantity: number, slot: string | null, at: number,
  ) => {
    if (stmts.duplicate.get(merchant, counterparty, side, item, level, variant, price, quantity, at - 2 * MINUTE,
      at + 2 * MINUTE, r.reporter)) {
      duplicates++;
      return;
    }
    stmts.insertSale.run(merchant, counterparty, side, item, level, variant, price, quantity, slot, r.region ?? null,
      r.server ?? null, r.map ?? null, at, r.reporter, receivedAt, keyOwner);
    stored++;
  };
  transaction(() => {
    // The reporter's own trades. Each entry says whether they gave or got the item, not whose stand
    // it was: that's whichever party ALNinja saw offering it at that unit price.
    for (const h of r.history ?? []) {
      const level = h.item.level ?? 0;
      const variant = [h.item.p, h.item.data].filter((v) => typeof v === "string" && v).join("/");
      const quantity = h.item.q ?? 1;
      const price = Math.round(h.total / quantity);
      const at = Math.round(h.at + skew);
      const me = r.reporter;
      const them = h.counterparty;
      // [stand owner, side of their listing, other party] candidates, most likely first.
      const candidates: [string, "sell" | "buy", string][] = h.event === "sell"
        ? [[me, "sell", them], [them, "buy", me]] // I gave it: my stand sold, or I filled their buy order
        : [[them, "sell", me], [me, "buy", them]]; // I got it: I bought from their stand, or my buy order filled
      const hit = candidates.find(([owner, side]) =>
        stmts.listingAt.get(owner, side, h.item.name, level, variant, price, at + DETECTION_LAG_MS, at - DETECTION_LAG_MS));
      if (!hit) {
        unresolved++;
        continue;
      }
      store(hit[0], hit[2], hit[1], h.item.name, level, variant, price, quantity, null, at);
    }

    for (const s of r.sales ?? []) {
      // "+$$" from a filled buy order names the stand owner as buyer; from a stand purchase, as seller.
      const side = s.filledBuyOrder ? "buy" : "sell";
      const merchant = s.filledBuyOrder ? s.buyer : s.seller;
      const counterparty = s.filledBuyOrder ? s.seller : s.buyer;
      const level = s.item.level ?? 0;
      const variant = [s.item.p, s.item.data].filter((v) => typeof v === "string" && v).join("/");
      const quantity = s.item.q ?? 1;
      store(merchant, counterparty, side, s.item.name, level, variant, s.item.price, quantity, s.slot ?? null,
        Math.round(s.at + skew));
    }
    const seenAt = Math.round(r.sentAt + skew);
    // A reporter sending its trade history sees every trade at its own stand, wherever it stands.
    const watching = new Set(r.inView ?? []);
    if (r.history !== undefined) watching.add(r.reporter);
    for (const merchant of watching) {
      const open = stmts.openCoverage.get(r.reporter, merchant, seenAt - COVERAGE_GAP_MS) as { id: number } | undefined;
      if (open) stmts.extendCoverage.run(seenAt, open.id);
      else stmts.insertCoverage.run(r.reporter, merchant, seenAt, seenAt);
    }
  });
  return { stored, duplicates, unresolved, inView: r.inView?.length ?? 0 };
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
  const reported = stmts.observedSince.all(since) as unknown as (Observed & { verified: number; reporter: string; key_owner: string })[];
  const observed = reported.filter(usable);
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
  // Watched estimates that reporters refuted never became sales, but they count against the estimator.
  const unsold = stmts.unsoldSince.all(since) as unknown as Omit<Inferred, "id" | "listing_id" | "region">[];
  const checkableUnits = [...checkable, ...unsold].reduce((a, s) => a + s.quantity, 0);
  const confirmedUnits = checkable.reduce((a, s) => a + (usedUnits.get(s.id) ?? 0), 0);

  const names = getGameMeta().items;
  const missed = tracked
    .filter((o) => (matchedUnits.get(o.id) ?? 0) < o.quantity)
    .map((o) => ({ ...o, name: names[o.item]?.name ?? o.item, reason: missReason(o) }));
  const reasons: Record<string, number> = {};
  for (const m of missed) reasons[m.reason] = (reasons[m.reason] ?? 0) + 1;
  const falsePositives = [
    ...checkable.filter((s) => (usedUnits.get(s.id) ?? 0) < s.quantity)
      .map((s) => ({ ...s, unconfirmed: s.quantity - (usedUnits.get(s.id) ?? 0) })),
    ...unsold.map((s) => ({ ...s, unconfirmed: s.quantity })),
  ]
    .sort((a, b) => a.at - b.at)
    .map((s) => ({
      merchant: s.merchant, side: s.side, item: s.item, name: names[s.item]?.name ?? s.item, level: s.level,
      variant: s.variant, price: s.price, quantity: s.quantity, unconfirmed: s.unconfirmed,
      listedAt: s.listed_at, at: s.at,
    }));

  return {
    days,
    reporters: reporters.size,
    merchantHoursObserved: coveredMs / HOUR,
    observed: {
      trades: observed.length,
      units: observed.reduce((a, o) => a + o.quantity, 0),
      untracked: observed.length - tracked.length,
      /** Reports that didn't match any listing ALNinja saw (or came from revoked reporters): not counted. */
      unverified: reported.length - observed.length,
    },
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
  const observed = (stmts.observedRecent.all(item, since - DETECTION_LAG_MS, region, 5000) as unknown as
    (Observed & { verified: number; reporter: string; key_owner: string })[]).filter(usable).reverse();
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
