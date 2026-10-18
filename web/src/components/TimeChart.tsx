import { useEffect, useMemo, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

export interface Series {
  label: string;
  color: string; // CSS variable name, e.g. "--series-1"
  values: (number | null)[];
  dash?: boolean;
  /** Bars (amounts per period) or steps (a level that holds until the next reading); default line. */
  style?: "line" | "bars" | "steps";
  /** Offset bars left (-1) or right (1) of the tick so two bar series sit side by side. */
  barAlign?: -1 | 1;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const H = 3600; // seconds, uPlot's time unit
const D = 24 * H;

// Tick spacing never finer than the data: whole hours for hourly data, whole days for daily.
const HOUR_INCRS = [H, 2 * H, 3 * H, 6 * H, 12 * H, D, 2 * D, 7 * D, 14 * D, 30 * D, 91 * D, 182 * D, 365 * D];
const DAY_INCRS = [D, 2 * D, 7 * D, 14 * D, 30 * D, 91 * D, 182 * D, 365 * D];
// Counts tick on whole numbers.
const COUNT_INCRS = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 5e4, 1e5, 1e6, 1e7];

// Times are labelled on the viewer's clock; daily buckets start at their local midnight.
const dateLabel = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const hourLabel = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" });

/** Indices of points with no neighbour on either side; a line can't show them, so they get a dot. */
const isolated: uPlot.Series.Points.Filter = (u, seriesIdx) => {
  const v = u.data[seriesIdx];
  const out: number[] = [];
  for (let i = 0; i < v.length; i++) {
    if (v[i] != null && (i === 0 || v[i - 1] == null) && (i === v.length - 1 || v[i + 1] == null)) out.push(i);
  }
  return out;
};

function cssVar(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Inserts a null after any point followed by a longer-than-expected gap, so lines break where data is
 * missing instead of drawing straight across it. `stepAt(t)` is the expected spacing at time t.
 */
function breakGaps(times: number[], series: Series[], stepAt: (t: number) => number) {
  const t2: number[] = [];
  const v2 = series.map(() => [] as (number | null)[]);
  times.forEach((t, i) => {
    if (i > 0 && t - times[i - 1] > 1.5 * stepAt(times[i - 1])) {
      t2.push(times[i - 1] + stepAt(times[i - 1]));
      v2.forEach((v) => v.push(null));
    }
    t2.push(t);
    series.forEach((s, j) => v2[j].push(s.values[i]));
  });
  return { times: t2, values: v2 };
}

/**
 * Time-series chart with a crosshair. The legend shows the latest values, or the hovered point's.
 * `resolution` is the data's spacing: hourly data can include older daily points (before `hourlyFrom`).
 * `counts` charts start at zero and tick on whole numbers; price charts fit the data.
 */
export function TimeChart({
  times,
  series,
  height = 280,
  format,
  resolution,
  hourlyFrom,
  counts = false,
}: {
  times: number[]; // ms
  series: Series[];
  height?: number;
  format: (v: number | null) => string;
  resolution: "hour" | "day";
  hourlyFrom?: number;
  counts?: boolean;
}) {
  const el = useRef<HTMLDivElement>(null);
  const daily = resolution === "day";
  const data = useMemo(() => {
    const stepAt = (t: number) => (daily || (hourlyFrom != null && t < hourlyFrom) ? DAY : HOUR);
    const { times: t, values } = breakGaps(times, series, stepAt);
    return [t.map((x) => x / 1000), ...values] as uPlot.AlignedData;
  }, [times, series, daily, hourlyFrom]);

  useEffect(() => {
    const root = el.current;
    if (!root) return;
    const last = data[0].length - 1;

    const build = () => {
      const axis = {
        stroke: cssVar("--text-muted"),
        grid: { stroke: cssVar("--grid"), width: 1 },
        ticks: { show: false },
        font: "12px system-ui, sans-serif",
      };
      const step = daily ? D : H;
      const opts: uPlot.Options = {
        width: root.clientWidth,
        height,
        cursor: { points: { size: 8 } },
        scales: {
          // The data's own span plus half a period each side, so end bars aren't clipped. (uPlot's
          // auto-range goes wild for a single point.)
          x: { time: true, range: () => [data[0][0] - step / 2, data[0][last] + step / 2] },
          y: {
            range: (_u, min, max) => {
              if (counts) return [0, Math.max(max * 1.1, 1)];
              // Prices: fit the data with some room, never below zero.
              const pad = (max - min) * 0.15 || Math.abs(max) * 0.1 || 1;
              return [Math.max(0, min - pad), max + pad];
            },
          },
        },
        axes: [
          daily ? { ...axis, incrs: DAY_INCRS, values: (_u, ticks) => ticks.map(dateLabel) } : { ...axis, incrs: HOUR_INCRS },
          { ...axis, size: 56, ...(counts ? { incrs: COUNT_INCRS } : {}), values: (_u, ticks) => ticks.map(format) },
        ],
        legend: { live: true },
        series: [
          {
            label: daily ? "Day" : "Time",
            value: (_u: uPlot, v: number | null) => (v == null ? "—" : daily ? dateLabel(v) : hourLabel(v)),
          },
          ...series.map((s) => ({
            label: s.label,
            stroke: cssVar(s.color),
            width: s.style === "bars" ? 0 : 2,
            dash: s.dash ? [6, 4] : undefined,
            fill: s.style === "bars" ? cssVar(s.color) : undefined,
            paths:
              s.style === "bars"
                ? uPlot.paths.bars!({ size: [s.barAlign ? 0.4 : 0.8, 40], align: s.barAlign ?? 0, radius: 0.15 })
                : s.style === "steps"
                  ? uPlot.paths.stepped!({ align: 1 })
                  : undefined,
            points: s.style === "bars" ? { show: false } : { show: true, size: 7, fill: cssVar(s.color), filter: isolated },
            spanGaps: false,
            value: (_u: uPlot, v: number | null) => format(v),
          })),
        ],
        hooks: {
          // With no point hovered, the legend shows the latest values instead of dashes.
          ready: [(u) => u.setLegend({ idx: last })],
          setCursor: [(u) => {
            if (u.cursor.idx == null) u.setLegend({ idx: last });
          }],
        },
      };
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
  }, [data, height, format, daily, counts]);

  return <div className="chart" ref={el} />;
}
