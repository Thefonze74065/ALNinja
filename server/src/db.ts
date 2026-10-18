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
    close_reason      TEXT -- 'pending' (vanished, awaiting confirmation) | 'gone' (sold) | 'repriced' | 'withdrawn'
                           -- | 'upgraded' (consumed upgrading/compounding) | 'expired'
  );
  CREATE INDEX IF NOT EXISTS listings_open ON listings (merchant) WHERE closed_at IS NULL;
  CREATE INDEX IF NOT EXISTS listings_item ON listings (item, level, variant, closed_at);
  -- Vanished listings awaiting sale confirmation: few at a time, looked up per merchant every poll.
  CREATE INDEX IF NOT EXISTS listings_pending_merchant ON listings (merchant, closed_at) WHERE close_reason = 'pending';
  CREATE INDEX IF NOT EXISTS listings_pending_due ON listings (closed_at) WHERE close_reason = 'pending';

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

// Ground truth from players' characters: the game's "+$$" event for each stand trade they could see,
// and which merchants each reporter had in view when (to know which inferred sales were checkable).
// Not derived from the raw archive, so rebuilds copy these tables across.
db.exec(`
  CREATE TABLE IF NOT EXISTS observed_sales (
    id           INTEGER PRIMARY KEY,
    merchant     TEXT NOT NULL,    -- stand owner
    counterparty TEXT NOT NULL,    -- the other player
    side         TEXT NOT NULL,    -- 'sell': stand sold to counterparty; 'buy': stand's buy order filled
    item         TEXT NOT NULL,
    level        INTEGER NOT NULL,
    variant      TEXT NOT NULL,
    price        INTEGER NOT NULL, -- per unit
    quantity     INTEGER NOT NULL,
    slot         TEXT,
    region       TEXT,
    server       TEXT,
    map          TEXT,
    at           INTEGER NOT NULL, -- when the reporter saw it (corrected for its clock skew)
    reporter     TEXT NOT NULL,
    received_at  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS observed_sales_item ON observed_sales (item, at);
  CREATE INDEX IF NOT EXISTS observed_sales_merchant ON observed_sales (merchant, at);
  CREATE INDEX IF NOT EXISTS observed_sales_at ON observed_sales (at);

  CREATE TABLE IF NOT EXISTS observer_coverage (
    id       INTEGER PRIMARY KEY,
    reporter TEXT NOT NULL,
    merchant TEXT NOT NULL,
    start    INTEGER NOT NULL,
    end      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS observer_coverage_merchant ON observer_coverage (merchant, end);
  CREATE INDEX IF NOT EXISTS observer_coverage_reporter ON observer_coverage (reporter, merchant, end);
`);

// Public reporting keys, registered by in-game mail. Only a hash of each key is stored.
db.exec(`
  CREATE TABLE IF NOT EXISTS reporter_keys (
    character  TEXT PRIMARY KEY COLLATE NOCASE, -- the character that mailed the key
    key_hash   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
// v0.6 observed_sales had no key_owner: who vouched for each observation ('admin' for REPORT_TOKEN).
if (!(db.prepare("PRAGMA table_info(observed_sales)").all() as { name: string }[]).some((c) => c.name === "key_owner")) {
  db.exec("ALTER TABLE observed_sales ADD COLUMN key_owner TEXT NOT NULL DEFAULT 'admin'");
}

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
