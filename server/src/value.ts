// A suggested price for selling one item at a given level: what a bot or console should list it at.
// Uses the best evidence there is, in order: other merchants' current asks (capped at the cost to
// make, and at what it has sold for this week, since asks above that aren't selling), what it has
// sold for (its latest sales, however old), the last known asking price, the expected cost to make
// it (upgraded or compounded items), and what an NPC pays.
// Never below what an NPC or the best buy order pays, since selling there is always an option.
import { config } from "./config.ts";
import { npcSellValue } from "./gamedata.ts";
import { DAY, HOUR, history, openListings, recentSales, snapshot } from "./market.ts";
import { upgradeCosts } from "./upgrades.ts";

/** How far back sales and prices count as evidence; the newest evidence wins. */
const LOOKBACK_DAYS = 365;
/** The suggestion from sales is the median of at most this many of the latest. */
const SALES_SAMPLE = 10;
/** Sales this recent outrank current asks that are higher (those asks aren't what it sells for). */
const FRESH_SALES_MS = 7 * DAY;

export type ValueBasis = "asks" | "sales" | "history" | "cost_to_make" | "bid" | "npc";

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/** `exclude`: a merchant whose own listings aren't competition (the seller's). */
export function suggestedValue(item: string, level: number, variant: string, region: string, exclude?: string) {
  const now = Date.now();
  const rows = snapshot(region);
  const here = openListings(item, region).filter((l) =>
    l.level === level && l.variant === variant && l.merchantSeenAt >= now - config.freshHours * HOUR);
  const mine = (l: { merchant: string }) => l.merchant.toLowerCase() === exclude?.toLowerCase();
  const others = here.filter((l) => !mine(l));
  // Price history includes the seller's own listing; only trust it from before they listed.
  const ownSince = Math.min(...here.filter((l) => mine(l) && l.side === "sell").map((l) => l.listedAt));
  const askPrices = others.filter((l) => l.side === "sell").map((l) => l.price).sort((a, b) => a - b);
  const sellers = new Set(others.filter((l) => l.side === "sell").map((l) => l.merchant)).size;
  const asks = askPrices.length ? { lowest: askPrices[0], sellers } : null;
  const bids = others.filter((l) => l.side === "buy").map((l) => l.price);
  const bestBid = bids.length ? Math.max(...bids) : null;
  const npc = npcSellValue(item, level);

  const sold = recentSales(item, region, now - LOOKBACK_DAYS * DAY, 5000)
    .filter((s) => s.side === "sell" && s.level === level && s.variant === variant)
    .slice(0, SALES_SAMPLE); // newest first
  const sales = sold.length
    ? {
        count: sold.length, median: median(sold.map((s) => s.price))!, last: sold[0].price, lastAt: sold[0].at,
        oldestAt: sold[sold.length - 1].at,
      }
    : null;

  const points = history(item, region, LOOKBACK_DAYS)
    .find((v) => v.level === level && v.variant === variant)?.points as { t: number; price: number | null; sellers: number }[] | undefined;
  // Asking prices only: a point with no sellers carries the best bid instead.
  const lastKnown = [...(points ?? [])].reverse().find((p) => p.price != null && p.sellers > 0 && p.t + HOUR <= ownSince);
  const lastPrice = lastKnown ? { price: lastKnown.price!, at: lastKnown.t } : null;

  const step = level && !variant ? upgradeCosts(item, region, rows)?.steps.find((s) => s.level === level) : undefined;
  const costToMake = step?.made != null ? { expected: step.made, from: step.madeFrom, fromBase: step.fromBase } : null;

  let basis: ValueBasis = "npc";
  let suggested: number = npc;
  // Nobody pays another seller more than it costs to make one (an estimate that already leans high).
  if (asks) {
    [basis, suggested] = costToMake && costToMake.expected < asks.lowest
      ? ["cost_to_make", costToMake.expected]
      : ["asks", asks.lowest];
    if (sales && sales.lastAt >= now - FRESH_SALES_MS && sales.median < suggested) [basis, suggested] = ["sales", sales.median];
  } else if (sales) [basis, suggested] = ["sales", sales.median];
  else if (lastPrice) [basis, suggested] = ["history", lastPrice.price];
  else if (costToMake) [basis, suggested] = ["cost_to_make", costToMake.expected];
  const floor = Math.max(npc, bestBid ?? 0);
  if (suggested < floor) [basis, suggested] = [bestBid != null && bestBid >= npc ? "bid" : "npc", floor];

  return {
    item, level, variant, region,
    /** Gold to list one unit at, from `basis`. Undercut or round as you like. */
    suggested: Math.round(suggested),
    basis,
    asks,
    bestBid,
    sales,
    lastPrice,
    costToMake,
    npcValue: npc,
  };
}
