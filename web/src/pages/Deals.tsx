import { useEffect, useState } from "react";
import { api, type Deal, type DealKind, type DealWhere, type GameMeta } from "../api";
import { ItemCell } from "../components/ItemCell";
import { ago, gold, percent } from "../format";

const KINDS: { kind: DealKind; label: string; worth: string; blurb: string }[] = [
  {
    kind: "npc",
    label: "Sell to NPC",
    worth: "NPC pays",
    blurb: "An NPC pays more than the asking price: buy it and sell it to any NPC merchant. Guaranteed while the listing is up.",
  },
  {
    kind: "flip",
    label: "Flips",
    worth: "Bid",
    blurb: "Another merchant's buy order pays more than this asking price: buy here, sell into their order.",
  },
  {
    kind: "underpriced",
    label: "Below market",
    worth: "Next ask",
    blurb:
      "Listed well under the cheapest competing seller, the price you could relist at. A resale estimate, not a guarantee: rare items often sit for a while.",
  },
];

function Where({ w }: { w: DealWhere }) {
  return (
    <span title={`${w.map} (${Math.round(w.x)}, ${Math.round(w.y)}) · seen ${ago(w.merchantSeenAt)}`}>
      {w.merchant} <span className="muted">{w.region} {w.server}</span>
    </span>
  );
}

export function Deals({ meta, region }: { meta: GameMeta | null; region: string }) {
  const [kind, setKind] = useState<DealKind>("npc");
  const [minDiscount, setMinDiscount] = useState("0.2");
  const [sort, setSort] = useState<"profit" | "discount">("profit");
  const [deals, setDeals] = useState<Deal[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    setError(null);
    setDeals(null);
    api.deals(region, { kind, min_discount: minDiscount, sort, limit: "200" }).then(
      (d) => current && setDeals(d),
      (e) => current && setError(String(e)),
    );
    return () => {
      current = false;
    };
  }, [region, kind, minDiscount, sort]);

  const info = KINDS.find((k) => k.kind === kind)!;

  return (
    <section>
      <div className="toolbar">
        <h1 className="page-title">Deals</h1>
        <nav className="tabs range" aria-label="Deal type">
          {KINDS.map((k) => (
            <button key={k.kind} type="button" className={k.kind === kind ? "active" : ""} onClick={() => setKind(k.kind)}>
              {k.label}
            </button>
          ))}
        </nav>
      </div>
      <p className="muted small">{info.blurb}</p>
      <div className="toolbar">
        {kind === "underpriced" && (
          <label className="check">
            At least
            <select value={minDiscount} onChange={(e) => setMinDiscount(e.target.value)}>
              {["0.1", "0.2", "0.3", "0.5"].map((d) => (
                <option key={d} value={d}>{Number(d) * 100}%</option>
              ))}
            </select>
            under
          </label>
        )}
        <label className="check">
          Sort by
          <select value={sort} onChange={(e) => setSort(e.target.value as "profit" | "discount")}>
            <option value="profit">total profit</option>
            <option value="discount">% under</option>
          </select>
        </label>
      </div>

      {error && <p className="error">Couldn't load deals: {error}</p>}
      {!deals && !error && <p className="muted">Loading…</p>}
      {deals && deals.length === 0 && <p className="muted">Nothing right now. Deals are rechecked every poll.</p>}
      {deals && deals.length > 0 && (
        <div className="table-wrap">
          <table className="prices">
            <thead>
              <tr>
                <th>Item</th>
                <th className="num">Ask</th>
                <th className="num">{info.worth}</th>
                <th className="num">Profit/unit</th>
                <th className="num hide-sm">Under</th>
                <th className="num hide-sm">Qty</th>
                <th className="num">Total</th>
                <th>Buy from</th>
                {kind === "flip" && <th>Sell to</th>}
              </tr>
            </thead>
            <tbody>
              {deals.map((d, i) => (
                <tr key={`${d.seller.merchant}|${d.item}|${d.level}|${d.price}|${i}`}>
                  <td>
                    <ItemCell meta={meta} row={d} />
                  </td>
                  <td className="num">{gold(d.price)}</td>
                  <td className="num">{gold(d.reference)}</td>
                  <td className="num price">{gold(d.profitPerUnit)}</td>
                  <td className="num hide-sm">{percent(d.discount).replace("+", "")}</td>
                  <td className="num hide-sm">{d.quantity}</td>
                  <td className="num price">{gold(d.totalProfit)}</td>
                  <td><Where w={d.seller} /></td>
                  {kind === "flip" && <td>{d.buyer && <Where w={d.buyer} />}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="footnote">
        Only merchants seen in the last 48 hours are included, so check a listing is still up before travelling. Hover a
        merchant for their map position. Available to scripts at <a href="#/api"><code>/api/v1/deals</code></a>.
      </p>
    </section>
  );
}
