// Small, dependency-free sparkline: a plain inline SVG polyline/area, not a
// full charting library. A dashboard rendering one of these per agent card
// doesn't need interactive tooltips, legends, or axes — this stays cheap to
// mount five times on one page.
//
// Callers are responsible for the all-zero / empty-data case: this component
// always draws a line (a flat line at 0 for all-zero data reads as "no
// activity" without any semantic weight), so render a "No sessions recorded
// yet." fallback instead of this component when `data` has no signal.
export function UsageSparkline({ data, width = 160, height = 40 }: { data: number[]; width?: number; height?: number }) {
  if (data.length === 0) return null;

  const max = Math.max(...data, 1);
  const stepX = data.length > 1 ? width / (data.length - 1) : 0;
  const points = data.map((v, i) => {
    const x = i * stepX;
    const y = height - (v / max) * (height - 2) - 1;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  const areaPoints = [`0,${height}`, ...points, `${width},${height}`].join(' ');
  const linePoints = points.join(' ');

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      preserveAspectRatio="none"
      className="text-primary"
      role="img"
      aria-label="Session activity over the last 30 days"
    >
      <polyline points={areaPoints} fill="currentColor" opacity={0.12} stroke="none" />
      <polyline points={linePoints} fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
