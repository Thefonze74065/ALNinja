import type { GameMeta } from "../api";
import { variantLabel } from "../format";
import { ItemIcon } from "./ItemIcon";

export function itemHref(item: string, level: number, variant: string) {
  const q = new URLSearchParams({ level: String(level) });
  if (variant) q.set("variant", variant);
  return `#/item/${encodeURIComponent(item)}?${q}`;
}

/** Icon + name + level/variant badge, linking to the item page. */
export function ItemCell({
  meta,
  row,
}: {
  meta: GameMeta | null;
  row: { item: string; name: string; level: number; variant: string; stale?: boolean };
}) {
  const m = meta?.items[row.item];
  const label = variantLabel(row.level, row.variant, Boolean(m?.upgradeable || m?.compoundable));
  return (
    <a className="item-cell" href={itemHref(row.item, row.level, row.variant)}>
      <ItemIcon icon={m?.icon} />
      <span>
        <span className="item-name">{row.name}</span>
        {label && <span className="badge">{label}</span>}
        {row.stale && <span className="badge badge-muted" title="No fresh listings in the last hour">stale</span>}
      </span>
    </a>
  );
}
