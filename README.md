# ALNinja

A [poe.ninja](https://poe.ninja/)-style economy tracker for [Adventure Land](https://adventure.land/).
It polls the community [ALData](https://github.com/earthiverse/ALData) API for player merchant stands
and builds price history over time.

## How it works

ALData only serves the *current* state of merchant stands (anything seen in the last week). It has no
history, so ALNinja keeps its own:

1. **Collector**: every `POLL_INTERVAL_MINUTES` it fetches `GET /merchants` and reconciles each
   merchant's stand against what it saw last time. A listing is one row for as long as it stays up
   (`first_seen` → `last_seen`). When a merchant's data refreshes and an offer is gone, the row is closed
   as `gone` (usually sold, sometimes withdrawn) or `repriced`. Merchants that drop out of ALData close
   as `expired`. Giveaways and barter (`want`) slots are skipped.
2. **Price index**: after each poll it rebuilds the current hour's row in `price_history` for every
   item × level × variant (variant = `p` title such as `shiny`, or jar `data`). Only merchants seen in
   the last `FRESH_HOURS` count, and each merchant contributes once (their best offer), so a
   single stand can't skew the price. The headline price is the **lower-quartile ask**. Median ask,
   lowest ask, best bid, seller/buyer counts and total quantity are stored too. Each index is computed
   for all regions combined (`ALL`) and separately for each server region (US, EU, ASIA), using the
   region the merchant is currently on.
3. **Sales (estimated)**: a listing's quantity dropping, or a listing disappearing while the rest of
   the stand stays up, is recorded in `sales`. To filter out items merely stored on a stand, only offers
   priced near the market count: sells at most 3× the market price, buy orders at least ⅓ of it, and nothing at
   placeholder prices (10b+). A stand emptying all at once is `withdrawn`, not a sell-out. Sales feed
   sold-per-day figures, the most-traded list, and each item's time-to-sell by price band.
4. **Raw archive**: every raw response is saved gzipped under `data/raw/YYYY-MM-DD/`, so you
   can reprocess history later if the pricing logic changes (~3 MB/day at 10-minute polls).

Item names, categories and sprite icons come from the game's own `https://adventure.land/data.js`,
refreshed daily and cached in `data/gamedata.json`.

## Running on Docker

Anyone can run their own instance from the public image, without cloning the repo or logging in.
GitHub Actions builds it on every push to `main` and publishes it as
`ghcr.io/thefonze74065/alninja:latest` (plus `sha-<commit>` tags, and version tags for `v*` git tags).

Quickest start:

```sh
docker run -d --name alninja -p 8080:8080 -v alninja-data:/data ghcr.io/thefonze74065/alninja:latest
```

Or with Compose: copy [`docker-compose.yml`](docker-compose.yml), set the volume path, then

```sh
docker compose pull && docker compose up -d
```

Then open `http://<host>:8080`. Price history starts from your first poll, because ALData has no history
to backfill from. Everything lives in the `/data` volume (SQLite database, game-data cache, raw archive),
so keep it on persistent storage and back it up.

**Bind mounts and permissions:** the image runs as uid/gid `1000:1000`. If you mount a host directory,
it must be writable by the container's user, or the app exits with "Data directory … is not writable".
The included compose file sets `user: "568:568"`, TrueNAS SCALE's `apps` user, for a dataset such as
`/mnt/tank/apps/alninja:/data`. Change `user:` to whoever owns your directory, or remove it to use
1000:1000.

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `POLL_INTERVAL_MINUTES` | `10` | How often to poll ALData |
| `FRESH_HOURS` | `48` | Ignore merchants not seen by ALData for longer than this |
| `ARCHIVE_RAW` | `true` | Keep gzipped raw `/merchants` responses |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per-IP request budget for `/api` (0 disables) |
| `TRUST_PROXY` | `false` | Use `X-Forwarded-For` for client IPs (set when behind a reverse proxy/tunnel) |
| `ALDATA_URL` | `https://aldata.earthiverse.ca` | |
| `DATA_DIR` | `/data` (container), `./data` (local) | |

## Development

Requires Node 24+. The server is TypeScript run directly by Node (type stripping) and uses the
built-in `node:sqlite`, so there is no server build step.

```sh
npm install && npm --prefix web install
npm run dev              # API + collector on :8080
npm --prefix web run dev # UI on :5173, proxies /api to :8080
npm run poll             # run a single poll and exit
npm run typecheck
```

## API

Scripts and bots should use the versioned public API. It's documented in the app at `/#/api`, and
`GET /api/v1` lists the endpoints. All endpoints are `GET`, return JSON, allow any origin (CORS), take
`?region=ALL|US|EU|ASIA`, are cached for 60 seconds and are rate-limited per IP.

- `GET /api/v1/prices?items=a,b&min_sellers=3`: current prices
- `GET /api/v1/prices/:item`: every level/variant of one item
- `GET /api/v1/history/:item?days=7&level=2`: hourly history
- `GET /api/v1/listings/:item?side=sell`: open listings with server, map and coordinates
- `GET /api/v1/sales?item=&hours=24`: recent estimated sales
- `GET /api/v1/movers?window=24h|7d`: biggest risers/fallers and most traded

v1 shapes are stable: fields may be added, but not renamed or removed. The unversioned `/api/*`
endpoints serve the web UI and can change at any time.

In-game code runs on https://adventure.land, so browsers only allow it to call an **HTTPS** API.
To use ALNinja from in-game code, expose it over HTTPS (e.g. Cloudflare Tunnel or a reverse proxy) and
set `TRUST_PROXY=true`. Node bots can call it over plain http.
