// What an upgraded item costs to make: from cheaper copies, scrolls and the game's success chances.
// Upgrading consumes a scroll and destroys the item on failure; compounding combines three copies of
// one level into one of the next and destroys all three on failure. Chances and scroll grades follow
// the game server's upgrade and compound handlers.
//
// Estimates are expected (average) costs at the base chances. Grace (from earlier failures, by the
// player and the whole server), offerings and higher-grade scrolls only raise the chances, so real
// costs tend to be somewhat lower; any single attempt can of course go much worse.
import { getGameMeta, npcShopPrice, type ItemMeta } from "./gamedata.ts";
import type { MarketRow } from "./market.ts";

/** calculate_item_grade from the game's common_functions.js: 0 normal, 1 high, 2 rare, 3 legendary, 4 max. */
export function itemGrade(def: Pick<ItemMeta, "upgradeable" | "compoundable" | "grades">, level: number): number {
  if (!(def.upgradeable || def.compoundable)) return 0;
  const grades = def.grades ?? [9, 10, 11, 12];
  for (let g = 3; g >= 0; g--) if (level >= grades[g]) return g + 1;
  return 0;
}

export interface UpgradeStep {
  level: number;
  /** Base chance of the attempt that makes this level from the one below. */
  chance: number;
  scroll: string;
  scrollPrice: number | null;
  /** Expected gold to make this level starting from +0 bought at the market (or a shop). */
  fromBase: number | null;
  /** Expected +0 copies used up making one of this level from +0. */
  baseCopies: number;
  /** Expected gold to make this level from the cheapest route to the level below (never buying this level). */
  made: number | null;
  /** The level that route buys at. */
  madeFrom: number | null;
  /** Current lower-quartile ask at this level, or null if nobody's selling it. */
  market: number | null;
  /** Expected gold for the cheapest route: buy a lower level and make this one from it, or just buy it. */
  cheapest: number | null;
  /** The level the cheapest route buys at (this level means buying it outright). */
  buyAt: number | null;
}

export interface UpgradeCosts {
  item: string;
  kind: "upgrade" | "compound";
  region: string;
  base: { market: number | null; shop: number | null; price: number | null };
  steps: UpgradeStep[];
}

/**
 * Expected costs of each level of a plain (no variant) item, priced from a market snapshot (`rows`, of
 * `region`), or null if it can't be upgraded or compounded.
 */
export function upgradeCosts(item: string, region: string, rows: MarketRow[]): UpgradeCosts | null {
  const meta = getGameMeta();
  const def = meta.items[item];
  if (!def || !(def.upgradeable || def.compoundable) || !meta.odds) return null;
  const compound = def.compoundable;

  const asks = new Map<string, number | null>();
  for (const r of rows) {
    if (r.variant === "" && r.sellers > 0 && (r.item === item || /^c?scroll\d$/.test(r.item))) asks.set(`${r.item}|${r.level}`, r.price);
  }
  /** What buying one costs now: the capped lower-quartile ask, or a shop's price if nobody's selling. */
  const buy = (name: string, level: number) => asks.get(`${name}|${level}`) ?? npcShopPrice(name, level, "");

  const shop = npcShopPrice(item, 0, "");
  const baseMarket = asks.get(`${item}|0`) ?? null;
  const basePrice = buy(item, 0);
  // The server's item grade (def.igrade): the grade at +0, with the lost earring as its one exception.
  const igrade = item === "lostearring" ? 2 : itemGrade(def, 0);
  const copies = compound ? 3 : 1;

  const steps: UpgradeStep[] = [];
  let fromBase = basePrice;
  let baseCopies = 1;
  let cheapest = basePrice;
  let buyAt: number | null = basePrice == null ? null : 0;
  for (let level = 1; level <= 12; level++) {
    const grade = itemGrade(def, level - 1);
    if (grade >= 4) break; // max level
    // Compounding from +3 up uses the grade two levels down; upgrading always uses the item's grade.
    const table = compound ? meta.odds.compound : meta.odds.upgrade;
    const chance = table[compound && level - 1 >= 3 ? Math.min(2, itemGrade(def, level - 3)) : Math.min(2, igrade)]?.[level] ?? 0;
    if (!chance) break;
    const scroll = `${compound ? "c" : ""}scroll${grade}`;
    const scrollPrice = buy(scroll, 0);
    const make = (input: number | null) =>
      input == null || scrollPrice == null ? null : (copies * input + scrollPrice) / chance;
    fromBase = make(fromBase);
    baseCopies = (copies * baseCopies) / chance;
    const made = make(cheapest);
    const madeFrom = made == null ? null : buyAt;
    const market = buy(item, level);
    const buyIt = market != null && (made == null || market <= made);
    cheapest = buyIt ? market : made;
    buyAt = buyIt ? level : made == null ? null : buyAt;
    steps.push({ level, chance, scroll, scrollPrice, fromBase, baseCopies, made, madeFrom, market, cheapest, buyAt });
  }
  return {
    item, kind: compound ? "compound" : "upgrade", region,
    base: { market: baseMarket, shop, price: basePrice },
    steps,
  };
}
