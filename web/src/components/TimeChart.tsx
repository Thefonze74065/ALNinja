import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface Series {
  label: string;
  color: string; // CSS variable name, e.g. "--series-1"
  values: (number | null)[];
  dash?: boolean;
  bars?: boolean;
}

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Time-series chart with a crosshair; uPlot's legend doubles as the hover readout. */
export function TimeChart({
  times,
  series,
  height = 280,
  format,
}: {
  times: number[]; // ms
  series: Series[];
  height?: number;
  format: (v: number | null) => string;
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
        scales: { x: { time: true }, y: { range: (_u, min, max) => [Math.min(0, min), max * 1.08 || 1] } },
        axes: [axis, { ...axis, size: 56, values: (_u, ticks) => ticks.map(format) }],
        legend: { live: true },
        series: [
          { value: "{YYYY}-{MM}-{DD} {HH}:00" },
          ...series.map((s) => ({
            label: s.label,
            stroke: cssVar(s.color),
            width: 2,
            dash: s.dash ? [6, 4] : undefined,
            fill: s.bars ? cssVar(s.color) : undefined,
            paths: s.bars ? uPlot.paths.bars!({ size: [0.8, 12], radius: 0.15 }) : undefined,
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
  }, [times, series, height, format]);

  return <div className="chart" ref={el} />;
}
