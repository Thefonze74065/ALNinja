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
  gift?: number; // gifted items sell to NPCs for 1 gold
  expires?: string; // temporary items sell to NPCs for 1/8
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

/** Reads a response body as text, failing once it exceeds `maxBytes` instead of buffering without limit. */
export async function readText(res: Response, maxBytes: number): Promise<string> {
  if (Number(res.headers.get("content-length")) > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new Error(`response larger than ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchMerchants(): Promise<{ merchants: Merchant[]; raw: string }> {
  const res = await fetch(`${config.aldataUrl}/merchants`, {
    headers: { "user-agent": "ALNinja price tracker" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`ALData /merchants responded ${res.status}`);
  // ~170 KB today; the cap only guards against a broken or hostile upstream.
  const raw = await readText(res, 64 * 1024 * 1024);
  const merchants = JSON.parse(raw);
  if (!Array.isArray(merchants)) throw new Error("ALData /merchants did not return an array");
  return { merchants, raw };
}
