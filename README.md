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
   placeholder prices (10b+). A stand emptying all at once is `withdrawn`, not a sell-out. A vanished
   listing only counts once it has stayed gone for 2 hours: merchants often take stock down and put it
   back (restocking, repricing), and if the same goods return it was a withdrawal or reprice (a smaller
   returning stack counts the difference as sold). Lower-level copies that vanish as the same item appears
   at a higher level were consumed upgrading or compounding (`upgraded`), not sold. Sales are dated
   when the listing vanished. Sales feed
   sold-per-day figures, the most-traded list, and each item's time-to-sell by price band.
4. **Deals**: buyable listings worth more elsewhere. **npc**: an NPC pays more than the asking price
   (NPC value is a port of the game's own `calculate_item_value`, including upgrade/compound levels,
   gifted items paying 1 gold and temporary ones 1/8). **flip**: another merchant's buy order pays more
   than this ask. **underpriced**: well under the cheapest competing seller (a resale estimate).
5. **Daily archive and retention**: each completed UTC day, every hourly price row and every sale is
   written to `data/archive/{prices,sales}/YYYY/YYYY-MM-DD.csv.gz`. These files are kept forever and can be
   downloaded through the API. The day is also summarized into `price_daily`. Hourly rows older than
   `HOURLY_RETENTION_DAYS` are then removed from the database (only once archived); long-range charts use
   the daily summaries.
6. **Raw archive**: every raw `/merchants` response is saved gzipped under `data/raw/YYYY-MM-DD/`
   (~3 MB/day at 10-minute polls). This is the source of truth for [rebuilding](#rebuilding-from-the-raw-archive).

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

Storage grows by roughly 1 GB/year of raw archive plus ~150 MB/year of daily CSVs. The database stays
small because hourly rows are retired.

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
| `REBUILD` | (unset) | Rebuild from the raw archive on startup, once per distinct value |
| `RESET_DATA` | (unset) | **Deletes all collected history** (database, CSV archive, raw snapshots, backups) on startup and starts fresh, once per distinct value |
| `HOURLY_RETENTION_DAYS` | `90` | Hourly price rows kept in the database (min 8); older ones live in the CSV archive |
| `RATE_LIMIT_PER_MINUTE` | `120` | Per-IP request budget for `/api` (0 disables) |
| `TRUST_PROXY` | `false` | How to find the client IP for rate limiting: `cloudflare` (behind Cloudflare or a Cloudflare Tunnel: uses `CF-Connecting-IP`), `true` (other reverse proxies: the last `X-Forwarded-For` entry), `false` (exposed directly). Behind a proxy, leaving it `false` makes every visitor share one limit |
| `ALDATA_URL` | `https://aldata.earthiverse.ca` | |
| `DATA_DIR` | `/data` (container), `./data` (local) | |

### Rebuilding from the raw archive

When the collector's rules change (how sales are detected, how prices are indexed), the rebuild
replays every raw snapshot through the current code. Fixing a rule then fixes all history, not just
future polls. Replaying reproduces live polling exactly; this was checked row by row.

Set `REBUILD` to any value in the compose file and redeploy (works from Dockge, Portainer, TrueNAS
apps and similar UIs):

```yaml
    environment:
      REBUILD: "1"   # change to "2", "3", … to rebuild again later
```

On startup the container rebuilds before it begins serving and polling, and records the value in
`/data/.rebuild-done`, so leaving the variable set doesn't repeat it. The log always reports it:

```
[startup] ALNinja 5c5e1f2
[startup] rebuild: REBUILD=2 requested; rebuilding before the server starts
[rebuild] ✔ REBUILT in 41s: 5214 snapshots (…) -> 48120 listings, 3911 sales, …
[startup] rebuild: REBUILD=2 complete; starting the server on the rebuilt database
```

If it says `rebuild: not requested`, the variable didn't reach the container. In Dockge, put it in
the compose file's `environment:`; the separate `.env` box only feeds `${VAR}` substitution in the YAML.
Expect roughly 3 minutes per month of history at 2-minute polling (under a minute at 10-minute polling). From a shell instead:
`docker compose stop alninja && docker compose run --rm alninja node server/src/rebuild.ts && docker compose start alninja`.

The rebuild writes a new database and CSV archive beside the live ones, swaps them in only when complete,
and keeps the previous ones as `*.bak-<timestamp>` for you to delete once satisfied. It refuses to run if
the server looks like it's still polling, or if the raw archive covers fewer polls than the database
(e.g. `ARCHIVE_RAW` was off for a while). `--force` (or `REBUILD_FORCE: "true"`) overrides both checks. If a startup rebuild fails or
is refused, the reason is logged and the server starts on the existing database.

## Development

Requires Node 24+. The server is TypeScript run directly by Node (type stripping) and uses the
built-in `node:sqlite`, so there is no server build step.

```sh
npm install && npm --prefix web install
npm run dev              # API + collector on :8080
npm --prefix web run dev # UI on :5173, proxies /api to :8080
npm run poll             # run a single poll and exit
npm test                 # node:test suite (collector rules, prices, deals, archive)
npm run typecheck
npm run rebuild          # replay data/raw into a fresh database (see above)
```

## API

Scripts and bots should use the versioned public API. It's documented in the app at `/#/api`, and
`GET /api/v1` lists the endpoints. All endpoints are `GET`, return JSON, allow any origin (CORS), take
`?region=ALL|US|EU|ASIA`, are cached for 60 seconds and are rate-limited per IP.

- `GET /api/v1/prices?items=a,b&min_sellers=3`: current prices
- `GET /api/v1/prices/:item`: every level/variant of one item
- `GET /api/v1/history/:item?days=7&level=2`: price history (hourly; daily closes beyond the retention window)
- `GET /api/v1/listings/:item?side=sell`: open listings with server, map and coordinates
- `GET /api/v1/sales?item=&hours=24`: recent estimated sales
- `GET /api/v1/movers?window=24h|7d`: biggest risers/fallers and most traded
- `GET /api/v1/deals?kind=npc,flip,underpriced`: listings worth buying now
- `GET /api/v1/archive`: daily CSV files (all hourly prices, all sales) for bulk analysis

v1 shapes are stable: fields may be added, but not renamed or removed. The unversioned `/api/*`
endpoints serve the web UI and can change at any time.

In-game code runs on https://adventure.land, so browsers only allow it to call an **HTTPS** API.
To use ALNinja from in-game code, expose it over HTTPS (e.g. Cloudflare Tunnel or a reverse proxy) and
set `TRUST_PROXY` (`cloudflare` for Cloudflare). Node bots can call it over plain http.

## Security

The site is read-only and has no accounts or secrets. All SQL is parameterized, archive downloads are
validated against the archive directory, and player-supplied text is escaped by React (and neutralized
against spreadsheet formulas in the CSV exports). Responses carry a strict Content-Security-Policy, plus
anti-framing, `nosniff`, HSTS and referrer headers. The API is rate-limited per client IP: set
`TRUST_PROXY` correctly when behind a proxy. The compose file runs the container as a non-root user with
a read-only filesystem, no Linux capabilities and `no-new-privileges`. Report security issues privately
privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Not affiliated with Adventure Land. Item names and sprites belong to the game and are
loaded from adventure.land at runtime, not distributed with this project.
