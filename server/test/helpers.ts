// Shared test setup: a throwaway data directory, configured before any app module loads.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Merchant, MerchantSlot } from "../src/aldata.ts";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "alninja-test-"));
process.env.ARCHIVE_RAW = "false";
process.env.FRESH_HOURS = "48";
process.env.HOURLY_RETENTION_DAYS = "8";
process.env.REPORT_TOKEN = "test-token";
process.env.KEY_MAIL_CHARACTER = "KeyBot";
process.env.REVOKED_REPORTERS = "Revoked1";

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** Test clock: a few days back so "last 24h / 7d" windows computed from Date.now() include it. */
export const T0 = Math.floor((Date.now() - 3 * DAY) / HOUR) * HOUR;

export const app = {
  db: await import("../src/db.ts"),
  collector: await import("../src/collector.ts"),
  market: await import("../src/market.ts"),
  archive: await import("../src/archive.ts"),
  observed: await import("../src/observed.ts"),
  keys: await import("../src/keys.ts"),
  mail: await import("../src/mail.ts"),
  v1: (await import("../src/v1.ts")).v1,
};
export const { db } = app.db;

export function merchant(
  id: string,
  lastSeen: number,
  slots: Record<string, MerchantSlot | null>,
  region = "US",
): Merchant {
  return {
    id,
    lastSeen: new Date(lastSeen).toISOString(),
    map: "main",
    serverRegion: region,
    serverIdentifier: "I",
    slots,
    x: 0,
    y: 0,
  };
}

export const listingsOf = (merchantId: string) =>
  db.prepare("SELECT * FROM listings WHERE merchant = ? ORDER BY id").all(merchantId) as any[];
export const salesOf = (merchantId: string) =>
  db.prepare("SELECT * FROM sales WHERE merchant = ? ORDER BY id").all(merchantId) as any[];
export const priceOf = (item: string, region = "ALL", level = 0, variant = "") =>
  db.prepare(
    "SELECT * FROM price_history WHERE item = ? AND region = ? AND level = ? AND variant = ? ORDER BY bucket DESC LIMIT 1",
  ).get(item, region, level, variant) as any;
