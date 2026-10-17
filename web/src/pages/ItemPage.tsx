import { useEffect, useMemo, useState } from "react";
import { api, type GameMeta, type ItemDetail } from "../api";
import { ItemIcon } from "../components/ItemIcon";
import { TimeChart, type Series } from "../components/TimeChart";
import { ago, gold, variantLabel } from "../format";
import { Change, itemHref } from "./Overview";

const RANGES = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
];

const count = (v: number | null) => (v == null ? "—" : String(Math.round(v)));

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
  const [days, setDays] = useState(7);
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

  // Variant from the URL, else the one with the most listings right now.
  const selected = useMemo(() => {
    if (!detail?.variants.length) return null;
    const level = params.get("level");
    const variant = params.get("variant") ?? "";
    const fromUrl = detail.variants.find((v) => String(v.level) === level && v.variant === variant);
    if (fromUrl) return fromUrl;
    const latestCount = (h: ItemDetail["variants"][number]["history"]) => {
      const p = h[h.length - 1];
      return p ? p.sellCount + p.buyCount : 0;
    };
    return [...detail.variants].sort((a, b) => latestCount(b.history) - latestCount(a.history))[0];
  }, [detail, params]);

  const chart = useMemo(() => {
    if (!selected) return null;
    const h = selected.history;
    const price: Series[] = [
      { label: "Price (lower quartile)", color: "--series-1", values: h.map((p) => p.p25) },
      { label: "Median ask", color: "--series-3", values: h.map((p) => p.median), dash: true },
      { label: "Best bid", color: "--series-2", values: h.map((p) => p.buy) },
    ];
    const volume: Series[] = [{ label: "Merchants selling", color: "--series-1", values: h.map((p) => p.sellCount), bars: true }];
    const latest = h[h.length - 1];
    const first = h.find((p) => p.p25 != null);
    return {
      times: h.map((p) => p.t),
      price,
      volume,
      latest,
      change: latest?.p25 != null && first?.p25 ? (latest.p25 - first.p25) / first.p25 : null,
    };
  }, [selected]);

  const listings = useMemo(
    () =>
      (detail?.listings ?? [])
        .filter((l) => selected && l.level === selected.level && l.variant === selected.variant)
        .sort((a, b) => (a.side === b.side ? (a.side === "sell" ? a.price - b.price : b.price - a.price) : a.side === "sell" ? -1 : 1)),
    [detail, selected],
  );
  const closed = useMemo(
    () => (detail?.recentlyClosed ?? []).filter((l) => selected && l.level === selected.level && l.variant === selected.variant),
    [detail, selected],
  );

  return (
    <section>
      <a href="#/" className="back">← All items</a>
      <div className="item-header">
        <ItemIcon icon={m?.icon} size={56} />
        <div>
          <h1>{m?.name ?? item}</h1>
          <p className="muted">
            {m?.category ?? "Unknown"} · {m?.type ?? "?"}
            {m && <> · NPC value {gold(m.value)}</>}
          </p>
        </div>
        {chart?.latest && (
          <div className="headline">
            <div className="headline-value">{gold(chart.latest.p25 ?? chart.latest.buy)}</div>
            <div className="muted">
              <Change value={chart.change} /> over {RANGES.find((r) => r.days === days)?.label}
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
                  <a
                    key={`${v.level}|${v.variant}`}
                    href={itemHref(item, v.level, v.variant)}
                    className={v === selected ? "active" : ""}
                  >
                    {variantLabel(v.level, v.variant, leveled) || "base"}
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

          <div className="panel">
            <h2>Price</h2>
            <TimeChart times={chart.times} series={chart.price} format={gold} />
          </div>
          <div className="panel">
            <h2>Merchants selling</h2>
            <TimeChart times={chart.times} series={chart.volume} format={count} height={140} />
          </div>
        </>
      )}

      {detail && (
        <div className="panel">
          <h2>Current listings {selected && <span className="muted">({variantLabel(selected.level, selected.variant, leveled) || "base"})</span>}</h2>
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
                    <tr key={`${l.merchant}|${l.side}|${l.price}|${l.first_seen}`}>
                      <td><span className={`side side-${l.side}`}>{l.side === "sell" ? "Selling" : "Buying"}</span></td>
                      <td>{l.merchant}</td>
                      <td title={`${l.map} (${Math.round(l.x)}, ${Math.round(l.y)})`}>{l.server_region} {l.server_identifier}</td>
                      <td className="num price">{gold(l.price)}</td>
                      <td className="num">{l.quantity}</td>
                      <td className="hide-sm muted">{ago(l.first_seen)}</td>
                      <td className="muted">{ago(l.last_seen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {closed.length > 0 && (
        <div className="panel">
          <h2>Recently removed</h2>
          <p className="muted small">
            Listings that disappeared from a merchant's stand: usually sold, sometimes withdrawn. Repriced listings
            reappear above at their new price.
          </p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Side</th>
                  <th>Merchant</th>
                  <th className="num">Price</th>
                  <th className="num">Qty</th>
                  <th>Outcome</th>
                  <th>When</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((l) => (
                  <tr key={`${l.merchant}|${l.side}|${l.price}|${l.first_seen}`}>
                    <td><span className={`side side-${l.side}`}>{l.side === "sell" ? "Sell" : "Buy"}</span></td>
                    <td>{l.merchant}</td>
                    <td className="num price">{gold(l.price)}</td>
                    <td className="num">{l.initial_quantity}</td>
                    <td className="muted">{l.close_reason === "repriced" ? "Repriced" : "Removed"}</td>
                    <td className="muted">{ago(l.closed_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
