// Sparkline — small SVG line chart for the parameter-stability tab.
// Draws a single series of (bucket_ts, value) points + the std-dev band
// shaded around the mean. Pure presentation; caller passes pre-extracted
// ParamSeries from aggregations.ts.

import type { ParamSeries } from '../aggregations';

interface SparklineProps {
  series: ParamSeries;
  width: number;
  height: number;
  color: string;
  /** Optional shared y-domain so multiple sparklines align across a column. */
  yDomain?: [number, number];
}

export function Sparkline({
  series, width, height, color, yDomain,
}: SparklineProps) {
  const { points, mean, std } = series;
  if (points.length === 0) {
    return (
      <svg width={width} height={height} style={{ overflow: 'visible' }}>
        <text x={width / 2} y={height / 2} textAnchor="middle"
              fill="var(--fg-mute)" fontSize={10} fontFamily="var(--font-data)">
          no data
        </text>
      </svg>
    );
  }

  const xs = points.map(p => p.bucket_ts);
  const ys = points.map(p => p.value);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const xSpan = Math.max(1, xMax - xMin);

  let yMin: number; let yMax: number;
  if (yDomain) {
    [yMin, yMax] = yDomain;
  } else {
    yMin = Math.min(...ys);
    yMax = Math.max(...ys);
  }
  const ySpan = Math.max(1e-9, yMax - yMin);

  const padX = 2;
  const padY = 2;
  const x = (t: number) => padX + ((t - xMin) / xSpan) * (width - 2 * padX);
  const y = (v: number) => height - padY - ((v - yMin) / ySpan) * (height - 2 * padY);

  const path = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.bucket_ts).toFixed(1)},${y(p.value).toFixed(1)}`)
    .join(' ');

  const meanY = mean != null ? y(mean) : null;
  const stdBandTop = mean != null && std != null ? y(mean + std) : null;
  const stdBandBot = mean != null && std != null ? y(mean - std) : null;

  return (
    <svg width={width} height={height} style={{ overflow: 'visible' }}>
      {meanY != null && stdBandTop != null && stdBandBot != null && (
        <rect
          x={padX}
          y={Math.min(stdBandTop, stdBandBot)}
          width={width - 2 * padX}
          height={Math.abs(stdBandBot - stdBandTop)}
          fill={color}
          opacity={0.10}
        />
      )}
      {meanY != null && (
        <line
          x1={padX} x2={width - padX}
          y1={meanY} y2={meanY}
          stroke={color} strokeWidth={0.8} strokeDasharray="2,2" opacity={0.5}
        />
      )}
      <path d={path} fill="none" stroke={color} strokeWidth={1.2} />
    </svg>
  );
}
