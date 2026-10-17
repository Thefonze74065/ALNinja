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
  daily: { day: number; sold: number; bought: number; trades: number }[];
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
  listedAt: number;
  at: number;
}

export interface ItemDetail {
  item: string;
  region: string;
  meta: ItemMeta | null;
  variants: Variant[];
  velocity: Velocity[];
  listings: Listing[];
  sales: Sale[];
}

export interface Movers {
  window: "24h" | "7d";
  gainers: MarketRow[];
  losers: MarketRow[];
  mostTraded: MarketRow[];
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
  item: (item: string, days: number, region: string) =>
    get<ItemDetail>(`/items/${encodeURIComponent(item)}?days=${days}&region=${region}`),
};
