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

export interface OverviewRow {
  item: string;
  name: string;
  category: string;
  level: number;
  variant: string;
  price: number | null;
  sellMin: number | null;
  buyMax: number | null;
  sellCount: number;
  buyCount: number;
  quantity: number;
  npcValue: number | null;
  change7d: number | null;
  sparkline: (number | null)[];
  updated: number;
  stale: boolean;
}

export interface HistoryPoint {
  t: number;
  min: number | null;
  p25: number | null;
  median: number | null;
  buy: number | null;
  sellCount: number;
  buyCount: number;
  quantity: number;
}

export interface Variant {
  level: number;
  variant: string;
  history: HistoryPoint[];
}

export interface OpenListing {
  merchant: string;
  side: "sell" | "buy";
  level: number;
  variant: string;
  price: number;
  quantity: number;
  first_seen: number;
  last_seen: number;
  server_region: string;
  server_identifier: string;
  map: string;
  x: number;
  y: number;
}

export interface ClosedListing {
  merchant: string;
  side: "sell" | "buy";
  level: number;
  variant: string;
  price: number;
  initial_quantity: number;
  quantity: number;
  first_seen: number;
  closed_at: number;
  close_reason: "gone" | "repriced";
  server_region: string;
  server_identifier: string;
}

export interface ItemDetail {
  item: string;
  region: string;
  meta: ItemMeta | null;
  variants: Variant[];
  listings: OpenListing[];
  recentlyClosed: ClosedListing[];
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
  overview: (region: string) => get<OverviewRow[]>(`/overview?region=${region}`),
  item: (item: string, days: number, region: string) =>
    get<ItemDetail>(`/items/${encodeURIComponent(item)}?days=${days}&region=${region}`),
};
