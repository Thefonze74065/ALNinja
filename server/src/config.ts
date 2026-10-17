import path from "node:path";

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got "${raw}"`);
  return n;
}

const dataDir = path.resolve(process.env.DATA_DIR ?? "./data");

export const config = {
  port: num("PORT", 8080),
  dataDir,
  dbPath: path.resolve(process.env.DB_PATH ?? path.join(dataDir, "alninja.sqlite")),
  rawDir: path.join(dataDir, "raw"),
  webDir: path.resolve(process.env.WEB_DIR ?? "./web/dist"),
  aldataUrl: (process.env.ALDATA_URL ?? "https://aldata.earthiverse.ca").replace(/\/$/, ""),
  gameDataUrl: process.env.GAME_DATA_URL ?? "https://adventure.land/data.js",
  pollIntervalMinutes: num("POLL_INTERVAL_MINUTES", 10),
  // Merchants whose ALData `lastSeen` is older than this are left out of price calculations.
  freshHours: num("FRESH_HOURS", 48),
  // Keep a gzipped copy of every raw /merchants response so history can be reprocessed later.
  archiveRaw: (process.env.ARCHIVE_RAW ?? "true") !== "false",
  // Per-IP request budget for /api; 0 disables limiting.
  rateLimitPerMinute: num("RATE_LIMIT_PER_MINUTE", 120),
  // Behind a reverse proxy / tunnel, take the client IP from X-Forwarded-For.
  trustProxy: process.env.TRUST_PROXY === "true",
};
