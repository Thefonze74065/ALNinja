import { config } from "./config.ts";

export interface MerchantSlot {
  name: string;
  level?: number;
  price?: number;
  q?: number;
  b?: boolean; // buy order
  p?: string | null; // title modifier: shiny, lucky, cavefound, ...
  data?: string; // contents of jars, e.g. the appearance stored in a cxjar
  giveaway?: number;
  want?: unknown; // barter request instead of gold
  [key: string]: unknown;
}

export interface Merchant {
  id: string;
  lastSeen: string;
  map: string;
  serverRegion: string;
  serverIdentifier: string;
  slots: Record<string, MerchantSlot | null>;
  x: number;
  y: number;
}

export async function fetchMerchants(): Promise<{ merchants: Merchant[]; raw: string }> {
  const res = await fetch(`${config.aldataUrl}/merchants`, {
    headers: { "user-agent": "ALNinja price tracker" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`ALData /merchants responded ${res.status}`);
  const raw = await res.text();
  const merchants = JSON.parse(raw);
  if (!Array.isArray(merchants)) throw new Error("ALData /merchants did not return an array");
  return { merchants, raw };
}
