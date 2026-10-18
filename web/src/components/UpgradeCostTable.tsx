import type { GameMeta, UpgradeCosts } from "../api";
import { gold } from "../format";

const chance = (p: number) => `${(p * 100).toFixed(p < 0.1 ? 1 : 0)}%`;
const copies = (n: number) => (n < 10 ? n.toFixed(1) : gold(n));

/** Expected cost of each upgrade or compound level, from +0 and by the cheapest route. */
export function UpgradeCostTable({ costs, meta, selectedLevel }: {
  costs: UpgradeCosts;
  meta: GameMeta | null;
  selectedLevel: number | null;
}) {
  const verb = costs.kind === "compound" ? "compounding" : "upgrading";
  const name = (item: string) => meta?.items[item]?.name ?? item;
  const base = costs.base.price;
  return (
    <div className="panel">
      <h2>Cost to make</h2>
      <p className="muted small" style={{ maxWidth: "80ch" }}>
        Expected gold to make each level by {verb}, at the game's base success chances
        {costs.kind === "compound" ? " (three copies make one; a failure destroys all three)" : " (a failure destroys the item)"}.
        {" "}+0 costs {base == null ? "an unknown amount (nobody's selling it)" : gold(base)}
        {costs.base.shop != null && base === costs.base.shop ? " from a shop" : ""}; scrolls are the cheaper of a shop
        and the market. Grace, offerings and better scrolls raise the chances, so this leans high; a single run
        can go far worse. <strong>Cheapest</strong> buys whichever level is cheapest to start from.
      </p>
      <div className="table-wrap">
        <table className="prices">
          <thead>
            <tr>
              <th>Level</th>
              <th className="num">Chance</th>
              <th className="hide-sm">Scroll</th>
              <th className="num">+0 copies</th>
              <th className="num">From +0</th>
              <th className="num">Market</th>
              <th className="num">Cheapest</th>
            </tr>
          </thead>
          <tbody>
            {costs.steps.map((s) => (
              <tr key={s.level} className={s.level === selectedLevel ? "selected" : undefined}>
                <td>+{s.level}</td>
                <td className="num">{chance(s.chance)}</td>
                <td className="hide-sm">
                  {name(s.scroll)} <span className="muted">{gold(s.scrollPrice)}</span>
                </td>
                <td className="num">{copies(s.baseCopies)}</td>
                <td className="num">{gold(s.fromBase)}</td>
                <td className="num">{gold(s.market)}</td>
                <td className="num">
                  {gold(s.cheapest)}
                  {s.cheapest != null && s.buyAt != null && (
                    <span className="muted small"> {s.buyAt === s.level ? "buy" : `from +${s.buyAt}`}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
