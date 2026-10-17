import { useEffect, useState } from "react";
import { api, type GameMeta, type MarketRow, type Movers as MoversData } from "../api";
import { ItemCell } from "../components/ItemCell";
import { gold, perDay } from "../format";
import { Change } from "./Overview";

const WINDOWS = [
  { key: "24h", label: "24 hours", hours: 24 },
  { key: "7d", label: "7 days", hours: 24 * 7 },
] as const;

function ChangeTable({ rows, meta, field }: { rows: MarketRow[]; meta: GameMeta | null; field: "change24h" | "change7d" }) {
  return (
    <div className="table-wrap">
      <table className="prices">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Price</th>
            <th className="num hide-sm">Sellers</th>
            <th className="num">Change</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={`${r.item}|${r.level}|${r.variant}`}>
              <td><ItemCell meta={meta} row={r} /></td>
              <td className="num price">{gold(r.price)}</td>
              <td className="num hide-sm">{r.sellers}</td>
              <td className="num"><Change value={r[field]} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Movers({ meta, region, trackingSince }: { meta: GameMeta | null; region: string; trackingSince: number | null }) {
  const [windowKey, setWindowKey] = useState<"24h" | "7d">("24h");
  const [data, setData] = useState<MoversData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    api.movers(region, windowKey).then(
      (d) => current && setData(d),
      (e) => current && setError(String(e)),
    );
    return () => {
      current = false;
    };
  }, [region, windowKey]);

  const win = WINDOWS.find((w) => w.key === windowKey)!;
  const field = windowKey === "24h" ? "change24h" : "change7d";
  const availableAt = trackingSince ? trackingSince + win.hours * 3_600_000 : null;
  const waiting = availableAt != null && availableAt > Date.now();
  const empty = (
    <p className="muted">
      {waiting
        ? `Needs ${win.label} of history: available from ${new Date(availableAt!).toLocaleString()}.`
        : "No items moved with at least 3 sellers now and 2 at the start of the window."}
    </p>
  );

  return (
    <section>
      <div className="toolbar">
        <h1 className="page-title">Biggest movers</h1>
        <nav className="tabs range" aria-label="Window">
          {WINDOWS.map((w) => (
            <button key={w.key} type="button" className={w.key === windowKey ? "active" : ""} onClick={() => setWindowKey(w.key)}>
              {w.label}
            </button>
          ))}
        </nav>
      </div>
      {error && <p className="error">Couldn't load movers: {error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && (
        <>
          <div className="grid-2">
            <div className="panel">
              <h2>Rising</h2>
              {data.gainers.length ? <ChangeTable rows={data.gainers} meta={meta} field={field} /> : empty}
            </div>
            <div className="panel">
              <h2>Falling</h2>
              {data.losers.length ? <ChangeTable rows={data.losers} meta={meta} field={field} /> : empty}
            </div>
          </div>
          <div className="panel">
            <h2>Most traded</h2>
            <p className="muted small">Estimated units per day over the last 7 days (or since tracking began).</p>
            {data.mostTraded.length ? (
              <div className="table-wrap">
                <table className="prices">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th className="num">Price</th>
                      <th className="num">Sold/day</th>
                      <th className="num hide-sm">Bought/day</th>
                      <th className="num hide-sm">Value/day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.mostTraded.map((r) => (
                      <tr key={`${r.item}|${r.level}|${r.variant}`}>
                        <td><ItemCell meta={meta} row={r} /></td>
                        <td className="num price">{gold(r.price)}</td>
                        <td className="num">{perDay(r.soldPerDay)}</td>
                        <td className="num hide-sm">{perDay(r.boughtPerDay)}</td>
                        <td className="num hide-sm">{r.price ? gold((r.soldPerDay + r.boughtPerDay) * r.price) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="muted">No sales recorded yet.</p>
            )}
          </div>
          <p className="footnote">
            Changes compare the lower-quartile price now against the price {win.label} ago. Items need at least 3
            sellers now and 2 then, so a single stand repricing can't top the list.
          </p>
        </>
      )}
    </section>
  );
}
