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
  archiveDir: path.resolve(process.env.ARCHIVE_DIR ?? path.join(dataDir, "archive")),
  webDir: path.resolve(process.env.WEB_DIR ?? "./web/dist"),
  aldataUrl: (process.env.ALDATA_URL ?? "https://aldata.earthiverse.ca").replace(/\/$/, ""),
  gameDataUrl: process.env.GAME_DATA_URL ?? "https://adventure.land/data.js",
  pollIntervalMinutes: num("POLL_INTERVAL_MINUTES", 10),
  // Merchants whose ALData `lastSeen` is older than this are left out of price calculations.
  freshHours: num("FRESH_HOURS", 48),
  // Keep a gzipped copy of every raw /merchants response so history can be reprocessed later.
  archiveRaw: (process.env.ARCHIVE_RAW ?? "true") !== "false",
  // Hourly price rows older than this move to the daily table (after being exported to the archive).
  // The 7-day figures need at least 8 days of hourly data.
  hourlyRetentionDays: Math.max(8, num("HOURLY_RETENTION_DAYS", 90)),
  // Shared secret for POST /api/v1/observations (sale reports from players' characters). Unset disables it.
  reportToken: process.env.REPORT_TOKEN?.trim() || null,
  // Public reporting keys, set by in-game mail (like ALData): players mail KEY_MAIL_CHARACTER with subject
  // "alninja_auth" and their chosen key as the message. Needs the receiving account's credentials:
  // AL_EMAIL + AL_PASSWORD, or AL_AUTH ("<userID>-<auth>", the adventure.land "auth" cookie).
  keyMailCharacter: process.env.KEY_MAIL_CHARACTER?.trim() || null,
  alEmail: process.env.AL_EMAIL?.trim() || null,
  alPassword: process.env.AL_PASSWORD || null,
  alAuth: process.env.AL_AUTH?.trim() || null,
  alUrl: (process.env.AL_URL ?? "https://adventure.land").replace(/\/$/, ""),
  // Characters whose reporting key is revoked; their reports are rejected and past ones ignored.
  revokedReporters: new Set((process.env.REVOKED_REPORTERS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)),
  // Per-IP request budget for /api; 0 disables limiting.
  rateLimitPerMinute: num("RATE_LIMIT_PER_MINUTE", 120),
  // Where the client IP comes from, for rate limiting:
  //   "false"      the TCP peer (direct exposure)
  //   "cloudflare" the CF-Connecting-IP header (behind Cloudflare / cloudflared; Cloudflare overwrites it)
  //   "true"       the last X-Forwarded-For entry, i.e. the one added by the nearest proxy
  trustProxy: (["cloudflare", "true"].includes(process.env.TRUST_PROXY ?? "") ? process.env.TRUST_PROXY : "false") as
    "false" | "cloudflare" | "true",
};
