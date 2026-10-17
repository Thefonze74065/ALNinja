import { useEffect, useMemo, useState } from "react";
import { api, type GameMeta, type ItemDetail, type Variant } from "../api";
import { itemHref } from "../components/ItemCell";
import { ItemIcon } from "../components/ItemIcon";
import { TimeChart, type Series } from "../components/TimeChart";
import { ago, duration, gold, percent, perDay, variantLabel } from "../format";
import { Change } from "./Overview";

const RANGES = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const count = (v: number | null) => (v == null ? "—" : String(Math.round(v)));
const sameVariant = (a: { level: number; variant: string }, b: { level: number; variant: string } | null) =>
  b != null && a.level === b.level && a.variant === b.variant;

export function ItemPage({
  item,
  params,
  meta,
  region,
}: {
  item: string;
  params: URLSearchParams;
  meta: GameMeta | null;
  region: string;
}) {
  // The range lives in the URL (?days=1) so views can be linked; changing it rewrites the URL in place.
  const [days, setDaysState] = useState(() => {
    const d = Number(params.get("days"));
    return RANGES.some((r) => r.days === d) ? d : 7;
  });
  const setDays = (d: number) => {
    setDaysState(d);
    const [path, query = ""] = location.hash.split("?");
    const q = new URLSearchParams(query);
    q.set("days", String(d));
    history.replaceState(null, "", `${path}?${q}`);
  };
  const [detail, setDetail] = useState<ItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    api.item(item, days, region).then(
      (d) => current && setDetail(d),
      (e) => current && setError(String(e)),
    );
    return () => {
      current = false;
    };
  }, [item, days, region]);

  const m = detail?.meta ?? meta?.items[item] ?? null;
  const leveled = Boolean(m?.upgradeable || m?.compoundable);
  const labelOf = (v: { level: number; variant: string }) => variantLabel(v.level, v.variant, leveled) || "base";

  // Variant from the URL, else the one with the most merchants right now.
  const selected = useMemo((): Variant | null => {
    if (!detail?.variants.length) return null;
    const level = params.get("level");
    const variant = params.get("variant") ?? "";
    const fromUrl = detail.variants.find((v) => String(v.level) === level && v.variant === variant);
    if (fromUrl) return fromUrl;
    const latestCount = (v: Variant) => {
      const p = v.points[v.points.length - 1];
      return p ? p.sellers + p.buyers : 0;
    };
    return [...detail.variants].sort((a, b) => latestCount(b) - latestCount(a))[0];
  }, [detail, params]);

  const chart = useMemo(() => {
    if (!selected) return null;
    const h = selected.points;
    const shop = selected.npcPrice;
    const cap = (v: number | null) => (v == null || shop == null ? v : Math.min(v, shop));
    const price: Series[] = [
      // Asks above the shop price are irrelevant (and would flatten the chart), so asks are capped too.
      // Bids aren't: one above the shop price is a real opportunity.
      { label: "Price (lower quartile)", color: "--series-1", values: h.map((p) => (p.sellers ? cap(p.price) : null)) },
      { label: "Median ask", color: "--series-3", values: h.map((p) => cap(p.median)), dash: true },
      { label: "Best bid", color: "--series-2", values: h.map((p) => p.bestBid) },
      ...(shop != null ? [{ label: "NPC shop", color: "--text-muted", values: h.map(() => shop), dash: true }] : []),
    ];
    const merchants: Series[] = [
      { label: "Merchants selling", color: "--series-1", values: h.map((p) => p.sellers), style: "steps" },
      { label: "Merchants buying", color: "--series-2", values: h.map((p) => p.buyers), style: "steps" },
    ];
    const latest = h[h.length - 1];
    const first = h.find((p) => p.sellers && p.price != null);
    const now = latest?.sellers ? cap(latest.price) : null;
    const then = first ? cap(first.price) : null;
    return {
      times: h.map((p) => p.t),
      price,
      merchants,
      latest,
      // Nobody pays more than the shop: headline and change use the capped price.
      headline: latest ? (latest.sellers ? cap(latest.price) : (shop ?? latest.price)) : null,
      change: now != null && then ? (now - then) / then : null,
    };
  }, [selected]);

  const velocity = useMemo(() => detail?.velocity.find((v) => sameVariant(v, selected)) ?? null, [detail, selected]);

  // Trade bars per hour (short ranges) or UTC day, from the later of the range start and the start of
  // tracking (earlier periods weren't observed, so they aren't zeros), with quiet periods filled in.
  const trades = useMemo(() => {
    if (!detail) return null;
    const hourly = days <= 2;
    const step = hourly ? HOUR : DAY;
    const bySlot = new Map((velocity?.trades ?? []).map((d) => [d.t, d]));
    const now = Math.floor(Date.now() / step) * step;
    const tracked = detail.trackingSince != null ? Math.floor(detail.trackingSince / step) * step : now;
    const start = Math.max(now - (hourly ? days * 24 - 1 : days - 1) * step, tracked);
    const times: number[] = [];
    for (let t = start; t <= now; t += step) times.push(t);
    const sold = times.map((t) => bySlot.get(t)?.sold ?? 0);
    const bought = times.map((t) => bySlot.get(t)?.bought ?? 0);
    const totalSold = sold.reduce((a, b) => a + b, 0);
    const totalBought = bought.reduce((a, b) => a + b, 0);
    // Only show the buy-order series when there is one; a lone series fills the whole slot.
    const series: Series[] = totalBought
      ? [
          { label: "Sold by merchants", color: "--series-1", values: sold, style: "bars", barAlign: -1 },
          { label: "Bought via buy orders", color: "--series-2", values: bought, style: "bars", barAlign: 1 },
        ]
      : [{ label: "Sold by merchants", color: "--series-1", values: sold, style: "bars" }];
    const coveredDays = Math.max((Date.now() - start) / DAY, 1);
    return { times, series, totalSold, totalBought, hourly, clipped: start > now - (days - 1) * DAY, coveredDays };
  }, [velocity, detail, days]);

  const listings = useMemo(
    () =>
      (detail?.listings ?? [])
        .filter((l) => sameVariant(l, selected))
        .sort((a, b) => (a.side === b.side ? (a.side === "sell" ? a.price - b.price : b.price - a.price) : a.side === "sell" ? -1 : 1)),
    [detail, selected],
  );
  const sales = useMemo(() => (detail?.sales ?? []).filter((s) => sameVariant(s, selected)), [detail, selected]);
  const rangeLabel = RANGES.find((r) => r.days === days)?.label;

  return (
    <section>
      <a href="#/" className="back">← All items</a>
      <div className="item-header">
        <ItemIcon icon={m?.icon} size={56} />
        <div>
          <h1>{m?.name ?? item}</h1>
          <p className="muted">
            {m?.category ?? "Unknown"} · {m?.type ?? "?"}
            {selected?.npcPrice != null && <> · NPC shop sells at {gold(selected.npcPrice)}</>}
            {selected ? <> · NPCs pay {gold(selected.npcValue)}</> : m && <> · NPC price {gold(m.value)}</>}
          </p>
        </div>
        {chart?.latest && (
          <div className="headline">
            <div className="headline-value">{gold(chart.headline)}</div>
            <div className="muted">
              <Change value={chart.change} /> over {rangeLabel}
              {region !== "ALL" && <> · {region}</>}
            </div>
          </div>
        )}
      </div>

      {error && <p className="error">Couldn't load item: {error}</p>}
      {detail && !detail.variants.length && (
        <p className="muted">
          No price history for this item{region !== "ALL" ? ` in ${region}` : ""} yet.
        </p>
      )}

      {detail && detail.variants.length > 0 && selected && chart && (
        <>
          <div className="toolbar">
            {detail.variants.length > 1 && (
              <nav className="tabs" aria-label="Variants">
                {detail.variants.map((v) => (
                  <a key={`${v.level}|${v.variant}`} href={itemHref(item, v.level, v.variant)} className={v === selected ? "active" : ""}>
                    {labelOf(v)}
                  </a>
                ))}
              </nav>
            )}
            <nav className="tabs range" aria-label="Time range">
              {RANGES.map((r) => (
                <button key={r.days} type="button" className={r.days === days ? "active" : ""} onClick={() => setDays(r.days)}>
                  {r.label}
                </button>
              ))}
            </nav>
          </div>

          <div className="stats">
            <div className="stat">
              <div className="stat-label">Sold ({rangeLabel})</div>
              <div className="stat-value">{trades ? gold(trades.totalSold) : "—"}</div>
              <div className="stat-sub muted">
                {trades && trades.totalSold ? `${perDay(trades.totalSold / trades.coveredDays)} / day` : "units"}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Bought by buy orders</div>
              <div className="stat-value">{trades ? gold(trades.totalBought) : "—"}</div>
              <div className="stat-sub muted">units</div>
            </div>
            <div className="stat">
              <div className="stat-label">Median time to sell</div>
              <div className="stat-value">{duration(velocity?.medianHoursToSell)}</div>
              <div className="stat-sub muted">from listing to sold</div>
            </div>
            <div className="stat">
              <div className="stat-label">Merchants now</div>
              <div className="stat-value">{chart.latest?.sellers ?? 0}</div>
              <div className="stat-sub muted">{chart.latest?.buyers ?? 0} buying</div>
            </div>
          </div>

          <div className="panel">
            <h2>Price</h2>
            <TimeChart
              times={chart.times}
              series={chart.price}
              format={gold}
              resolution="hour"
              hourlyFrom={selected.hourlyFrom}
            />
            {chart.times.length > 0 && chart.times[0] < selected.hourlyFrom && (
              <p className="muted small">
                Daily closes before {new Date(selected.hourlyFrom).toLocaleDateString()}, hourly after. Full hourly
                history is in the <a href="#/api">data archive</a>.
              </p>
            )}
          </div>
          {trades && (
            <div className="panel">
              <h2>Trades per {trades.hourly ? "hour" : "day"}</h2>
              <p className="muted small">
                Estimated units traded at stands each {trades.hourly ? "hour" : "day (UTC)"}
                {trades.clipped && detail?.trackingSince
                  ? `, since tracking began ${new Date(detail.trackingSince).toLocaleDateString()}`
                  : ""}
                .
              </p>
              {trades.totalSold + trades.totalBought > 0 ? (
                <TimeChart
                  times={trades.times}
                  series={trades.series}
                  format={count}
                  height={180}
                  resolution={trades.hourly ? "hour" : "day"}
                  counts
                />
              ) : (
                <p className="muted">No trades recorded in this range.</p>
              )}
            </div>
          )}
          <div className="panel">
            <h2>Time to sell by price</h2>
            <p className="muted small">
              Sell listings opened in the last {rangeLabel}, grouped by asking price relative to the market price when
              they were listed. <em>Sell-through</em> is the share of closed listings that sold rather than being
              pulled or repriced. Times are limited by how often a merchant's data refreshes.
            </p>
            {velocity?.bands.length ? (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Price vs market</th>
                      <th className="num">Listed</th>
                      <th className="num">Sold</th>
                      <th className="num hide-sm">Pulled</th>
                      <th className="num hide-sm">Still up</th>
                      <th className="num">Sell-through</th>
                      <th className="num">Median time to sell</th>
                    </tr>
                  </thead>
                  <tbody>
                    {velocity.bands.map((b) => (
                      <tr key={b.band}>
                        <td>{b.band}</td>
                        <td className="num">{b.listings}</td>
                        <td className="num">{b.sold}</td>
                        <td className="num hide-sm">{b.pulled}</td>
                        <td className="num hide-sm">{b.open}</td>
                        <td className="num">{b.sellThrough == null ? "—" : percent(b.sellThrough).replace("+", "")}</td>
                        <td className="num">{duration(b.medianHoursToSell)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">No listings opened in this range yet.</p>
            )}
          </div>
          <div className="panel">
            <h2>Merchants</h2>
            <TimeChart
              times={chart.times}
              series={chart.merchants}
              format={count}
              height={160}
              resolution="hour"
              hourlyFrom={selected.hourlyFrom}
              counts
            />
          </div>
        </>
      )}

      {detail && (
        <div className="panel">
          <h2>Current listings {selected && <span className="muted">({labelOf(selected)})</span>}</h2>
          {listings.length === 0 ? (
            <p className="muted">No open listings.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Side</th>
                    <th>Merchant</th>
                    <th>Server</th>
                    <th className="num">Price</th>
                    <th className="num">Qty</th>
                    <th className="hide-sm">Listed</th>
                    <th>Merchant seen</th>
                  </tr>
                </thead>
                <tbody>
                  {listings.map((l) => (
                    <tr key={`${l.merchant}|${l.side}|${l.price}|${l.listedAt}`}>
                      <td><span className={`side side-${l.side}`}>{l.side === "sell" ? "Selling" : "Buying"}</span></td>
                      <td>{l.merchant}</td>
                      <td title={`${l.map} (${Math.round(l.x)}, ${Math.round(l.y)})`}>{l.region} {l.server}</td>
                      <td className="num price">{gold(l.price)}</td>
                      <td className="num">{l.quantity}</td>
                      <td className="hide-sm muted">{ago(l.listedAt)}</td>
                      <td className="muted">{ago(l.merchantSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {detail && (
        <div className="panel">
          <h2>Recent sales</h2>
          <p className="muted small">
            Estimated: stock that left a stand priced near the market and wasn't put back within 2 hours (so the
            latest sales appear with that delay). Quantity drops count as partial sales.
          </p>
          {sales.length === 0 ? (
            <p className="muted">No sales seen in the last {rangeLabel}.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Trade</th>
                    <th>Merchant</th>
                    <th className="hide-sm">Region</th>
                    <th className="num">Price</th>
                    <th className="num">Qty</th>
                    <th className="num hide-sm">Time listed</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((s, i) => (
                    <tr key={`${s.merchant}|${s.at}|${i}`}>
                      <td><span className={`side side-${s.side}`}>{s.side === "sell" ? "Sold" : "Bought"}</span></td>
                      <td>{s.merchant}</td>
                      <td className="hide-sm">{s.region ?? "—"}</td>
                      <td className="num price">{gold(s.price)}</td>
                      <td className="num">{s.quantity}</td>
                      <td className="num hide-sm muted">{duration((s.at - s.listedAt) / 3_600_000)}</td>
                      <td className="muted">{ago(s.at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
