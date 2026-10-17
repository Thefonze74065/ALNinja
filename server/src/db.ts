import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config.ts";

fs.mkdirSync(config.dataDir, { recursive: true });
try {
  fs.accessSync(config.dataDir, fs.constants.W_OK);
} catch {
  throw new Error(
    `Data directory ${config.dataDir} is not writable by uid ${process.getuid?.()} (gid ${process.getgid?.()}). ` +
      `Grant that user write access, or run the container as a user that has it (docker-compose \`user:\`).`,
  );
}

export const db = new DatabaseSync(config.dbPath);

const priceHistoryColumns = db.prepare("PRAGMA table_info(price_history)").all() as { name: string }[];
const migrating = priceHistoryColumns.length > 0 && !priceHistoryColumns.some((c) => c.name === "region");
if (migrating) {
  db.exec(`
    DROP INDEX IF EXISTS price_history_bucket;
    ALTER TABLE price_history RENAME TO price_history_v1;
  `);
}

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS polls (
    id         INTEGER PRIMARY KEY,
    fetched_at INTEGER NOT NULL,
    merchants  INTEGER,
    updated    INTEGER,
    opened     INTEGER,
    closed     INTEGER,
    error      TEXT
  );

  CREATE TABLE IF NOT EXISTS merchants (
    id                TEXT PRIMARY KEY,
    server_region     TEXT,
    server_identifier TEXT,
    map               TEXT,
    x                 REAL,
    y                 REAL,
    last_seen         INTEGER NOT NULL
  );

  -- One row per continuous appearance of an offer in a merchant's stand.
  -- Times are the merchant's ALData lastSeen (ms), not our poll time.
  CREATE TABLE IF NOT EXISTS listings (
    id                INTEGER PRIMARY KEY,
    merchant          TEXT NOT NULL,
    slot              TEXT NOT NULL,
    side              TEXT NOT NULL CHECK (side IN ('sell', 'buy')),
    item              TEXT NOT NULL,
    level             INTEGER NOT NULL,
    variant           TEXT NOT NULL,
    flags             TEXT NOT NULL DEFAULT '', -- 'gift', 'expires' (affect NPC value only)
    price             INTEGER NOT NULL,
    quantity          INTEGER NOT NULL,
    initial_quantity  INTEGER NOT NULL,
    server_region     TEXT,
    server_identifier TEXT,
    first_seen        INTEGER NOT NULL,
    last_seen         INTEGER NOT NULL,
    closed_at         INTEGER,
    close_reason      TEXT -- 'pending' (vanished, awaiting confirmation) | 'gone' (sold) | 'repriced' | 'withdrawn' | 'expired'
  );
  CREATE INDEX IF NOT EXISTS listings_open ON listings (merchant) WHERE closed_at IS NULL;
  CREATE INDEX IF NOT EXISTS listings_item ON listings (item, level, variant, closed_at);

  -- Hourly price index per item/level/variant and region, recomputed from open listings on every poll.
  CREATE TABLE IF NOT EXISTS price_history (
    item        TEXT NOT NULL,
    region      TEXT NOT NULL, -- 'ALL' or a server region (US, EU, ASIA)
    level       INTEGER NOT NULL,
    variant     TEXT NOT NULL,
    bucket      INTEGER NOT NULL, -- start of hour, ms
    sell_min    INTEGER,
    sell_p25    INTEGER,
    sell_median INTEGER,
    buy_max     INTEGER,
    sell_count  INTEGER NOT NULL, -- distinct merchants selling
    buy_count   INTEGER NOT NULL, -- distinct merchants buying
    sell_qty    INTEGER NOT NULL,
    PRIMARY KEY (item, region, level, variant, bucket)
  );
  CREATE INDEX IF NOT EXISTS price_history_region_bucket ON price_history (region, bucket);
