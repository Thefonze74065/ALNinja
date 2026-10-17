import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

export interface ItemMeta {
  name: string;
  type: string;
  category: string;
  value: number; // NPC base value (G.items[x].g)
  upgradeable: boolean;
  compoundable: boolean;
  stackable: boolean;
  icon: { file: string; size: number; columns: number; rows: number; x: number; y: number } | null;
}

export interface GameMeta {
  version: number | null;
  items: Record<string, ItemMeta>;
}

const CATEGORY_BY_TYPE: Record<string, string> = {
  weapon: "Weapons",
  helmet: "Armor", chest: "Armor", pants: "Armor", gloves: "Armor", shoes: "Armor",
  cape: "Armor", shield: "Armor", source: "Armor", quiver: "Armor", misc_offhand: "Armor",
  ring: "Accessories", earring: "Accessories", amulet: "Accessories", belt: "Accessories", orb: "Accessories",
  pot: "Consumables", elixir: "Consumables", throw: "Consumables",
  uscroll: "Scrolls", cscroll: "Scrolls", pscroll: "Scrolls", offering: "Scrolls",
  material: "Materials", gem: "Materials", quest: "Materials", box: "Materials", token: "Materials",
  cosmetics: "Cosmetics", jar: "Cosmetics",
};

const cacheFile = path.join(config.dataDir, "gamedata.json");
let meta: GameMeta = { version: null, items: {} };

export function getGameMeta(): GameMeta {
  return meta;
}

function build(G: any): GameMeta {
  const items: Record<string, ItemMeta> = {};
  for (const [id, it] of Object.entries<any>(G.items ?? {})) {
    const pos = G.positions?.[it.skin ?? id];
    const set = pos ? G.imagesets?.[pos[0] || "pack_20"] : undefined;
    items[id] = {
      name: it.name ?? id,
      type: it.type ?? "misc",
      category: CATEGORY_BY_TYPE[it.type] ?? "Other",
      value: it.g ?? 0,
      upgradeable: Boolean(it.upgrade),
      compoundable: Boolean(it.compound),
      stackable: Boolean(it.s),
      icon: set
        ? { file: set.file, size: set.size, columns: set.columns, rows: set.rows, x: pos[1], y: pos[2] }
        : null,
    };
  }
  return { version: G.version ?? null, items };
}

export async function refreshGameData(): Promise<void> {
  try {
    const res = await fetch(config.gameDataUrl, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`responded ${res.status}`);
    const text = await res.text();
    // data.js is `var G={...};` — strip the assignment to get the JSON.
    const G = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    meta = build(G);
    fs.writeFileSync(cacheFile, JSON.stringify(meta));
    console.log(`[gamedata] loaded version ${meta.version}, ${Object.keys(meta.items).length} items`);
  } catch (err) {
    console.error(`[gamedata] refresh failed: ${(err as Error).message}`);
    if (!meta.version && fs.existsSync(cacheFile)) {
      meta = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      console.log(`[gamedata] using cached version ${meta.version}`);
    }
  }
}
