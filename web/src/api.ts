export interface ItemIconSpec {
  file: string;
  size: number;
  columns: number;
  rows: number;
  x: number;
  y: number;
}

export interface ItemMeta {
  name: string;
  type: string;
  category: string;
  value: number;
  upgradeable: boolean;
  compoundable: boolean;
  stackable: boolean;
  icon: ItemIconSpec | null;
}

export interface GameMeta {
  version: number | null;
  items: Record<string, ItemMeta>;
}

export interface MarketRow {
  item: string;
  name: string;
  category: string;
  level: number;
  variant: string;
  price: number | null;
  /** NPC shop price, when a shop sells this item; `price` never exceeds it. */
  npcPrice: number | null;
  lowest: number | null;
  median: number | null;
  bestBid: number | null;
  sellers: number;
  buyers: number;
  quantity: number;
  npcValue: number | null;
  change24h: number | null;
  change7d: number | null;
  soldPerDay: number;
  boughtPerDay: number;
  sparkline: (number | null)[];
  updated: number;
  stale: boolean;
}

export interface HistoryPoint {
  t: number;
  price: number | null;
  lowest: number | null;
  median: number | null;
  bestBid: number | null;
  sellers: number;
  buyers: number;
  quantity: number;
}

export interface Variant {
  level: number;
  variant: string;
  npcValue: number;
  npcPrice: number | null;
  /** Points before this time are daily closes; after it, hourly. */
  hourlyFrom: number;
  points: HistoryPoint[];
}

export interface PriceBand {
  band: string;
  listings: number;
  sold: number;
  pulled: number;
  open: number;
  sellThrough: number | null;
  medianHoursToSell: number | null;
}

export interface Velocity {
  level: number;
  variant: string;
  /** Trade slots are hours for ranges up to two days, UTC days beyond. */
  bucket: "hour" | "day";
  trades: { t: number; sold: number; bought: number; trades: number }[];
  bands: PriceBand[];
  medianHoursToSell: number | null;
}

export interface Listing {
  merchant: string;
  side: "sell" | "buy";
  level: number;
  variant: string;
  price: number;
  quantity: number;
  region: string;
  server: string;
  map: string;
  x: number;
  y: number;
  listedAt: number;
  merchantSeenAt: number;
}

export interface Sale {
  item: string;
  side: "sell" | "buy";
  level: number;
  variant: string;
  price: number;
  quantity: number;
  merchant: string;
  region: string | null;
  /** "observed": a player's character saw the trade; "estimated": inferred from stand snapshots. */
  source: "observed" | "estimated";
  /** The other player in an observed trade. */
  counterparty: string | null;
  listedAt: number | null;
  at: number;
}

export interface Accuracy {
  days: number;
  reporters: number;
  merchantHoursObserved: number;
  observed: { trades: number; units: number; untracked: number; unverified: number };
  recall: number | null;
  precision: number | null;
  checkable: { sales: number; units: number };
  missedReasons: Record<string, number>;
  missed: {
    merchant: string; counterparty: string; side: "sell" | "buy"; item: string; name: string; level: number;
    variant: string; price: number; quantity: number; at: number; reason: string;
  }[];
  falsePositives: {
    merchant: string; side: "sell" | "buy"; item: string; name: string; level: number; variant: string;
    price: number; quantity: number; unconfirmed: number; listedAt: number; at: number;
  }[];
}

export interface ItemDetail {
  item: string;
  region: string;
  meta: ItemMeta | null;
  variants: Variant[];
  velocity: Velocity[];
  listings: Listing[];
  sales: Sale[];
  upgrades: UpgradeCosts | null;
  trackingSince: number | null;
}

export interface UpgradeStep {
  level: number;
  chance: number;
  scroll: string;
  scrollPrice: number | null;
  fromBase: number | null;
  baseCopies: number;
  market: number | null;
  cheapest: number | null;
  buyAt: number | null;
}

export interface UpgradeCosts {
  item: string;
  kind: "upgrade" | "compound";
  region: string;
  base: { market: number | null; shop: number | null; price: number | null };
  steps: UpgradeStep[];
}

export interface Movers {
  window: "24h" | "7d";
  gainers: MarketRow[];
  losers: MarketRow[];
  mostTraded: MarketRow[];
}

export type DealKind = "npc" | "underpriced" | "flip";

export interface DealWhere {
  merchant: string;
  region: string;
  server: string;
  map: string;
  x: number;
  y: number;
  merchantSeenAt: number;
}

export interface Deal {
  kind: DealKind;
  item: string;
  name: string;
  level: number;
  variant: string;
  flags: string;
  price: number;
  reference: number;
  profitPerUnit: number;
  discount: number;
  quantity: number;
  totalProfit: number;
  sellers: number | null;
  source: "merchant" | "npc";
  seller: DealWhere & { listedAt: number | null };
  buyer: (DealWhere & { price: number; quantity: number }) | null;
}

export interface Status {
  lastPoll: { fetched_at: number; error: string | null } | null;
  lastSuccessfulPoll: { fetched_at: number; merchants: number } | null;
  pollIntervalMinutes: number;
  freshHours: number;
  regions: string[];
  open_listings: number;
  merchants: number;
  tracking_since: number | null;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

export const api = {
  meta: () => get<GameMeta>("/meta"),
  status: () => get<Status>("/status"),
  overview: (region: string) => get<MarketRow[]>(`/overview?region=${region}`),
  movers: (region: string, window: string) => get<Movers>(`/movers?region=${region}&window=${window}`),
  deals: (region: string, params: Record<string, string>) =>
    get<Deal[]>(`/deals?${new URLSearchParams({ region, ...params })}`),
  accuracy: (days: number) => fetch(`/api/v1/accuracy?days=${days}`).then((r) => r.json() as Promise<Accuracy>),
  item: (item: string, days: number, region: string) =>
    get<ItemDetail>(`/items/${encodeURIComponent(item)}?days=${days}&region=${region}`),
};
