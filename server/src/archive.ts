// Long-term storage: each completed UTC day's hourly prices and sales are written to gzipped CSV
// (kept forever, downloadable via /api/v1/archive), summarized into price_daily, and once older than
// HOURLY_RETENTION_DAYS the hourly rows leave the database.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { config } from "./config.ts";
import { db, transaction } from "./db.ts";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export const ARCHIVE_KINDS = ["prices", "sales"] as const;
export type ArchiveKind = (typeof ARCHIVE_KINDS)[number];

const COLUMNS: Record<ArchiveKind, string[]> = {
  prices: ["time", "bucket_ms", "item", "region", "level", "variant", "price", "lowest", "median", "best_bid",
    "sellers", "buyers", "quantity"],
  sales: ["time", "at_ms", "item", "level", "variant", "region", "side", "price", "quantity", "merchant",
    "listed_at_ms"],
};

const stmts = {
  firstBucket: db.prepare("SELECT MIN(bucket) AS t FROM price_history"),
  archived: db.prepare("SELECT 1 FROM archived_days WHERE day = ?"),
  markArchived: db.prepare("INSERT OR REPLACE INTO archived_days (day, exported_at) VALUES (?, ?)"),
  dayPrices: db.prepare(`
    SELECT bucket, item, region, level, variant, sell_p25, sell_min, sell_median, buy_max, sell_count, buy_count, sell_qty
    FROM price_history WHERE bucket >= ? AND bucket < ? ORDER BY bucket, item, region, level, variant`),
  daySales: db.prepare(`
    SELECT at, item, level, variant, region, side, price, quantity, merchant, listed_at
    FROM sales WHERE at >= ? AND at < ? ORDER BY at, id`),
  rollup: db.prepare(`
    INSERT OR REPLACE INTO price_daily
      (item, region, level, variant, day, close, low, high, median, lowest, best_bid, sellers, buyers, quantity, hours)
    SELECT item, region, level, variant, ?1,
      (SELECT p2.sell_p25 FROM price_history p2 WHERE p2.item = p.item AND p2.region = p.region
         AND p2.level = p.level AND p2.variant = p.variant AND p2.bucket >= ?1 AND p2.bucket < ?2
         ORDER BY p2.bucket DESC LIMIT 1),
      MIN(sell_p25), MAX(sell_p25),
      (SELECT p2.sell_median FROM price_history p2 WHERE p2.item = p.item AND p2.region = p.region
         AND p2.level = p.level AND p2.variant = p.variant AND p2.bucket >= ?1 AND p2.bucket < ?2
         ORDER BY p2.bucket DESC LIMIT 1),
      MIN(sell_min), MAX(buy_max), AVG(sell_count), AVG(buy_count), AVG(sell_qty), COUNT(*)
    FROM price_history p WHERE bucket >= ?1 AND bucket < ?2
    GROUP BY item, region, level, variant`),
  retire: db.prepare(`
    DELETE FROM price_history WHERE bucket < ?1
      AND (bucket / 86400000) * 86400000 IN (SELECT day FROM archived_days)`),
};

const csvCell = (v: unknown) => {
  if (v == null) return "";
  let s = String(v);
  // Spreadsheets run text starting with these as formulas; neutralize it (numbers are left alone).
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

export function archivePath(kind: ArchiveKind, day: number): string {
  const date = new Date(day).toISOString().slice(0, 10);
  return path.join(config.archiveDir, kind, date.slice(0, 4), `${date}.csv.gz`);
}

function writeCsv(kind: ArchiveKind, day: number, rows: unknown[][]) {
  const file = archivePath(kind, day);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = [COLUMNS[kind].join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";
  // Write then rename, so a crash never leaves a truncated file that looks complete.
  fs.writeFileSync(`${file}.tmp`, zlib.gzipSync(body));
  fs.renameSync(`${file}.tmp`, file);
}

/** Writes one day's hourly prices and sales to the CSV archive and marks the day done. */
export function exportDay(day: number) {
  const iso = (ms: number) => new Date(ms).toISOString();
  const prices = (stmts.dayPrices.all(day, day + DAY) as any[]).map((r) => [
    iso(r.bucket), r.bucket, r.item, r.region, r.level, r.variant, r.sell_p25 ?? r.buy_max, r.sell_min,
    r.sell_median, r.buy_max, r.sell_count, r.buy_count, r.sell_qty,
  ]);
  const sales = (stmts.daySales.all(day, day + DAY) as any[]).map((s) => [
    iso(s.at), s.at, s.item, s.level, s.variant, s.region, s.side, s.price, s.quantity, s.merchant, s.listed_at,
  ]);
  writeCsv("prices", day, prices);
  writeCsv("sales", day, sales);
  stmts.markArchived.run(day, Date.now());
}

/**
 * Archives and summarizes every completed day not yet done, then retires hourly rows past retention.
 * Safe to run repeatedly; `force` re-exports and re-summarizes days that are already done (after a rebuild).
 */
export function maintain(now = Date.now(), force = false) {
  const first = (stmts.firstBucket.get() as { t: number | null }).t;
  if (first == null) return { exported: 0, retired: 0 };

  let exported = 0;
  // A day is complete once the poll in the following hour has landed. Export and summary happen
  // together and are recorded in archived_days, so days with no data (downtime) are done once too.
  for (let day = Math.floor(first / DAY) * DAY; day + DAY + HOUR <= now; day += DAY) {
    if (!force && stmts.archived.get(day)) continue;
    transaction(() => stmts.rollup.run(day, day + DAY));
    exportDay(day);
    exported++;
  }
  const cutoff = Math.floor((now - config.hourlyRetentionDays * DAY) / DAY) * DAY;
  const retired = Number(transaction(() => stmts.retire.run(cutoff)).changes);
  if (exported || retired) {
    console.log(`[archive] archived ${exported} day(s), retired ${retired} hourly rows`);
  }
  return { exported, retired };
}

export interface ArchiveFile {
  kind: ArchiveKind;
  date: string;
  bytes: number;
  url: string;
}

export function listArchive(): ArchiveFile[] {
  const files: ArchiveFile[] = [];
  for (const kind of ARCHIVE_KINDS) {
    const root = path.join(config.archiveDir, kind);
    if (!fs.existsSync(root)) continue;
    for (const year of fs.readdirSync(root).sort()) {
      for (const name of fs.readdirSync(path.join(root, year)).sort()) {
        const m = /^(\d{4}-\d{2}-\d{2})\.csv\.gz$/.exec(name);
        if (!m) continue;
        files.push({
          kind,
          date: m[1],
          bytes: fs.statSync(path.join(root, year, name)).size,
          url: `/api/v1/archive/${kind}/${name}`,
        });
      }
    }
  }
  return files;
}

/** Resolves a requested archive file to a path on disk, or null for anything not in the archive. */
export function archiveFile(kind: string, name: string): string | null {
  if (!(ARCHIVE_KINDS as readonly string[]).includes(kind)) return null;
  const m = /^(\d{4})-\d{2}-\d{2}\.csv\.gz$/.exec(name);
  if (!m) return null;
  const file = path.join(config.archiveDir, kind, m[1], name);
  return fs.existsSync(file) ? file : null;
}
