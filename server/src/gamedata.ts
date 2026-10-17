import fs from "node:fs";
import path from "node:path";
import { config } from "./config.ts";

export interface ItemMeta {
  name: string;
  type: string;
  category: string;
  value: number; // base value (G.items[x].g): what NPCs charge, not what they pay
  upgradeable: boolean;
  compoundable: boolean;
  stackable: boolean;
  // Inputs to calculate_item_value; only set when the game data has them.
  cash?: boolean;
  markup?: number;
  grades?: number[];
  icon: { file: string; size: number; columns: number; rows: number; x: number; y: number } | null;
}

export interface GameMeta {
  version: number | null;
  items: Record<string, ItemMeta>;
  /** G.multipliers.buy_to_sell: share of value an NPC pays (0.6). */
  buyToSell?: number;
  /** Base values of scroll0-2 and cscroll0-2, used when valuing upgraded items. */
  scrolls?: Record<string, number>;
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
      ...(it.cash ? { cash: true } : {}),
      ...(it.markup ? { markup: it.markup } : {}),
      ...(it.grades ? { grades: it.grades } : {}),
      icon: set
        ? { file: set.file, size: set.size, columns: set.columns, rows: set.rows, x: pos[1], y: pos[2] }
        : null,
    };
  }
  const scrolls: Record<string, number> = {};
  for (const s of ["scroll0", "scroll1", "scroll2", "cscroll0", "cscroll1", "cscroll2"]) scrolls[s] = G.items?.[s]?.g ?? 0;
  return { version: G.version ?? null, items, buyToSell: G.multipliers?.buy_to_sell ?? 0.6, scrolls };
}

/**
 * Gold an NPC pays for one unit: a port of calculate_item_value() from the game's
 * js/common_functions.js, which the server's "sell" handler multiplies by quantity.
 */
export function npcSellValue(item: string, level: number, flags = ""): number {
  const def = meta.items[item] ?? meta.items.placeholder_m;
  if (!def) return 0;
  if (flags.split(",").includes("gift")) return 1;
  const scroll = (name: string) => meta.scrolls?.[name] ?? 0;
  let value = def.cash && def.value ? def.value : def.value * (meta.buyToSell ?? 0.6);
  if (def.markup) value /= def.markup;
  const grades = def.grades ?? [11, 12];
  if (def.compoundable && level) {
    let grade = 0;
    for (let i = 1; i <= level; i++) {
      if (i > grades[1]) grade = 2;
      else if (i > grades[0]) grade = 1;
      value *= def.cash ? 1.5 : 3.2;
      if (def.type !== "booster") value += scroll(`cscroll${grade}`) / 2.4;
      else value *= 0.75;
    }
  }
  if (def.upgradeable && level) {
    let grade = 0;
    let scrolls = 0;
    for (let i = 1; i <= level; i++) {
      if (i > grades[1]) grade = 2;
      else if (i > grades[0]) grade = 1;
      scrolls += scroll(`scroll${grade}`) / 2;
      if (i >= 7) (value *= 3), (scrolls *= 1.32);
      else if (i === 6) value *= 2.4;
      else if (i >= 4) value *= 2;
      if (i === 9) (value *= 2.64), (value += 400000);
      if (i === 10) value *= 5;
      if (i === 12) value *= 0.8;
    }
    value += scrolls;
  }
  if (flags.split(",").includes("expires")) value /= 8;
  return Math.round(value) || 0;
}

/** Loads a raw G object directly (tests, tools). */
export function setGameData(G: any): void {
  meta = build(G);
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
