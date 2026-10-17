import { useEffect, useMemo, useState } from "react";
import { api, type GameMeta, type OverviewRow } from "../api";
import { ItemIcon } from "../components/ItemIcon";
import { Sparkline } from "../components/Sparkline";
import { gold, percent, variantLabel } from "../format";

const CATEGORIES = ["All", "Weapons", "Armor", "Accessories", "Materials", "Consumables", "Scrolls", "Cosmetics", "Other"];

type SortKey = "name" | "price" | "buyMax" | "sellCount" | "change7d";

export function itemHref(item: string, level: number, variant: string) {
  const q = new URLSearchParams({ level: String(level) });
  if (variant) q.set("variant", variant);
  return `#/item/${encodeURIComponent(item)}?${q}`;
}

export function Change({ value }: { value: number | null }) {
  if (value == null || Math.abs(value) < 0.0005) return <span className="change flat">{value == null ? "—" : "0%"}</span>;
  const up = value > 0;
  return (
    <span className={`change ${up ? "up" : "down"}`}>
      <span aria-hidden="true">{up ? "▲" : "▼"}</span> {percent(value)}
    </span>
  );
}

export function Overview({ meta }: { meta: GameMeta | null }) {
  const [rows, setRows] = useState<OverviewRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [category, setCategory] = useState("All");
  const [search, setSearch] = useState("");
  const [hideThin, setHideThin] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "sellCount", desc: true });

  useEffect(() => {
    api.overview().then(setRows, (e) => setError(String(e)));
  }, []);

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
        (!hideThin || r.sellCount + r.buyCount >= 3) &&
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

  const header = (key: SortKey, label: string, className = "num") => (
    <th className={className} aria-sort={sort.key === key ? (sort.desc ? "descending" : "ascending") : "none"}>
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
                <th className="num hide-sm">Lowest</th>
                {header("buyMax", "Best bid")}
                {header("sellCount", "Sellers")}
                <th className="hide-sm">Last 7 days</th>
                {header("change7d", "7d")}
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => {
                const m = meta?.items[r.item];
                const label = variantLabel(r.level, r.variant, Boolean(m?.upgradeable || m?.compoundable));
                const thin = r.sellCount + r.buyCount < 3;
                return (
                  <tr key={`${r.item}|${r.level}|${r.variant}`} className={thin ? "thin" : ""}>
                    <td>
                      <a className="item-cell" href={itemHref(r.item, r.level, r.variant)}>
                        <ItemIcon icon={m?.icon} />
                        <span>
                          <span className="item-name">{r.name}</span>
                          {label && <span className="badge">{label}</span>}
                          {r.stale && <span className="badge badge-muted" title="No fresh listings this hour">stale</span>}
                        </span>
                      </a>
                    </td>
                    <td className="num price">{gold(r.price)}</td>
                    <td className="num hide-sm">{gold(r.sellMin)}</td>
                    <td className="num">{gold(r.buyMax)}</td>
                    <td className="num" title={`${r.sellCount} merchants selling (${r.quantity} units), ${r.buyCount} buying`}>
                      {r.sellCount}
                      {r.buyCount > 0 && <span className="muted"> / {r.buyCount}</span>}
                    </td>
                    <td className="hide-sm">
                      <Sparkline values={r.sparkline} />
                    </td>
                    <td className="num">
                      <Change value={r.change7d} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {visible.length === 0 && <p className="muted">No items match.</p>}
        </div>
      )}
      <p className="footnote">
        <strong>Price</strong> is the lower-quartile asking price across recently seen merchants, counting each
        merchant's cheapest offer once, so a few overpriced stands don't skew it. Items with fewer than 3 merchants are
        dimmed: treat those prices as rough. Sellers shows merchants selling / buying.
      </p>
    </section>
  );
}
