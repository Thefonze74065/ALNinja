import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface Series {
  label: string;
  color: string; // CSS variable name, e.g. "--series-1"
  values: (number | null)[];
  dash?: boolean;
  bars?: boolean;
  /** Offset bars left (-1) or right (1) of the tick so two bar series sit side by side. */
  barAlign?: -1 | 1;
}

const DAY_S = 86_400;
// Daily buckets are UTC days; label them in UTC so a bar never lands on the neighbouring date.
const utcDate = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Time-series chart with a crosshair; uPlot's legend doubles as the hover readout. */
export function TimeChart({
  times,
  series,
  height = 280,
  format,
  daily = false,
}: {
  times: number[]; // ms
  series: Series[];
  height?: number;
  format: (v: number | null) => string;
  daily?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = el.current;
    if (!root) return;

    const build = () => {
      const axis = {
        stroke: cssVar("--text-muted"),
        grid: { stroke: cssVar("--grid"), width: 1 },
        ticks: { show: false },
        font: "12px system-ui, sans-serif",
      };
      const opts: uPlot.Options = {
        width: root.clientWidth,
        height,
        cursor: { points: { size: 8 } },
        ...(daily ? { tzDate: (ts: number) => uPlot.tzDate(new Date(ts * 1000), "Etc/UTC") } : {}),
        scales: {
          // Daily bars get half a day of room on each side so the first and last aren't clipped.
          x: daily ? { time: true, range: (_u, min, max) => [min - DAY_S / 2, max + DAY_S / 2] } : { time: true },
          y: { range: (_u, min, max) => [Math.min(0, min), max * 1.08 || 1] },
        },
        axes: [
          daily
            ? { ...axis, incrs: [DAY_S, 2 * DAY_S, 7 * DAY_S, 14 * DAY_S, 30 * DAY_S], values: (_u, ticks) => ticks.map(utcDate) }
            : axis,
          { ...axis, size: 56, values: (_u, ticks) => ticks.map(format) },
        ],
        legend: { live: true },
        series: [
          daily ? { value: (_u: uPlot, v: number) => (v == null ? "—" : utcDate(v)) } : { value: "{YYYY}-{MM}-{DD} {HH}:00" },
          ...series.map((s) => ({
            label: s.label,
            stroke: cssVar(s.color),
            width: 2,
            dash: s.dash ? [6, 4] : undefined,
            fill: s.bars ? cssVar(s.color) : undefined,
            paths: s.bars
              ? uPlot.paths.bars!({ size: [s.barAlign ? 0.4 : 0.8, 24], align: s.barAlign ?? 0, radius: 0.15 })
              : undefined,
            points: { show: false },
            spanGaps: false,
            value: (_u: uPlot, v: number | null) => format(v),
          })),
        ],
      };
      const data: uPlot.AlignedData = [times.map((t) => t / 1000), ...series.map((s) => s.values)];
      return new uPlot(opts, data, root);
    };

    let plot = build();
    const resize = new ResizeObserver(() => plot.setSize({ width: root.clientWidth, height }));
    resize.observe(root);
    // Rebuild on theme change so axis and series colors follow the new tokens.
    const scheme = window.matchMedia("(prefers-color-scheme: dark)");
    const rebuild = () => {
      plot.destroy();
      plot = build();
    };
    scheme.addEventListener("change", rebuild);
    return () => {
      resize.disconnect();
      scheme.removeEventListener("change", rebuild);
      plot.destroy();
    };
  }, [times, series, height, format, daily]);

  return <div className="chart" ref={el} />;
}
