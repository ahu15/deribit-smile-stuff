"""Vol-time / working-day calendar (M3.6 foundation).

Two clocks:
  * `cal_yte(expiry_ms, as_of_ms)` — calendar-time year-to-expiry. Pure
    `delta_ms / (365 * 86400 * 1000)`, calendar-independent.
  * `vol_yte(expiry_ms, as_of_ms, calendar)` — weighted year-to-expiry. Each
    UTC calendar day d carries a weight w(d); the integral of w over the
    interval is divided by 365. With sat=sun=1 and no holidays this reduces
    to `cal_yte` exactly; the active default (sat=0.4, sun=0.6) does not.

Calendar is a plain dataclass — `holiday_weights: dict[date, float]` (each
holiday carries its own weight rather than a single global sentinel), plus
`holiday_names` for UI labels and weekday weights. Calendar revision is a
SHA-1 hash of `(holiday_weights, sat_weight, sun_weight)` only — name edits
do not bump the revision (so renaming a holiday while the user is mid-typing
doesn't invalidate every cached fit).
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone

_MS_PER_DAY = 86_400 * 1000
_MS_PER_YEAR = 365.0 * _MS_PER_DAY


@dataclass
class Calendar:
    """Vol-time calendar. Single shared instance across BTC + ETH for now;
    per-venue calendars wait for M6 (Bloomberg / TradFi closures).

    `holiday_weights[d]` overrides the weekday default for a specific date.
    Weight 0.0 = full closure (zero vol time accrues), 1.0 = full trading
    day. Crypto trades 24/7 so "holiday" really means "weight adjustment"
    rather than a closure — but the math handles both.

    `holiday_names[d]` is purely cosmetic (UI label). Not part of the
    revision hash, so renames don't trigger refits.
    """
    holiday_weights: dict[date, float] = field(default_factory=dict)
    holiday_names: dict[date, str] = field(default_factory=dict)
    sat_weight: float = 0.4
    sun_weight: float = 0.6


DEFAULT_CALENDAR = Calendar()


def calendar_rev(c: Calendar) -> str:
    """SHA-1 of the load-bearing fields only.

    Names are excluded so that editing a holiday's display label does not
    invalidate cached fits (per M3.6 spec). Holiday weights are sorted by
    ISO date string for deterministic ordering across Python dict insertion
    orders.
    """
    payload = {
        "holiday_weights": {d.isoformat(): w for d, w in sorted(c.holiday_weights.items())},
        "sat_weight": c.sat_weight,
        "sun_weight": c.sun_weight,
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha1(blob).hexdigest()[:12]


def cal_yte(expiry_ms: int, as_of_ms: int) -> float:
    """Calendar-time YTE in years. Calendar-independent."""
    if expiry_ms <= as_of_ms:
        return 0.0
    return (expiry_ms - as_of_ms) / _MS_PER_YEAR


def day_weight(d: date, calendar: Calendar) -> float:
    """Weight assigned to a single UTC calendar day under `calendar`.

    Holiday entries override weekday defaults entirely — a Saturday holiday
    uses its `holiday_weights[d]` value, NOT `sat_weight * holiday_weight`.
    """
    if d in calendar.holiday_weights:
        return calendar.holiday_weights[d]
    wd = d.weekday()  # Mon=0 ... Sun=6
    if wd == 5:
        return calendar.sat_weight
    if wd == 6:
        return calendar.sun_weight
    return 1.0


def vol_yte(expiry_ms: int, as_of_ms: int, calendar: Calendar) -> float:
    """Weighted year-to-expiry under `calendar`.

    Sums day-weight × fraction-of-day for the partial first/last days plus
    full-weight for whole days in between, then divides by 365 — so a
    sat=sun=1 calendar reduces to `cal_yte` exactly.
    """
    if expiry_ms <= as_of_ms:
        return 0.0

    start_date = datetime.fromtimestamp(as_of_ms / 1000, tz=timezone.utc).date()
    end_date = datetime.fromtimestamp(expiry_ms / 1000, tz=timezone.utc).date()

    if start_date == end_date:
        return day_weight(start_date, calendar) * (expiry_ms - as_of_ms) / _MS_PER_DAY / 365.0

    start_midnight_ms = int(datetime(
        start_date.year, start_date.month, start_date.day, tzinfo=timezone.utc,
    ).timestamp() * 1000)
    end_midnight_ms = int(datetime(
        end_date.year, end_date.month, end_date.day, tzinfo=timezone.utc,
    ).timestamp() * 1000)

    # Partial first day (as_of_ms → next midnight) + partial last day
    # (end midnight → expiry_ms) + every full day strictly between.
    first_frac = 1.0 - (as_of_ms - start_midnight_ms) / _MS_PER_DAY
    last_frac = (expiry_ms - end_midnight_ms) / _MS_PER_DAY
    weighted_days = (
        day_weight(start_date, calendar) * first_frac
        + day_weight(end_date, calendar) * last_frac
    )
    d = start_date + timedelta(days=1)
    while d < end_date:
        weighted_days += day_weight(d, calendar)
        d += timedelta(days=1)

    return weighted_days / 365.0


def total_vol_days_per_year(calendar: Calendar, year: int | None = None) -> float:
    """Sum of day weights over a calendar year (UTC). Used by the VolCalendar
    diagnostics rail. Defaults to the current UTC year so the figure tracks
    the actual holidays the user is editing for the year ahead."""
    if year is None:
        year = datetime.now(tz=timezone.utc).year
    d = date(year, 1, 1)
    end = date(year + 1, 1, 1)
    total = 0.0
    while d < end:
        total += day_weight(d, calendar)
        d += timedelta(days=1)
    return total


# ---------- (de)serialization ----------


def calendar_to_dict(c: Calendar) -> dict:
    """ISO-date strings on the wire; weight + name dicts kept separate so
    a holiday with weight = 0.0 is distinguishable from "no holiday set"."""
    return {
        "holiday_weights": {d.isoformat(): w for d, w in c.holiday_weights.items()},
        "holiday_names": {d.isoformat(): n for d, n in c.holiday_names.items()},
        "sat_weight": c.sat_weight,
        "sun_weight": c.sun_weight,
    }


def calendar_from_dict(payload: dict) -> Calendar:
    weights_in = payload.get("holiday_weights") or {}
    names_in = payload.get("holiday_names") or {}
    return Calendar(
        holiday_weights={date.fromisoformat(k): float(v) for k, v in weights_in.items()},
        holiday_names={date.fromisoformat(k): str(v) for k, v in names_in.items()},
        sat_weight=float(payload.get("sat_weight", 0.4)),
        sun_weight=float(payload.get("sun_weight", 0.6)),
    )


# ---------- module-level active calendar (FastAPI singleton state) ----------


_active_calendar: Calendar = DEFAULT_CALENDAR


def get_active_calendar() -> Calendar:
    return _active_calendar


def set_active_calendar(c: Calendar) -> None:
    global _active_calendar
    _active_calendar = c
