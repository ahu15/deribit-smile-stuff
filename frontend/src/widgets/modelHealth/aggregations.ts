// M3.95 — pure aggregation helpers for the ModelHealth tabs.
//
// Every function takes plain data already pulled from the dual-mode services
// (smileBucketsStream / smileStream / calendarStream) and reduces it. No
// network access, no React, no state — keeps the tabs themselves rendering
// derived state only and lets these be tested in isolation later.

import type { SmileFit, SmileSnapshot } from '../../worker/smileService';
import type { SmileBucketEntry } from '../../worker/bucketsService';
import type { MethodologySpec } from '../../worker/methodologyService';
import type { CalendarPayload } from '../../worker/calendarService';
import { parseExpiryMs } from '../../shared/expiry';

// ───────────────── shared helpers ─────────────────

/** Strip the `_cal` / `_wkg` suffix from a methodology id so paired
 *  (cal, wkg) variants collapse onto one key for the vol-time tab. */
export function basisStrip(id: string): string {
  if (id.endsWith('_cal')) return id.slice(0, -4);
  if (id.endsWith('_wkg')) return id.slice(0, -4);
  return id;
}

/** Group methodology specs by their non-time-basis axes. Returns one entry
 *  per (freeze, weights, family) tuple where both cal and wkg variants
 *  exist in the catalog — the only well-defined A/B comparison set. */
export interface MethodologyPair {
  /** Basis-stripped id (e.g. `sabr_alpha-from-ts_uniform`). */
  pairId: string;
  cal: MethodologySpec;
  wkg: MethodologySpec;
}
export function autoPairMethodologies(catalog: MethodologySpec[]): MethodologyPair[] {
  const byPair = new Map<string, { cal?: MethodologySpec; wkg?: MethodologySpec }>();
  for (const m of catalog) {
    const k = basisStrip(m.id);
    const slot = byPair.get(k) ?? {};
    if (m.time_basis === 'cal') slot.cal = m;
    else if (m.time_basis === 'wkg') slot.wkg = m;
    byPair.set(k, slot);
  }
  const out: MethodologyPair[] = [];
  for (const [pairId, slot] of byPair) {
    if (slot.cal && slot.wkg) out.push({ pairId, cal: slot.cal, wkg: slot.wkg });
  }
  out.sort((a, b) => a.pairId.localeCompare(b.pairId));
  return out;
}

// ───────────────── RMSE matrix ─────────────────

export interface RmseRowSummary {
  /** Quote-weighted (or equal-weighted) mean RMSE across the row's expiries. */
  mean: number | null;
  /** Number of fits that contributed (some cells may be null). */
  count: number;
}
/** Compute the row-total summary for the RMSE matrix. `weighting='equal'`
 *  averages residuals; `by_quotes` weights each expiry's residual by the
 *  number of market_iv samples its fit consumed (proxy for quote density). */
export function rowSummary(
  fits: (SmileFit | null)[],
  weighting: 'equal' | 'by_quotes',
): RmseRowSummary {
  let weightedSum = 0;
  let weightTotal = 0;
  let count = 0;
  for (const f of fits) {
    if (!f) continue;
    const r = f.residual_rms;
    if (!Number.isFinite(r)) continue;
    const w = weighting === 'by_quotes' ? Math.max(1, f.market_iv.length) : 1;
    weightedSum += r * w;
    weightTotal += w;
    count++;
  }
  if (weightTotal === 0) return { mean: null, count };
  return { mean: weightedSum / weightTotal, count };
}

/** Surface-wide cell — the matrix's top-left summary. Same weighting rule
 *  as the row summary, applied across every (methodology, expiry) cell. */
export function surfaceSummary(
  matrix: (SmileFit | null)[][],
  weighting: 'equal' | 'by_quotes',
): RmseRowSummary {
  return rowSummary(matrix.flat(), weighting);
}

// ───────────────── parameter stability ─────────────────

