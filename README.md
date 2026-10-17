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
3. **Raw archive**: every raw response is saved gzipped under `data/raw/YYYY-MM-DD/`, so you
   can reprocess history later if the pricing logic changes (~3 MB/day at 10-minute polls).

Item names, categories and sprite icons come from the game's own `https://adventure.land/data.js`,
refreshed daily and cached in `data/gamedata.json`.

## Running on Docker

GitHub Actions builds the image on every push to `main` and publishes it as
`ghcr.io/thefonze74065/alninja:latest` (plus `sha-<commit>` tags, and version tags for `v*` git tags).
`docker-compose.yml` pulls that image:

```sh
docker compose pull && docker compose up -d
```

The repo is private, so its package is too. Either make the package public (GitHub → Packages →
alninja → Package settings → Change visibility), or log the host in once with a classic personal
access token that has `read:packages`: `docker login ghcr.io -u Thefonze74065`.

Then open `http://<host>:8080`. Everything lives in the `/data` volume (SQLite database, game-data
cache, raw archive). In `docker-compose.yml`, point it at a dataset, e.g.
`/mnt/tank/apps/alninja:/data`. The compose file runs the container as `568:568` (TrueNAS's `apps` user), so that dataset must be
writable by it; change `user:` if the dataset belongs to someone else. Without `user:` the image runs as 1000:1000.

| Variable | Default | |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `POLL_INTERVAL_MINUTES` | `10` | How often to poll ALData |
| `FRESH_HOURS` | `48` | Ignore merchants not seen by ALData for longer than this |
| `ARCHIVE_RAW` | `true` | Keep gzipped raw `/merchants` responses |
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

- `GET /api/overview?region=EU`: latest price per item/level/variant with a 7-day daily sparkline and change
- `GET /api/items/:item?days=30&region=EU`: hourly history per variant, open listings, recently closed listings
- `GET /api/meta`: item metadata (names, categories, icons)
- `GET /api/status`: last poll, counts, tracking start, known regions

`region` is optional on every endpoint; omitted (or `ALL`) means all regions combined.
