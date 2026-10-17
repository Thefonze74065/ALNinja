import type { ItemIconSpec } from "../api";

const GAME_ORIGIN = "https://adventure.land";

/** Renders one cell of the game's item sprite sheet, scaled up with crisp pixels. */
export function ItemIcon({ icon, size = 32 }: { icon: ItemIconSpec | null | undefined; size?: number }) {
  if (!icon) return <span className="icon icon-missing" style={{ width: size, height: size }} />;
  const scale = size / icon.size;
  return (
    <span
      className="icon"
      style={{
        width: size,
        height: size,
        backgroundImage: `url(${GAME_ORIGIN}${icon.file})`,
        backgroundSize: `${icon.columns * icon.size * scale}px ${icon.rows * icon.size * scale}px`,
        backgroundPosition: `-${icon.x * size}px -${icon.y * size}px`,
      }}
    />
  );
}
