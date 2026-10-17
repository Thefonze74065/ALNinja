const UNITS: [number, string][] = [
  [1e12, "t"],
  [1e9, "b"],
  [1e6, "m"],
  [1e3, "k"],
];

/** Gold amounts the way players write them: 950, 12.5k, 3.2m, 1.05b. */
export function gold(n: number | null | undefined): string {
  if (n == null) return "—";
  for (const [size, unit] of UNITS) {
    if (Math.abs(n) >= size) {
      const v = n / size;
      return String(Number(v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2))) + unit;
    }
  }
  return String(Math.round(n));
}

export function percent(n: number | null): string {
  if (n == null) return "—";
  const v = n * 100;
  return `${v > 0 ? "+" : ""}${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)}%`;
}

export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400 * 2) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function variantLabel(level: number, variant: string, upgradeable: boolean): string {
  const parts: string[] = [];
  if (upgradeable || level > 0) parts.push(`+${level}`);
  if (variant) parts.push(variant);
  return parts.join(" ");
}
