// Shared overlay helpers used by SmileChart and TermStructureChart.
//
// `formatRelativeTime` keeps frozen-overlay timestamps readable as "Nh Mm
// ago" instead of an absolute clock. `CLAMP_WARN_MS` is the threshold above
// which a snapped historic timestamp is flagged as "(clamped)" — the
// 24h buffer's edge gets noisy under sub-poll snap noise so we only warn
// past 5 minutes off. `COMPARE_PALETTE` / `COMPARE_CAP` drive the
// cross-{methodology|method} comparison overlays in both widgets.

export const COMPARE_PALETTE = ['#5fb8ff', '#ff7d6c', '#85d68a', '#cd92ff'];
export const COMPARE_CAP = 4;

export const CLAMP_WARN_MS = 5 * 60 * 1000;

export function formatRelativeTime(ts_ms: number, now_ms: number): string {
  const dMs = now_ms - ts_ms;
  const sign = dMs >= 0 ? '' : '+';
  const a = Math.abs(dMs);
  const totalMin = Math.round(a / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${sign}${m}m ago`;
  if (m === 0) return `${sign}${h}h ago`;
  return `${sign}${h}h ${m}m ago`;
}
