import { useEffect, useMemo, useState } from "react";
import { api, type GameMeta, type MarketRow } from "../api";
import { ItemCell } from "../components/ItemCell";
import { Sparkline } from "../components/Sparkline";
import { gold, percent, perDay } from "../format";

const CATEGORIES = ["All", "Weapons", "Armor", "Accessories", "Materials", "Consumables", "Scrolls", "Cosmetics", "Other"];

type SortKey = "name" | "price" | "bestBid" | "sellers" | "soldPerDay" | "change24h" | "change7d";

export function Change({ value }: { value: number | null }) {
  if (value == null || Math.abs(value) < 0.0005) return <span className="change flat">{value == null ? "—" : "0%"}</span>;
  const up = value > 0;
  return (
    <span className={`change ${up ? "up" : "down"}`}>
      <span aria-hidden="true">{up ? "▲" : "▼"}</span> {percent(value)}
    </span>
  );
}

export function Overview({ meta, region }: { meta: GameMeta | null; region: string }) {
  const [rows, setRows] = useState<MarketRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("All");
  const [search, setSearch] = useState("");
  const [hideThin, setHideThin] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "sellers", desc: true });

  useEffect(() => {
    let current = true;
    setError(null);
    api.overview(region).then(
      (r) => current && setRows(r),
      (e) => current && setError(String(e)),
    );
    return () => {
      current = false;
    };
  }, [region]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { All: rows?.length ?? 0 };
    for (const r of rows ?? []) c[r.category] = (c[r.category] ?? 0) + 1;
    return c;
  }, [rows]);

  const visible = useMemo(() => {
    if (!rows) return [];
    const q = search.trim().toLowerCase();
    const filtered = rows.filter(
      (r) =>
        (category === "All" || r.category === category) &&
        (!hideThin || r.sellers + r.buyers >= 3) &&
        (!q || r.name.toLowerCase().includes(q) || r.item.toLowerCase().includes(q)),
    );
    const dir = sort.desc ? -1 : 1;
    return filtered.sort((a, b) => {
      if (sort.key === "name") return dir * (a.name.localeCompare(b.name) || a.level - b.level);
      const av = a[sort.key] ?? -Infinity;
      const bv = b[sort.key] ?? -Infinity;
      return dir * (av - bv) || a.name.localeCompare(b.name) || a.level - b.level;
    });
  }, [rows, category, search, hideThin, sort]);

  const header = (key: SortKey, label: string, className = "num", title?: string) => (
    <th className={className} title={title} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
      <button
        type="button"
        onClick={() => setSort((s) => ({ key, desc: s.key === key ? !s.desc : key !== "name" }))}
      >
        {label}
        <span className="sort-arrow">{sort.key === key ? (sort.desc ? "▼" : "▲") : ""}</span>
      </button>
    </th>
  );

  return (
    <section>
      <div className="toolbar">
        <input
          type="search"
          placeholder="Search items…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search items"
        />
        <label className="check">
          <input type="checkbox" checked={hideThin} onChange={(e) => setHideThin(e.target.checked)} />
          Hide items with fewer than 3 merchants
        </label>
      </div>
      <nav className="tabs" aria-label="Categories">
        {CATEGORIES.filter((c) => c === "All" || counts[c]).map((c) => (
          <button key={c} type="button" className={c === category ? "active" : ""} onClick={() => setCategory(c)}>
            {c} <span className="tab-count">{counts[c] ?? 0}</span>
          </button>
        ))}
      </nav>

      {error && <p className="error">Couldn't load prices: {error}</p>}
      {!rows && !error && <p className="muted">Loading prices…</p>}
      {rows && rows.length === 0 && (
        <p className="muted">No price data yet. The first poll will populate this within a few minutes.</p>
      )}

      {rows && rows.length > 0 && (
        <div className="table-wrap">
          <table className="prices">
            <thead>
              <tr>
                {header("name", "Item", "")}
                {header("price", "Price")}
                <th className="num hide-md">Lowest</th>
                {header("bestBid", "Best bid", "num hide-sm")}
                {header("sellers", "Sellers")}
                {header("soldPerDay", "Sold/day", "num", "Estimated units sold per day (7-day average)")}
                <th className="hide-md">Last 7 days</th>
                {header("change24h", "24h")}
                {header("change7d", "7d", "num hide-sm")}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={`${r.item}|${r.level}|${r.variant}`} className={r.sellers + r.buyers < 3 ? "thin" : ""}>
                  <td>
                    <ItemCell meta={meta} row={r} />
                  </td>
                  <td className="num price">
                    {r.npcPrice != null && r.price === r.npcPrice && (
                      <span className="badge badge-muted" title={`NPC shops sell this for ${gold(r.npcPrice)}; player asks are higher`}>
                        NPC
                      </span>
                    )}{" "}
                    {gold(r.price)}
                  </td>
                  <td className="num hide-md">{gold(r.lowest)}</td>
                  <td className="num hide-sm">{gold(r.bestBid)}</td>
                  <td className="num" title={`${r.sellers} merchants selling (${r.quantity} units), ${r.buyers} buying`}>
                    {r.sellers}
                    {r.buyers > 0 && <span className="muted"> / {r.buyers}</span>}
                  </td>
                  <td className="num">{perDay(r.soldPerDay)}</td>
                  <td className="hide-md">
                    <Sparkline values={r.sparkline} />
                  </td>
                  <td className="num">
                    <Change value={r.change24h} />
                  </td>
                  <td className="num hide-sm">
                    <Change value={r.change7d} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {visible.length === 0 && <p className="muted">No items match.</p>}
        </div>
      )}
      <p className="footnote">
        <strong>Price</strong> is the lower-quartile asking price across recently seen merchants, counting each
        merchant's cheapest offer once, so a few overpriced stands don't skew it. Items with fewer than 3 merchants are
        dimmed: treat those prices as rough. Items NPC shops sell are capped at the shop price (marked{" "}
        <span className="badge badge-muted">NPC</span> where the shop is cheaper). <strong>Sold/day</strong> is estimated from stock disappearing from
        stands priced near the market. Changes need at least 2 sellers at both ends.
      </p>
    </section>
  );
}