export interface ParamSeries {
  /** Buckets, oldest-first, with non-null fit values; nulls dropped. */
  points: { bucket_ts: number; value: number }[];
  /** Sample mean over `points`. */
  mean: number | null;
  /** Sample std-dev (ddof=0) over `points`. */
  std: number | null;
}
export function extractParamSeries(
  buckets: SmileBucketEntry[],
  paramName: string,
): ParamSeries {
  const points: { bucket_ts: number; value: number }[] = [];
  for (const b of buckets) {
    const v = b.fit?.params[paramName];
    if (v == null || !Number.isFinite(v)) continue;
    points.push({ bucket_ts: b.bucket_ts, value: v });
  }
  if (points.length === 0) return { points, mean: null, std: null };
  let sum = 0;
  for (const p of points) sum += p.value;
  const mean = sum / points.length;
  let sq = 0;
  for (const p of points) sq += (p.value - mean) ** 2;
  const std = Math.sqrt(sq / points.length);
  return { points, mean, std };
}

// ───────────────── vol-time diagnostics ─────────────────

/** ΔRMSE = wkg.residual − cal.residual at the same expiry × methodology pair.
 *  Negative means wkg fit better; positive means cal fit better. */
export interface PairResidualRow {
  expiry: string;
  cal_rmse: number | null;
  wkg_rmse: number | null;
  delta: number | null;
}
export function pairResiduals(
  expiries: string[],
  cal: Map<string, SmileSnapshot | undefined>,
  wkg: Map<string, SmileSnapshot | undefined>,
): PairResidualRow[] {
  return expiries.map(ex => {
    const c = cal.get(ex)?.fit?.residual_rms ?? null;
    const w = wkg.get(ex)?.fit?.residual_rms ?? null;
    const delta = c != null && w != null ? w - c : null;
    return { expiry: ex, cal_rmse: c, wkg_rmse: w, delta };
  });
}

/** Count the number of holidays whose date falls inside the (now → expiry)
 *  window. Saturday/Sunday don't count — they're a weekly recurring rail
 *  rather than a discrete event. The `holidays-in-life` heatmap buckets
 *  expiries by this count. */
export function holidaysInLife(
  expiry: string,
  nowMs: number,
  calendar: CalendarPayload | null,
): number {
  if (!calendar) return 0;
  const exMs = parseExpiryMs(expiry);
  if (exMs == null || exMs <= nowMs) return 0;
  let n = 0;
  for (const isoDate of Object.keys(calendar.holiday_weights)) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
    if (!m) continue;
    const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
    if (ms >= nowMs && ms <= exMs) n++;
  }
  return n;
}

export type HolidaysBucket = '0' | '1' | '2+';
export function bucketHolidays(n: number): HolidaysBucket {
  if (n === 0) return '0';
  if (n === 1) return '1';
  return '2+';
}

/** Mean RMSE per (methodology × holidays-in-life-bucket) for the
 *  holidays-in-life heatmap. Restricts to wkg-basis methodologies only —
 *  cal-basis cells don't depend on holidays so the bucketing is meaningless. */
export interface HolidaysCell {
  methodology: string;
  bucket: HolidaysBucket;
  mean_rmse: number | null;
  count: number;
}
export function holidaysHeatmap(
  catalog: MethodologySpec[],
  matrix: Map<string, Map<string, SmileSnapshot | undefined>>, // methodology → expiry → snap
  expiries: string[],
  nowMs: number,
  calendar: CalendarPayload | null,
): HolidaysCell[] {
  const cells: HolidaysCell[] = [];
  const buckets: HolidaysBucket[] = ['0', '1', '2+'];
  for (const m of catalog) {
    if (m.time_basis !== 'wkg') continue;
    const perExpiry = matrix.get(m.id);
    if (!perExpiry) continue;
    for (const b of buckets) {
      let sum = 0; let count = 0;
      for (const ex of expiries) {
        if (bucketHolidays(holidaysInLife(ex, nowMs, calendar)) !== b) continue;
        const r = perExpiry.get(ex)?.fit?.residual_rms;
        if (r == null || !Number.isFinite(r)) continue;
        sum += r; count++;
      }
      cells.push({
        methodology: m.id,
        bucket: b,
        mean_rmse: count > 0 ? sum / count : null,
        count,
      });
    }
  }
  return cells;
}
