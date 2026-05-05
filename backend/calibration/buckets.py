"""Bucketed historic-fit caches (M3.9).

Hourly-boundary buckets covering the trailing 24h of `HistoryStore`. Two
caches (smile + term-structure) live as fields on `DeribitAdapter`; this
module owns the bucket math + the helper that walks history at a given
`as_of_ms` to assemble a synthetic `ChainSnapshot`.

Why this exists:

  * Powers the M3.9 history-overlay UI (`SmileChart` / `TermStructureChart`
    "show N hourly snapshots") and the cross-methodology comparison.
  * Will be re-consumed by M4.5's `AnalysisService.fitHistory` — that
    service becomes a lookup over this cache rather than its own bucketing
    pass, which keeps the bucketing logic in one place.

Cache key includes `calendar_rev` so wkg-basis entries fall out of cache
on a recalibrate; cal-basis entries don't depend on it but we keep the
field uniform across the dict (cal entries naturally never collide).
"""

from __future__ import annotations

from backend.calibration.types import FitResult
from backend.curves.builder import TermStructureSnapshot

HOUR_MS = 60 * 60 * 1000
DAY_MS = 24 * HOUR_MS


def bucket_floor(ts_ms: int) -> int:
    """Round a millisecond timestamp down to the nearest wall-clock hour.

    Wall-clock alignment (UTC, since the Deribit clock the chain poll
    timestamps come from is UTC) — so different subscribers see the same
    bucket boundaries regardless of when they connected.
    """
    return (ts_ms // HOUR_MS) * HOUR_MS


def bucket_boundaries(now_ms: int, lookback_ms: int) -> list[int]:
    """Hourly bucket timestamps in [now-lookback, now], oldest first.

    The most-recent bucket is `bucket_floor(now_ms)` — the current
    in-progress hour. Subscribers see this bucket update during the hour
    (each chain poll inside the hour overwrites it with the latest fit)
    and a new bucket lands at the next hour-tick.
    """
    head = bucket_floor(now_ms)
    tail = bucket_floor(now_ms - lookback_ms)
    out: list[int] = []
    cursor = tail
    while cursor <= head:
        out.append(cursor)
        cursor += HOUR_MS
    return out


# Cache key shapes — kept as plain tuples so they're hashable and trivial
# to inspect when debugging a stale entry.
SmileBucketKey = tuple[str, str, str, str | None, int, str]
# (currency, expiry, methodology, ts_method, bucket_ts, calendar_rev)

TsBucketKey = tuple[str, str, int, str]
# (currency, ts_method, bucket_ts, calendar_rev)


def evict_old_smile_buckets(
    cache: dict[SmileBucketKey, FitResult | None],
    now_ms: int,
) -> None:
    """Drop entries whose bucket_ts is older than `now - 24h`.

    Mirrors the 24h `HistoryStore` cap — once the underlying chain
    samples for a bucket fall out of history, the bucket itself stops
    being meaningful.
    """
    cutoff = bucket_floor(now_ms - DAY_MS)
    stale = [k for k in cache if k[4] < cutoff]
    for k in stale:
        del cache[k]


def evict_old_ts_buckets(
    cache: dict[TsBucketKey, TermStructureSnapshot | None],
    now_ms: int,
) -> None:
    cutoff = bucket_floor(now_ms - DAY_MS)
    stale = [k for k in cache if k[2] < cutoff]
    for k in stale:
        del cache[k]
