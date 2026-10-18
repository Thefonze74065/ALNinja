// Corrections: "this merchant's stock that vanished between these times wasn't sold". For one-off
// mistakes the estimation rules can't see, such as stock pulled while no reporter was watching. The
// admin can correct any merchant; a reporting key only its own character's stand. Corrections are
// stored, so rebuilds apply them too (collector.ts checks them whenever it would record a sale).
import { reexportSales } from "./archive.ts";
import { db, transaction } from "./db.ts";

const DAY = 86_400_000;
/** How far back a correction can reach, and how long a stretch it can cover. */
export const MAX_CORRECTION_DAYS = 30;

export interface Correction {
  merchant: string;
  item?: string | null;
  from: number;
  to: number;
  note?: string;
}

const stmts = {
  insert: db.prepare(`
    INSERT INTO corrections (merchant, item, from_at, to_at, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  affected: db.prepare(`
    SELECT id, listing_id, at FROM sales
    WHERE merchant = ?1 COLLATE NOCASE AND (?2 IS NULL OR item = ?2) AND at BETWEEN ?3 AND ?4`),
  deleteSale: db.prepare("DELETE FROM sales WHERE id = ?"),
  // A listing that vanished was "gone" (sold); a corrected one was withdrawn. Open ones only lose the sale.
  withdraw: db.prepare("UPDATE listings SET close_reason = 'withdrawn' WHERE id = ? AND close_reason = 'gone'"),
  recent: db.prepare(`
    SELECT id, merchant, item, from_at AS "from", to_at AS "to", note, created_by AS createdBy, created_at AS createdAt
    FROM corrections WHERE created_at >= ? ORDER BY created_at DESC LIMIT 200`),
};

const NAME = /^[A-Za-z0-9_]{1,40}$/;
const ITEM = /^[A-Za-z0-9_]{1,60}$/;

/** Why a correction is unacceptable, or null if fine. `owner` is "admin" or the key's character. */
export function correctionProblem(c: unknown, owner: string, now = Date.now()): string | null {
  if (!c || typeof c !== "object") return "body must be an object";
  const { merchant, item, from, to, note } = c as Record<string, unknown>;
  if (typeof merchant !== "string" || !NAME.test(merchant)) return "merchant: a character name";
  if (owner !== "admin" && merchant.toLowerCase() !== owner.toLowerCase()) {
    return "a reporting key can only correct its own character's stand";
  }
  if (item != null && (typeof item !== "string" || !ITEM.test(item))) return "item: an item name, or omit for all";
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return "from, to: epoch milliseconds";
  if ((from as number) > (to as number)) return "from must be before to";
  if ((to as number) > now) return "to can't be in the future";
  if ((from as number) < now - MAX_CORRECTION_DAYS * DAY) return `at most ${MAX_CORRECTION_DAYS} days back`;
  if (note != null && (typeof note !== "string" || note.length > 200)) return "note: up to 200 characters";
  return null;
}

/** Stores a correction and removes the sales it covers. Returns how many sales were removed. */
export function addCorrection(c: Correction, owner: string, now = Date.now()) {
  const days = new Set<number>();
  const removed = transaction(() => {
    stmts.insert.run(c.merchant, c.item ?? null, c.from, c.to, c.note ?? null, owner, now);
    const sales = stmts.affected.all(c.merchant, c.item ?? null, c.from, c.to) as { id: number; listing_id: number; at: number }[];
    for (const s of sales) {
      stmts.deleteSale.run(s.id);
      stmts.withdraw.run(s.listing_id);
      days.add(Math.floor(s.at / DAY) * DAY);
    }
    return sales.length;
  });
  for (const day of days) reexportSales(day);
  return { removedSales: removed };
}

export const recentCorrections = (days: number) => stmts.recent.all(Date.now() - days * DAY);
