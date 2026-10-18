// Public, versioned API for bots and other tools. Keep these shapes stable; add fields, don't rename.
import fs from "node:fs";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { archiveFile, listArchive } from "./archive.ts";
import { config } from "./config.ts";
import { addCorrection, correctionProblem, recentCorrections, type Correction } from "./corrections.ts";
import { isRevoked, KEY_SUBJECT, keyOwner, keyStatus } from "./keys.ts";
import { upgradeCosts } from "./upgrades.ts";
import { accuracy, recordReport, validateReport, type ObservationReport } from "./observed.ts";
import { dealOptions, deals, HOUR, history, lastPoll, movers, openListings, recentSales, regionParam, snapshot, type MarketRow } from "./market.ts";

const clamp = (raw: string | undefined, fallback: number, min: number, max: number) => {
  const n = Number(raw);
  return Number.isFinite(n) && raw !== undefined && raw !== "" ? Math.min(Math.max(n, min), max) : fallback;
};

/** Public rows drop UI-only fields (sparkline). */
const publicRow = ({ sparkline: _, ...row }: MarketRow) => row;

export const v1 = new Hono();

v1.use("*", async (c, next) => {
  await next();
  if (c.req.method === "GET" && c.res.status === 200) c.header("cache-control", "public, max-age=60");
});

v1.get("/", (c) =>
  c.json({
    name: "ALNinja API",
    version: 1,
    docs: "/#/api",
    notes: [
      "Prices are in gold per unit. Times are Unix epoch milliseconds.",
      "region is ALL (default), US, EU or ASIA on every endpoint.",
      "Sales are estimated from merchant stands: a quantity drop, or a listing disappearing while the stand stays up " +
        "and not put back within 2 hours. They're reported after that delay, dated when the listing vanished.",
    ],
    endpoints: {
      "GET /api/v1/prices": "Current price of every item. ?region= &items=a,b &min_sellers=",
      "GET /api/v1/prices/:item": "Current price of each level/variant of one item. ?region=",
      "GET /api/v1/history/:item": "Hourly price history. ?region= &days=7 (max 365) &level= &variant=",
      "GET /api/v1/listings/:item": "Open merchant listings with location. ?region= &side=sell|buy",
      "GET /api/v1/upgrades/:item":
        "Expected cost of each upgrade/compound level, from +0 and by the cheapest route (buy lower, upgrade up). ?region=",
      "GET /api/v1/sales": "Recent estimated sales. ?region= &item= &hours=24 (max 720) &limit=500 (max 2000)",
      "GET /api/v1/movers": "Biggest price changes and most traded. ?region= &window=24h|7d &min_sellers=3 &limit=20",
      "GET /api/v1/accuracy": "How inferred sales compare with trades players' characters saw. ?days=7 (max 90)",
      "POST /api/v1/observations": "Report trades your characters saw or made (needs a reporting key); see /#/api",
      "POST /api/v1/corrections":
        "Mark a stretch of a merchant's vanished stock as not sold (its own character's key, or the admin token); see /#/api",
      "GET /api/v1/corrections": "Corrections made in the last ?days=30 (max 365)",
      "GET /api/v1/auth": "How to get a reporting key (in-game mail)",
      "GET /api/v1/auth/:character": "Whether a character has a reporting key; with Authorization, whether it's valid",
      "GET /api/v1/archive": "Daily CSV files of every hourly price row and every sale, for bulk analysis",
      "GET /api/v1/deals":
        "Listings worth buying now. ?region= &kind=npc,underpriced,flip &min_discount=0.2 &min_sellers=3 &min_profit=1 &sort=profit|discount &limit=100 (max 500)",
    },
  }),
);

v1.get("/prices", (c) => {
  const region = regionParam(c.req.query("region"));
  const items = c.req.query("items")?.split(",").map((s) => s.trim()).filter(Boolean);
  const minSellers = clamp(c.req.query("min_sellers"), 0, 0, 1000);
  let rows = snapshot(region);
  if (items?.length) {
    const wanted = new Set(items);
    rows = rows.filter((r) => wanted.has(r.item));
  }
  if (minSellers) rows = rows.filter((r) => r.sellers >= minSellers);
  return c.json({ region, updated: lastPoll().at, count: rows.length, prices: rows.map(publicRow) });
});

v1.get("/prices/:item", (c) => {
  const region = regionParam(c.req.query("region"));
  const item = c.req.param("item");
  const rows = snapshot(region).filter((r) => r.item === item);
  return c.json({ region, updated: lastPoll().at, item, prices: rows.map(publicRow) });
});

v1.get("/history/:item", (c) => {
  const region = regionParam(c.req.query("region"));
  const item = c.req.param("item");
  const days = clamp(c.req.query("days"), 7, 1 / 24, 365);
  const level = c.req.query("level");
  const variant = c.req.query("variant");
  const variants = history(item, region, days).filter(
    (v) => (level === undefined || String(v.level) === level) && (variant === undefined || v.variant === variant),
  );
  return c.json({ region, item, days, variants });
});

v1.get("/listings/:item", (c) => {
  const region = regionParam(c.req.query("region"));
  const item = c.req.param("item");
  const side = c.req.query("side");
  const listings = openListings(item, region).filter((l) => !side || l.side === side);
  return c.json({ region, item, listings });
});

v1.get("/upgrades/:item", (c) => {
  const costs = upgradeCosts(c.req.param("item"), regionParam(c.req.query("region")));
  return costs ? c.json(costs) : c.json({ error: "Not an upgradeable or compoundable item" }, 404);
});

