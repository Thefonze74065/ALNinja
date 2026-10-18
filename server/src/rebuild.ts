// Rebuilds the database and CSV archive by replaying every raw /merchants snapshot in data/raw through
// the current collector logic, so changes to the sale/price rules apply to all history.
//
//   node server/src/rebuild.ts [--force]
//
// Or set REBUILD=<token> on the container and restart it (see index.ts). Stop the server first. The new database and archive are built beside the live ones and swapped in
// only when complete; the old ones are kept as *.bak-<timestamp> for you to delete once you're happy.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";

const force = process.argv.includes("--force");
// Launched by index.ts while the server is starting, so the server can't be polling.
const startup = process.argv.includes("--startup");
const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");
const rawDir = path.join(dataDir, "raw");
const liveDb = path.resolve(process.env.DB_PATH ?? path.join(dataDir, "alninja.sqlite"));
const liveArchive = path.resolve(process.env.ARCHIVE_DIR ?? path.join(dataDir, "archive"));
const newDb = `${liveDb}.rebuild`;
const newArchive = `${liveArchive}.rebuild`;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");

function fail(message: string): never {
  console.error(`[rebuild] ${message}`);
  process.exit(1);
}

/** Raw snapshots in time order: data/raw/YYYY-MM-DD/HH-mm-ss.json.gz (UTC). */
function rawSnapshots(): { file: string; at: number }[] {
  if (!fs.existsSync(rawDir)) return [];
  const out: { file: string; at: number }[] = [];
  for (const day of fs.readdirSync(rawDir)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    for (const name of fs.readdirSync(path.join(rawDir, day))) {
      const m = /^(\d{2})-(\d{2})-(\d{2})\.json\.gz$/.exec(name);
      if (m) out.push({ file: path.join(rawDir, day, name), at: Date.parse(`${day}T${m[1]}:${m[2]}:${m[3]}Z`) });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const snapshots = rawSnapshots();
if (!snapshots.length) fail(`No raw snapshots in ${rawDir}; nothing to rebuild from.`);

// Safety checks against the live database: never replace it with something that knows less.
if (fs.existsSync(liveDb)) {
  const live = new DatabaseSync(liveDb, { readOnly: true });
  const polls = live.prepare("SELECT COUNT(*) AS n, MIN(fetched_at) AS first, MAX(fetched_at) AS last FROM polls WHERE error IS NULL").get() as
    { n: number; first: number | null; last: number | null };
  live.close();
  const problems: string[] = [];
  if (!startup && polls.last && Date.now() - polls.last < 5 * 60_000) {
    problems.push(`the live database was polled ${Math.round((Date.now() - polls.last) / 1000)}s ago: stop the server first`);
  }
  if (snapshots.length < polls.n) {
    problems.push(`only ${snapshots.length} raw snapshots for ${polls.n} recorded polls: history would be lost`);
  }
  if (polls.first && snapshots[0].at > polls.first + 60 * 60_000) {
    problems.push(`raw snapshots start ${new Date(snapshots[0].at).toISOString()}, after the first poll ` +
      `${new Date(polls.first).toISOString()}: earlier history would be lost`);
  }
  if (problems.length) {
    for (const p of problems) console.error(`[rebuild] ${p}`);
    if (!force) fail("Refusing to rebuild. Fix the above, or pass --force (REBUILD_FORCE=true) to rebuild anyway.");
    console.warn("[rebuild] --force given, continuing.");
  }
}

for (const f of [newDb, `${newDb}-wal`, `${newDb}-shm`]) fs.rmSync(f, { force: true });
fs.rmSync(newArchive, { recursive: true, force: true });

// Point the app's modules at the new database and archive before they load.
process.env.DB_PATH = newDb;
process.env.ARCHIVE_DIR = newArchive;
process.env.ARCHIVE_RAW = "false";
const { db } = await import("./db.ts");
const { ingest, recomputePrices } = await import("./collector.ts");
const { transaction } = await import("./db.ts");
const { maintain } = await import("./archive.ts");
const { refreshGameData } = await import("./gamedata.ts");
// Sale detection uses NPC shop prices, so load the same game data the live server uses.
await refreshGameData();

console.log(`[rebuild] replaying ${snapshots.length} snapshots from ${new Date(snapshots[0].at).toISOString()}`);
const started = performance.now();
// Prices only need computing on each hour's last snapshot: that's the one that sets the hour's
// row live, and ingest never reads the current hour's prices (see ingest()).
const HOUR = 3_600_000;
const hourOf = (t: number) => Math.floor(t / HOUR);
const lastInHour = (i: number) => i === snapshots.length - 1 || hourOf(snapshots[i + 1].at) !== hourOf(snapshots[i].at);
let skipped = 0;
let unpriced: number | null = null; // time of the latest ingested snapshot whose hour still needs prices
const progressEvery = Math.max(500, Math.round(snapshots.length / 20));
for (const [i, s] of snapshots.entries()) {
  try {
    const merchants = JSON.parse(zlib.gunzipSync(fs.readFileSync(s.file)).toString());
    if (!Array.isArray(merchants)) throw new Error("not an array");
    ingest(merchants, s.at, { prices: lastInHour(i) });
    unpriced = lastInHour(i) ? null : s.at;
  } catch (err) {
    skipped++;
    console.warn(`[rebuild] skipping ${s.file}: ${(err as Error).message}`);
    // If this was meant to be the hour's pricing snapshot, price the hour from the last good one.
    if (lastInHour(i) && unpriced != null) {
      const at = unpriced;
      transaction(() => recomputePrices(at));
      unpriced = null;
    }
  }
  if ((i + 1) % progressEvery === 0) {
    const pct = Math.round(((i + 1) / snapshots.length) * 100);
    console.log(`[rebuild] ${i + 1}/${snapshots.length} snapshots (${pct}%)`);
  }
}
// Observed sales, coverage and reporting keys come from players, not the raw archive: carry them over.
if (fs.existsSync(liveDb)) {
  db.exec(`ATTACH DATABASE '${liveDb.replaceAll("'", "''")}' AS old`);
  for (const table of ["observed_sales", "observer_coverage", "reporter_keys"]) {
    if (!db.prepare("SELECT 1 FROM old.sqlite_master WHERE type = 'table' AND name = ?").get(table)) continue;
    // Copy the columns both versions have (an older database may lack newer columns).
    const cols = (name: string) => (db.prepare(`PRAGMA ${name}.table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    const shared = cols("old").filter((c) => cols("main").includes(c)).join(", ");
    db.exec(`INSERT INTO main.${table} (${shared}) SELECT ${shared} FROM old.${table}`);
  }
  db.exec("DETACH DATABASE old");
}
const archived = maintain(Date.now(), true);
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
const counts = db.prepare(`
  SELECT (SELECT COUNT(*) FROM polls) AS polls, (SELECT COUNT(*) FROM listings) AS listings,
         (SELECT COUNT(*) FROM sales) AS sales, (SELECT COUNT(*) FROM price_history) AS hourly,
         (SELECT COUNT(*) FROM price_daily) AS daily`).get();
db.close();

// Swap: live files become backups, rebuilt ones take their place.
for (const suffix of ["", "-wal", "-shm"]) {
  if (fs.existsSync(liveDb + suffix)) fs.renameSync(liveDb + suffix, `${liveDb}.bak-${stamp}${suffix}`);
}
fs.renameSync(newDb, liveDb);
for (const suffix of ["-wal", "-shm"]) fs.rmSync(newDb + suffix, { force: true });
if (fs.existsSync(liveArchive)) fs.renameSync(liveArchive, `${liveArchive}.bak-${stamp}`);
if (fs.existsSync(newArchive)) fs.renameSync(newArchive, liveArchive);

const c = counts as Record<string, number>;
const day = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
const summary = `${snapshots.length - skipped} snapshots (${day(snapshots[0].at)} to ` +
  `${day(snapshots[snapshots.length - 1].at)} UTC) -> ${c.listings} listings, ${c.sales} sales, ` +
  `${c.hourly} hourly + ${c.daily} daily prices, ${archived.exported} day(s) archived` +
  (skipped ? `, ${skipped} unreadable snapshot(s) skipped` : "");
console.log(`[rebuild] ✔ REBUILT in ${Math.round((performance.now() - started) / 1000)}s: ${summary}`);
console.log(`[rebuild] previous database and archive kept as *.bak-${stamp}; delete them when satisfied.`);

// Record the rebuild for startup logs (index.ts passes the REBUILD token it was started with).
if (process.env.REBUILD_TOKEN) {
  fs.writeFileSync(path.join(dataDir, ".rebuild-done"), JSON.stringify({
    token: process.env.REBUILD_TOKEN, at: `${day(Date.now())} UTC`, summary,
  }) + "\n");
}
