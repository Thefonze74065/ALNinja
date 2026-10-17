/** Daily price trend for the overview table. Gaps (days with no listings) break the line. */
export function Sparkline({ values, width = 96, height = 28 }: { values: (number | null)[]; width?: number; height?: number }) {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return <span className="spark-empty">not enough data</span>;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const pad = 3;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v: number) => (max === min ? height / 2 : pad + (1 - (v - min) / (max - min)) * (height - pad * 2));

  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v == null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  const last = values.length - 1;
  const lastVal = values[last];

  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <path d={d} fill="none" stroke="var(--series-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {lastVal != null && <circle cx={x(last)} cy={y(lastVal)} r="2.5" fill="var(--series-1)" />}
    </svg>
  );
}