`);

// v0.1 price_history had no region: its rows were all-region prices, so they become region 'ALL'.
if (migrating) {
  transaction(() => {
    db.exec(`
      INSERT INTO price_history (item, region, level, variant, bucket, sell_min, sell_p25, sell_median, buy_max,
        sell_count, buy_count, sell_qty)
      SELECT item, 'ALL', level, variant, bucket, sell_min, sell_p25, sell_median, buy_max,
        sell_count, buy_count, sell_qty
      FROM price_history_v1;
      DROP TABLE price_history_v1;
    `);
  });
  console.log("[db] migrated price_history to per-region schema");
}

// Daily summaries of price_history: long-range charts read these once hourly rows are retired.
db.exec(`
  CREATE TABLE IF NOT EXISTS price_daily (
    item     TEXT NOT NULL,
    region   TEXT NOT NULL,
    level    INTEGER NOT NULL,
    variant  TEXT NOT NULL,
    day      INTEGER NOT NULL, -- start of UTC day, ms
    close    INTEGER,          -- last hourly lower-quartile ask of the day
    low      INTEGER,          -- min hourly lower-quartile ask
    high     INTEGER,          -- max hourly lower-quartile ask
    median   INTEGER,          -- last hourly median ask
    lowest   INTEGER,          -- cheapest ask seen
    best_bid INTEGER,          -- highest bid seen
    sellers  REAL NOT NULL,    -- averages over the day's hourly rows
    buyers   REAL NOT NULL,
    quantity REAL NOT NULL,
    hours    INTEGER NOT NULL, -- hourly rows summarized
    PRIMARY KEY (item, region, level, variant, day)
  );
  -- Completed UTC days whose hourly prices and sales were written to the CSV archive.
  CREATE TABLE IF NOT EXISTS archived_days (
    day         INTEGER PRIMARY KEY,
    exported_at INTEGER NOT NULL
  );
`);

// v0.3 listings had no flags column.
if (!(db.prepare("PRAGMA table_info(listings)").all() as { name: string }[]).some((c) => c.name === "flags")) {
  db.exec("ALTER TABLE listings ADD COLUMN flags TEXT NOT NULL DEFAULT ''");
}

// Estimated trades: a listing's quantity dropping, or the listing disappearing while the rest of the
// stand stays up. side = 'sell' means the merchant sold to a player; 'buy' means a buy order was filled.
const hadSales = (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sales'").get()) != null;
db.exec(`
  CREATE TABLE IF NOT EXISTS sales (
    id         INTEGER PRIMARY KEY,
    listing_id INTEGER NOT NULL REFERENCES listings (id),
    merchant   TEXT NOT NULL,
    side       TEXT NOT NULL,
    item       TEXT NOT NULL,
    level      INTEGER NOT NULL,
    variant    TEXT NOT NULL,
    region     TEXT,
    price      INTEGER NOT NULL,
    quantity   INTEGER NOT NULL,
    listed_at  INTEGER NOT NULL, -- the listing's first_seen, for time-to-sell
    at         INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sales_item ON sales (item, at);
  CREATE INDEX IF NOT EXISTS sales_at ON sales (at);
`);
if (!hadSales) {
  // Listings closed as 'gone' before sales were tracked; partial sales from that period are unknown.
  // Same plausibility rule as the collector: near-market prices only, else it was a withdrawal.
  db.exec(`
    UPDATE listings SET close_reason = 'withdrawn'
    WHERE close_reason = 'gone' AND NOT (
      CASE WHEN (SELECT sell_p25 FROM price_history ph WHERE ph.item = listings.item AND ph.region = 'ALL'
                 AND ph.level = listings.level AND ph.variant = listings.variant ORDER BY bucket DESC LIMIT 1)
           IS NULL THEN price < 1e10
      ELSE CASE side
        WHEN 'sell' THEN price <= 3 * (SELECT sell_p25 FROM price_history ph WHERE ph.item = listings.item
          AND ph.region = 'ALL' AND ph.level = listings.level AND ph.variant = listings.variant
          ORDER BY bucket DESC LIMIT 1)
        ELSE price * 3 >= (SELECT sell_p25 FROM price_history ph WHERE ph.item = listings.item
          AND ph.region = 'ALL' AND ph.level = listings.level AND ph.variant = listings.variant
          ORDER BY bucket DESC LIMIT 1)
      END END);
    INSERT INTO sales (listing_id, merchant, side, item, level, variant, region, price, quantity, listed_at, at)
    SELECT id, merchant, side, item, level, variant, server_region, price, quantity, first_seen, closed_at
    FROM listings WHERE close_reason = 'gone';
  `);
}

export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