v1.get("/sales", (c) => {
  const region = regionParam(c.req.query("region"));
  const hours = clamp(c.req.query("hours"), 24, 1, 720);
  const limit = clamp(c.req.query("limit"), 500, 1, 2000);
  const since = Date.now() - hours * HOUR;
  return c.json({ region, since, sales: recentSales(c.req.query("item") ?? null, region, since, limit) });
});

v1.get("/movers", (c) => {
  const region = regionParam(c.req.query("region"));
  const window = c.req.query("window") === "7d" ? "7d" : "24h";
  const minSellers = clamp(c.req.query("min_sellers"), 3, 1, 1000);
  const limit = clamp(c.req.query("limit"), 20, 1, 200);
  const m = movers(region, window, minSellers, limit);
  return c.json({
    region,
    window,
    updated: lastPoll().at,
    gainers: m.gainers.map(publicRow),
    losers: m.losers.map(publicRow),
    mostTraded: m.mostTraded.map(publicRow),
  });
});

v1.get("/deals", (c) => {
  const region = regionParam(c.req.query("region"));
  const opts = dealOptions((name) => c.req.query(name));
  return c.json({ region, updated: lastPoll().at, ...opts, deals: deals(region, opts) });
});

v1.get("/archive", (c) =>
  c.json({
    description:
      "One gzipped CSV per UTC day. prices: every hourly price row (all items, levels, variants and regions). " +
      "sales: every estimated sale. Files are permanent; the live database keeps hourly rows for hourlyRetentionDays.",
    hourlyRetentionDays: config.hourlyRetentionDays,
    files: listArchive(),
  }),
);

v1.get("/archive/:kind/:file", (c) => {
  const file = archiveFile(c.req.param("kind"), c.req.param("file"));
  if (!file) return c.json({ error: "No such archive file. See GET /api/v1/archive." }, 404);
  return c.body(fs.readFileSync(file), 200, {
    "content-type": "application/gzip",
    "content-disposition": `attachment; filename="alninja-${c.req.param("kind")}-${c.req.param("file")}"`,
  });
});

// Per-key report budget, on top of the per-IP limit: the snippet reports every 30s.
const REPORTS_PER_MINUTE = 12;
const keyWindows = new Map<string, { start: number; count: number }>();
function overBudget(owner: string): boolean {
  const now = Date.now();
  let w = keyWindows.get(owner);
  if (!w || now - w.start >= 60_000) keyWindows.set(owner, (w = { start: now, count: 0 }));
  if (keyWindows.size > 10_000) keyWindows.clear();
  return ++w.count > REPORTS_PER_MINUTE;
}

v1.post("/observations", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "Report too large" }, 413) }), async (c) => {
  const owner = keyOwner(c.req.header("authorization"));
  if (!owner) {
    return c.json({ error: "Missing or wrong reporting key (Authorization: Bearer <Character>:<key>). See GET /api/v1/auth" }, 401);
  }
  if (owner !== "admin" && overBudget(owner)) return c.json({ error: `At most ${REPORTS_PER_MINUTE} reports a minute per key` }, 429);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }
  const problem = validateReport(body);
  if (problem) return c.json({ error: problem }, 400);
  const report = body as ObservationReport;
  if (isRevoked(report.reporter)) return c.json({ error: "This character's reports are not accepted" }, 403);
  return c.json(recordReport(report, Date.now(), owner));
});

v1.post("/corrections", bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "Too large" }, 413) }), async (c) => {
  const owner = keyOwner(c.req.header("authorization"));
  if (!owner) {
    return c.json({ error: "Missing or wrong reporting key (Authorization: Bearer <Character>:<key>). See GET /api/v1/auth" }, 401);
  }
  if (owner !== "admin" && overBudget(owner)) return c.json({ error: `At most ${REPORTS_PER_MINUTE} requests a minute per key` }, 429);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }
  const problem = correctionProblem(body, owner);
  if (problem) return c.json({ error: problem }, 400);
  return c.json(addCorrection(body as Correction, owner));
});

v1.get("/corrections", (c) => c.json({ corrections: recentCorrections(clamp(c.req.query("days"), 30, 1, 365)) }));

v1.get("/auth", (c) =>
  c.json({
    enabled: Boolean(config.keyMailCharacter),
    mailTo: config.keyMailCharacter,
    subject: KEY_SUBJECT,
    message: "your key: 16-200 printable characters, no spaces or colons. Pick a long random one.",
    howTo: config.keyMailCharacter
      ? `In game, mail ${config.keyMailCharacter} with subject "${KEY_SUBJECT}" and your key as the message ` +
        `(e.g. send_mail("${config.keyMailCharacter}", "${KEY_SUBJECT}", "<key>")). The mail fee is the game's ` +
        "usual 48,000 gold. Keys are picked up within a minute; check GET /api/v1/auth/<YourCharacter>. " +
        "Then send reports with Authorization: Bearer <YourCharacter>:<key>. Mail again to change your key."
      : "Public reporting keys aren't enabled on this instance.",
  }),
);

v1.get("/auth/:character", (c) => {
  const status = keyStatus(c.req.param("character"));
  const header = c.req.header("authorization");
  return c.json(header ? { ...status, valid: keyOwner(header)?.toLowerCase() === status.character.toLowerCase() } : status);
});

v1.get("/accuracy", (c) => c.json(accuracy(clamp(c.req.query("days"), 7, 1, 90))));

v1.notFound((c) => c.json({ error: "Not found. See GET /api/v1 for endpoints." }, 404));
