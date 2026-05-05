// Heatmap — reusable cell grid for the RMSE matrix and holidays-in-life
// view. Pure presentation: caller passes a 2D array of numbers (or nulls)
// + axis labels + a value→color mapper, this lays out a div grid with
// hover tooltips. No subscriptions, no aggregation.

interface HeatmapCell {
  value: number | null;
  /** Optional formatted label rendered inside the cell. Falls back to `value`. */
  label?: string;
  /** Optional hover-title detail. */
  title?: string;
}

interface HeatmapProps {
  rowLabels: string[];
  colLabels: string[];
  cells: HeatmapCell[][];                       // [row][col]
  /** Format a numeric value for display when a cell.label isn't set. */
  formatValue: (v: number) => string;
  /** Color a value into a CSS background. Receives null for missing cells.
   *  `rowIndex` is the body-row index (0 = first methodology) so callers can
   *  apply per-row scales; pass -1 for the surface-summary corner cell. */
  colorFor: (v: number | null, rowIndex: number) => string;
  /** Optional label for the top-left summary cell (above row labels, left of col labels). */
  cornerLabel?: string;
  /** Optional row-summary column rendered to the right. */
  rowSummary?: { value: number | null; label?: string }[];
  /** Optional surface summary rendered in the corner cell. */
  surfaceSummary?: { value: number | null; label?: string };
  cellWidth?: number;
  cellHeight?: number;
  rowLabelWidth?: number;
}

export function Heatmap({
  rowLabels, colLabels, cells, formatValue, colorFor,
  cornerLabel, rowSummary, surfaceSummary,
  cellWidth = 56, cellHeight = 22, rowLabelWidth = 220,
}: HeatmapProps) {
  const summaryWidth = rowSummary ? cellWidth + 6 : 0;
  return (
    <div style={{
      display: 'inline-grid',
      gridTemplateColumns:
        `${rowLabelWidth}px repeat(${colLabels.length}, ${cellWidth}px)`
        + (rowSummary ? ` ${summaryWidth}px` : ''),
      gridAutoRows: `${cellHeight}px`,
      fontFamily: 'var(--font-data)',
      fontVariantNumeric: 'tabular-nums',
      fontSize: 11,
      gap: 1,
      background: 'var(--border)',
      padding: 1,
    }}>
      {/* Header row: corner + col labels + (optional) row-summary header */}
      <div style={cornerStyle} title={cornerLabel}>
        {surfaceSummary
          ? (surfaceSummary.label
            ?? (surfaceSummary.value != null ? formatValue(surfaceSummary.value) : '—'))
          : (cornerLabel ?? '')}
      </div>
      {colLabels.map(l => (
        <div key={l} style={headerCellStyle} title={l}>{l}</div>
      ))}
      {rowSummary && (
        <div style={{ ...headerCellStyle, fontStyle: 'italic' }} title="row mean">avg</div>
      )}
      {/* Body rows */}
      {rowLabels.map((rl, r) => (
        <RowFragment
          key={rl}
          rowLabel={rl}
          rowIndex={r}
          row={cells[r] ?? []}
          summary={rowSummary?.[r]}
          formatValue={formatValue}
          colorFor={colorFor}
        />
      ))}
    </div>
  );
}

function RowFragment({
  rowLabel, rowIndex, row, summary, formatValue, colorFor,
}: {
  rowLabel: string;
  rowIndex: number;
  row: HeatmapCell[];
  summary?: { value: number | null; label?: string };
  formatValue: (v: number) => string;
  colorFor: (v: number | null, rowIndex: number) => string;
}) {
  return (
    <>
      <div style={rowLabelStyle} title={rowLabel}>{rowLabel}</div>
      {row.map((c, i) => (
        <div
          key={i}
          style={{ ...cellStyle, background: colorFor(c.value, rowIndex) }}
          title={c.title ?? (c.value != null ? formatValue(c.value) : 'no data')}
        >
          {c.label ?? (c.value != null ? formatValue(c.value) : '·')}
        </div>
      ))}
      {summary && (
        <div
          style={{ ...cellStyle, background: colorFor(summary.value, rowIndex), fontWeight: 600 }}
          title={summary.value != null ? formatValue(summary.value) : 'no data'}
        >
          {summary.label ?? (summary.value != null ? formatValue(summary.value) : '—')}
        </div>
      )}
    </>
  );
}

const cornerStyle: React.CSSProperties = {
  background: 'var(--bg-1)', color: 'var(--fg)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 10, fontWeight: 600,
  overflow: 'hidden', whiteSpace: 'nowrap',
};
const headerCellStyle: React.CSSProperties = {
  background: 'var(--bg-1)', color: 'var(--fg-mute)',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  fontSize: 10, letterSpacing: '0.05em',
  overflow: 'hidden', whiteSpace: 'nowrap',
};
const rowLabelStyle: React.CSSProperties = {
  background: 'var(--bg-1)', color: 'var(--fg)',
  display: 'flex', alignItems: 'center', justifyContent: 'flex-start',
  paddingLeft: 6,
  fontSize: 10,
  overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis',
};
const cellStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: 'var(--fg)',
  fontSize: 10,
  overflow: 'hidden', whiteSpace: 'nowrap',
};

/** Build a value→color mapper from a [min, max] domain into the diverging
 *  RMSE palette (low=cool, high=warm). Returns transparent for nulls. */
export function makeRmseColor(min: number, max: number) {
  const span = Math.max(1e-9, max - min);
  return (v: number | null): string => {
    if (v == null || !Number.isFinite(v)) return 'var(--bg)';
    const t = Math.max(0, Math.min(1, (v - min) / span));
    // OKLCH ramp from cool (low residual = good) to warm (high residual = bad).
    const h = 220 - 220 * t;       // 220 → 0
    const c = 0.10 + 0.04 * t;
    const l = 0.45 - 0.05 * t;
    return `oklch(${l} ${c} ${h})`;
  };
}

/** Diverging color mapper centered at 0 — used by the cal-vs-wkg ΔRMSE bar
 *  view. Negative (wkg better) = cool, positive (cal better) = warm. */
export function makeDeltaColor(absMax: number) {
  const m = Math.max(1e-9, absMax);
  return (v: number | null): string => {
    if (v == null || !Number.isFinite(v)) return 'var(--bg)';
    const t = Math.max(-1, Math.min(1, v / m));
    if (t < 0) {
      const a = Math.abs(t);
      return `oklch(${0.50 - 0.05 * a} ${0.05 + 0.10 * a} 220)`;
    }
    return `oklch(${0.50 - 0.05 * t} ${0.05 + 0.10 * t} 30)`;
  };
}
