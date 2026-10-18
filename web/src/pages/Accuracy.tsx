import { useEffect, useState } from "react";
import { api, type Accuracy as AccuracyData, type GameMeta } from "../api";
import { ItemCell } from "../components/ItemCell";
import { ago, gold, percent } from "../format";

const RANGES = [1, 7, 30, 90];

const share = (v: number | null) => (v == null ? "—" : percent(v).replace("+", ""));

export function Accuracy({ meta }: { meta: GameMeta | null }) {
  const [days, setDays] = useState(7);
  const [data, setData] = useState<AccuracyData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    api.accuracy(days).then(
      (d) => current && setData(d),
      (e) => current && setError(String(e)),
    );
    return () => {
      current = false;
    };
  }, [days]);

  const reasons = Object.entries(data?.missedReasons ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <section>
      <div className="toolbar">
        <h1 className="page-title">Sales accuracy</h1>
        <nav className="tabs range" aria-label="Range">
          {RANGES.map((d) => (
            <button key={d} type="button" className={d === days ? "active" : ""} onClick={() => setDays(d)}>
              {d === 1 ? "24h" : `${d}d`}
            </button>
          ))}
        </nav>
      </div>
      <p className="muted small" style={{ maxWidth: "80ch" }}>
        Sales on this site are mostly <em>estimated</em> from merchant stands changing. Characters running the{" "}
        <a href="#/api">reporting snippet</a> witness real trades in game, and this page compares the two wherever
        both exist. <strong>Recall</strong>: of the units really traded at merchants we track, how many we also
        estimated. <strong>Precision</strong>: of the units we estimated as sold while a reporter was watching that
        merchant, how many really were.
      </p>

      {error && <p className="error">Couldn't load accuracy: {error}</p>}
      {!data && !error && <p className="muted">Loading…</p>}
      {data && data.reporters === 0 && data.observed.trades === 0 && (
        <p className="muted">No reports in this range yet. Set up the reporting snippet from the API page to start.</p>
      )}

      {data && (data.reporters > 0 || data.observed.trades > 0) && (
        <>
          <div className="stats">
            <div className="stat">
              <div className="stat-label">Recall</div>
              <div className="stat-value">{share(data.recall)}</div>
              <div className="stat-sub muted">real units we estimated</div>
            </div>
            <div className="stat">
              <div className="stat-label">Precision</div>
              <div className="stat-value">{share(data.precision)}</div>
              <div className="stat-sub muted">of {data.checkable.units} checkable estimated units</div>
            </div>
            <div className="stat">
              <div className="stat-label">Trades seen</div>
              <div className="stat-value">{data.observed.trades}</div>
              <div className="stat-sub muted">
                {data.observed.units} units{data.observed.untracked ? `, ${data.observed.untracked} at untracked merchants` : ""}
                {data.observed.unverified ? ` · ${data.observed.unverified} unverified reports set aside` : ""}
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Coverage</div>
              <div className="stat-value">{Math.round(data.merchantHoursObserved)}h</div>
              <div className="stat-sub muted">merchant-hours watched by {data.reporters} reporter(s)</div>
            </div>
          </div>

          {reasons.length > 0 && (
            <div className="panel">
              <h2>Why real trades were missed</h2>
              <div className="table-wrap">
                <table>
                  <tbody>
                    {reasons.map(([reason, n]) => (
                      <tr key={reason}>
                        <td>{reason}</td>
                        <td className="num">{n}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="panel">
            <h2>Missed: seen in game, not estimated</h2>
            {data.missed.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <div className="table-wrap">
                <table className="prices">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Merchant</th>
                      <th className="hide-sm">With</th>
                      <th className="num">Price</th>
                      <th className="num">Qty</th>
                      <th>Why</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.missed.map((m, i) => (
                      <tr key={i}>
                        <td><ItemCell meta={meta} row={m} /></td>
                        <td>{m.merchant}</td>
                        <td className="hide-sm">{m.counterparty}</td>
                        <td className="num">{gold(m.price)}</td>
                        <td className="num">{m.quantity}</td>
                        <td className="muted">{m.reason}</td>
                        <td className="muted">{ago(m.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="panel">
            <h2>Unconfirmed: estimated while watched, not seen in game</h2>
            <p className="muted small">
              Estimated sales at a merchant a reporter had in view, with no matching trade witnessed: likely
              withdrawals or other false positives in the estimation rules.
            </p>
            {data.falsePositives.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <div className="table-wrap">
                <table className="prices">
                  <thead>
                    <tr>
                      <th>Item</th>
                      <th>Merchant</th>
                      <th className="num">Price</th>
                      <th className="num">Units</th>
                      <th>When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.falsePositives.map((f, i) => (
                      <tr key={i}>
                        <td><ItemCell meta={meta} row={f} /></td>
                        <td>{f.merchant}</td>
                        <td className="num">{gold(f.price)}</td>
                        <td className="num">{f.unconfirmed}{f.unconfirmed < f.quantity ? ` of ${f.quantity}` : ""}</td>
                        <td className="muted">{ago(f.at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
