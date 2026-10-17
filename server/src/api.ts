// Endpoints for the web UI. Their shapes follow the UI and may change; bots should use /api/v1.
import { Hono } from "hono";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { getGameMeta } from "./gamedata.ts";
import { DAY, history, movers, openListings, recentSales, regionParam, snapshot, velocity } from "./market.ts";

const stmts = {
  lastPoll: db.prepare("SELECT * FROM polls ORDER BY id DESC LIMIT 1"),
  lastGoodPoll: db.prepare("SELECT * FROM polls WHERE error IS NULL ORDER BY id DESC LIMIT 1"),
  counts: db.prepare(`
    SELECT (SELECT COUNT(*) FROM listings WHERE closed_at IS NULL) AS open_listings,
           (SELECT COUNT(*) FROM listings) AS total_listings,
           (SELECT COUNT(*) FROM merchants) AS merchants,
           (SELECT MIN(fetched_at) FROM polls WHERE error IS NULL) AS tracking_since`),
  regions: db.prepare(
    "SELECT DISTINCT server_region AS region FROM merchants WHERE server_region IS NOT NULL ORDER BY 1"),
};

export const api = new Hono();

api.get("/meta", (c) => {
  c.header("cache-control", "public, max-age=3600");
  return c.json(getGameMeta());
});

api.get("/status", (c) => {
  return c.json({
    lastPoll: stmts.lastPoll.get() ?? null,
    lastSuccessfulPoll: stmts.lastGoodPoll.get() ?? null,
    pollIntervalMinutes: config.pollIntervalMinutes,
    freshHours: config.freshHours,
    regions: (stmts.regions.all() as { region: string }[]).map((r) => r.region),
    ...(stmts.counts.get() as object),
  });
});

api.get("/overview", (c) => c.json(snapshot(regionParam(c.req.query("region")))));

api.get("/movers", (c) => {
  const window = c.req.query("window") === "7d" ? "7d" : "24h";
  return c.json({ window, ...movers(regionParam(c.req.query("region")), window, 3, 25) });
});

api.get("/items/:item", (c) => {
  const item = c.req.param("item");
  const days = Math.min(Math.max(Number(c.req.query("days")) || 30, 1), 3650);
  const region = regionParam(c.req.query("region"));
  return c.json({
    item,
    region,
    meta: getGameMeta().items[item] ?? null,
    variants: history(item, region, days),
    velocity: velocity(item, region, days),
    listings: openListings(item, region),
    sales: recentSales(item, region, Date.now() - days * DAY, 200),
  });
});
