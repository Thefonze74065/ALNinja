import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import path from "node:path";
import { api } from "./api.ts";
import { maintain } from "./archive.ts";
import { poll } from "./collector.ts";
import { config } from "./config.ts";
import { db } from "./db.ts";
import { refreshGameData } from "./gamedata.ts";
import { rateLimit } from "./ratelimit.ts";
import { v1 } from "./v1.ts";

await refreshGameData();

if (process.argv.includes("--poll-once")) {
  await poll();
  process.exit(0);
}

// Poll on a fixed schedule; setTimeout chaining means a slow poll never overlaps the next.
async function pollLoop() {
  await poll();
  try {
    maintain();
  } catch (err) {
    console.error(`[archive] maintenance failed: ${(err as Error).message}`);
  }
  setTimeout(pollLoop, config.pollIntervalMinutes * 60_000);
}
pollLoop();
setInterval(refreshGameData, 24 * 3_600_000);

const app = new Hono();
// Read-only public site: lock the page to its own scripts/styles, game sprites from adventure.land,
// and API calls to itself. No framing, no sniffing, HTTPS remembered (ignored over plain http).
app.use(
  "*",
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://adventure.land"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'none'"],
      frameAncestors: ["'none'"],
    },
    strictTransportSecurity: "max-age=31536000",
    referrerPolicy: "strict-origin-when-cross-origin",
    // The API is meant to be called from other sites (CORS), so don't restrict resource loading.
    crossOriginResourcePolicy: "cross-origin",
  }),
);
// Open to any origin so in-game code (running on adventure.land) and other tools can call it.
app.use(
  "/api/*",
  cors({ origin: "*", allowMethods: ["GET", "POST"], allowHeaders: ["Content-Type", "Authorization"] }),
  rateLimit,
);
app.route("/api/v1", v1);
app.route("/api", api);
app.all("/api/*", (c) => c.json({ error: "Not found. See GET /api/v1 for endpoints." }, 404));
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
