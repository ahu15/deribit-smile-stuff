// Frontend mirror of `backend/vol_time.py` math (M3.6).
//
// The backend is canonical; this module exists so the VolCalendar widget
// can compute live diagnostics ("dte vs dte_wkg per expiry", "total vol
// days / yr") in response to keystrokes without an HTTP round-trip per
// edit. The two implementations agree by construction — the algorithms
// are simple enough to mirror.
//
// Wire format on `Calendar` matches `CalendarPayload`'s ISO-date strings;
// we keep dates as strings throughout (no Date objects on hot paths) to
// avoid timezone surprises with `Date.parse` and to round-trip with the
// backend without conversion.

import type { CalendarPayload } from '../worker/calendarService';

const MS_PER_DAY = 86_400 * 1000;
const MS_PER_YEAR = 365.0 * MS_PER_DAY;

export function calYte(expiryMs: number, asOfMs: number): number {
  if (expiryMs <= asOfMs) return 0;
  return (expiryMs - asOfMs) / MS_PER_YEAR;
}

function isoDateUtc(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function midnightUtcMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(n => parseInt(n, 10));
  return Date.UTC(y, m - 1, d);
}

function dayWeight(iso: string, cal: CalendarPayload): number {
  const override = cal.holiday_weights[iso];
  if (override !== undefined) return override;
  // JS Sunday=0 .. Saturday=6 — check directly against those constants.
  const jsWd = new Date(midnightUtcMs(iso)).getUTCDay();
  if (jsWd === 6) return cal.sat_weight;
  if (jsWd === 0) return cal.sun_weight;
  return 1.0;
}

/** Weighted year-to-expiry under `cal`. Mirrors `backend.vol_time.vol_yte`. */
export function volYte(expiryMs: number, asOfMs: number, cal: CalendarPayload): number {
  if (expiryMs <= asOfMs) return 0;

  const startIso = isoDateUtc(asOfMs);
  const endIso = isoDateUtc(expiryMs);
  const startMid = midnightUtcMs(startIso);

  if (startIso === endIso) {
    const frac = (expiryMs - asOfMs) / MS_PER_DAY;
    return (dayWeight(startIso, cal) * frac) / 365.0;
  }

  const endMid = midnightUtcMs(endIso);

  let weightedDays = 0;

  // Partial first day
  weightedDays += dayWeight(startIso, cal) * (1 - (asOfMs - startMid) / MS_PER_DAY);

  // Partial last day
  weightedDays += dayWeight(endIso, cal) * ((expiryMs - endMid) / MS_PER_DAY);

  // Middle full days — iterate by ISO date (avoids Date arithmetic gotchas
  // around DST, though we're in UTC throughout so it'd be safe either way).
  let cursor = startMid + MS_PER_DAY;
  while (cursor < endMid) {
    weightedDays += dayWeight(isoDateUtc(cursor), cal);
    cursor += MS_PER_DAY;
  }

  return weightedDays / 365.0;
}

/** Sum of day weights over `year` (UTC). Default = current UTC year. */
export function totalVolDaysPerYear(cal: CalendarPayload, year?: number): number {
  const y = year ?? new Date().getUTCFullYear();
  let total = 0;
  let cursor = Date.UTC(y, 0, 1);
  const end = Date.UTC(y + 1, 0, 1);
  while (cursor < end) {
    total += dayWeight(isoDateUtc(cursor), cal);
    cursor += MS_PER_DAY;
  }
  return total;
}
