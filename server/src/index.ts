import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import path from "node:path";
import { api } from "./api.ts";
import { poll } from "./collector.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { refreshGameData } from "./gamedata.ts";

await refreshGameData();

if (process.argv.includes("--poll-once")) {
  await poll();
  process.exit(0);
}

// Poll on a fixed schedule; setTimeout chaining means a slow poll never overlaps the next.
async function pollLoop() {
  await poll();
  setTimeout(pollLoop, config.pollIntervalMinutes * 60_000);
}
pollLoop();
setInterval(refreshGameData, 24 * 3_600_000);

const app = new Hono();
app.route("/api", api);
app.get("/healthz", (c) => c.text("ok"));
app.use("/*", serveStatic({ root: path.relative(process.cwd(), config.webDir) }));
app.get("*", serveStatic({ path: path.relative(process.cwd(), path.join(config.webDir, "index.html")) }));

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[http] ALNinja listening on :${info.port}`);
});

// As PID 1 in a container Node won't exit on SIGTERM by itself; close SQLite cleanly.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    console.log(`[shutdown] ${signal}`);
    server.close();
    db.close();
    process.exit(0);
  });
}
