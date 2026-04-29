"""M2.5 — Historical & live data layer.

In-memory time-series store for:
  * per-instrument fields (mark, mark_iv, bid_price, ask_price, mid, ...)
  * per-currency aggregate series (DVOL, perp price, index, forward curve)
  * per-instrument trade-print logs

All data is session-scoped, no disk, capped at ~24h. The live REST poll loop
appends here from `DeribitAdapter._merge`; the startup backfill seeds it via
`Backfill.run()` (see backfill.py).

Subscribers register via `subscribe_series` / `subscribe_trades` and receive
each new (ts, value) or trade dict as it's appended. Used by the WS oracle
endpoint to fan history out to browser tabs.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque
from dataclasses import dataclass
from typing import Any, Callable

# Per-instrument fields the adapter writes on each chain snapshot.
PerInstrumentField = str  # "mark" | "mark_iv" | "bid_price" | "ask_price" | "mid" | "spread" | "underlying_price"

# Per-currency aggregate fields:
#   "dvol"                   — DVOL index
#   "perp"                   — perpetual mark price
#   f"forward_opt:{expiry}"  — option-implied forward (live, from book_summary's underlying_price)
#   f"forward_fut:{expiry}"  — future mark price (backfilled from get_tradingview_chart_data)
# The two forward series share an expiry key so they can be diffed to surface basis.
AggregateField = str

LOOKBACK_MS = 24 * 60 * 60 * 1000  # 24h cap


@dataclass(frozen=True)
class Sample:
    ts_ms: int
    value: float


@dataclass
class TradePrint:
    instrument_name: str
    ts_ms: int
    price: float
    iv: float | None
    direction: str   # "buy" | "sell"
    amount: float
    trade_id: str


SeriesListener = Callable[[Sample], None]
TradeListener = Callable[[TradePrint], None]


def _now_ms() -> int:
    return int(time.time() * 1000)


def _trim(buf: deque, lookback_ms: int, now_ms: int) -> None:
    cutoff = now_ms - lookback_ms
    while buf and buf[0].ts_ms < cutoff:
        buf.popleft()


class HistoryStore:
    """Rolling 24h time-series store. Thread-safe for the single-writer (asyncio)
    backend; subscriber callbacks fire synchronously in the writer's context.
    """

    def __init__(self, lookback_ms: int = LOOKBACK_MS) -> None:
        self._lookback_ms = lookback_ms
        # (instrument, field) -> deque[Sample]
        self._series: dict[tuple[str, PerInstrumentField], deque[Sample]] = defaultdict(deque)
        # (currency, field) -> deque[Sample]
        self._aggregate: dict[tuple[str, AggregateField], deque[Sample]] = defaultdict(deque)
        # instrument -> deque[TradePrint]
        self._trades: dict[str, deque[TradePrint]] = defaultdict(deque)

        # Subscribers, keyed the same way as the backing maps.
        self._series_listeners: dict[tuple[str, PerInstrumentField], set[SeriesListener]] = defaultdict(set)
        self._aggregate_listeners: dict[tuple[str, AggregateField], set[SeriesListener]] = defaultdict(set)
        self._trade_listeners: dict[str, set[TradeListener]] = defaultdict(set)

        self._lock = threading.Lock()

    # ---------- writes ----------

    def append_series(self, instrument: str, field_name: PerInstrumentField, ts_ms: int, value: float) -> None:
        sample = Sample(ts_ms=ts_ms, value=value)
        with self._lock:
            buf = self._series[(instrument, field_name)]
            # Drop out-of-order or duplicate-timestamp samples — backfill seeds
            # before live, but a stale chain poll could land mid-backfill.
            if buf and ts_ms <= buf[-1].ts_ms:
                return
            buf.append(sample)
            _trim(buf, self._lookback_ms, ts_ms)
            listeners = tuple(self._series_listeners.get((instrument, field_name), ()))
        for fn in listeners:
            fn(sample)

    def append_aggregate(self, currency: str, field_name: AggregateField, ts_ms: int, value: float) -> None:
        sample = Sample(ts_ms=ts_ms, value=value)
        with self._lock:
            buf = self._aggregate[(currency, field_name)]
            if buf and ts_ms <= buf[-1].ts_ms:
                return
            buf.append(sample)
            _trim(buf, self._lookback_ms, ts_ms)
            listeners = tuple(self._aggregate_listeners.get((currency, field_name), ()))
        for fn in listeners:
            fn(sample)

    def append_trade(self, trade: TradePrint) -> None:
        with self._lock:
            buf = self._trades[trade.instrument_name]
            # Trades may legitimately share a millisecond — dedupe by trade_id.
            if buf and any(t.trade_id == trade.trade_id for t in _reversed_window(buf, 10)):
                return
            buf.append(trade)
            _trim(buf, self._lookback_ms, _now_ms())
            listeners = tuple(self._trade_listeners.get(trade.instrument_name, ()))
        for fn in listeners:
            fn(trade)

    # ---------- reads ----------

    def series(self, instrument: str, field_name: PerInstrumentField) -> list[Sample]:
        with self._lock:
            return list(self._series.get((instrument, field_name), ()))

    def aggregate(self, currency: str, field_name: AggregateField) -> list[Sample]:
        with self._lock:
            return list(self._aggregate.get((currency, field_name), ()))

    def trades(self, instrument: str) -> list[TradePrint]:
        with self._lock:
            return list(self._trades.get(instrument, ()))

    # ---------- helper queries ----------

    def change(self, instrument: str, field_name: PerInstrumentField, lookback_ms: int) -> float | None:
        """Latest value minus value `lookback_ms` ago. None if insufficient history."""
        samples = self.series(instrument, field_name)
        if not samples:
            return None
        latest = samples[-1]
        target_ts = latest.ts_ms - lookback_ms
        prior = _value_at_or_before(samples, target_ts)
        return None if prior is None else latest.value - prior

    def session_open(self, instrument: str, field_name: PerInstrumentField, session_start_ms: int) -> float | None:
        """First value at or after the given session-open timestamp."""
        samples = self.series(instrument, field_name)
        for s in samples:
            if s.ts_ms >= session_start_ms:
                return s.value
        return None

    def range(
        self,
        instrument: str,
        field_name: PerInstrumentField,
        t0_ms: int,
        t1_ms: int,
    ) -> list[Sample]:
        samples = self.series(instrument, field_name)
        return [s for s in samples if t0_ms <= s.ts_ms <= t1_ms]

    # ---------- subscriptions ----------

    def subscribe_series(self, instrument: str, field_name: PerInstrumentField, fn: SeriesListener) -> Callable[[], None]:
        with self._lock:
            self._series_listeners[(instrument, field_name)].add(fn)

        def unsubscribe() -> None:
            with self._lock:
                self._series_listeners.get((instrument, field_name), set()).discard(fn)

        return unsubscribe

    def subscribe_aggregate(self, currency: str, field_name: AggregateField, fn: SeriesListener) -> Callable[[], None]:
        with self._lock:
            self._aggregate_listeners[(currency, field_name)].add(fn)

        def unsubscribe() -> None:
            with self._lock:
                self._aggregate_listeners.get((currency, field_name), set()).discard(fn)

        return unsubscribe

    def subscribe_trades(self, instrument: str, fn: TradeListener) -> Callable[[], None]:
        with self._lock:
            self._trade_listeners[instrument].add(fn)

        def unsubscribe() -> None:
            with self._lock:
                self._trade_listeners.get(instrument, set()).discard(fn)

        return unsubscribe


# ---------- module-level helpers ----------

def _reversed_window(buf: deque[TradePrint], n: int):
    """Last `n` items of a deque without copying the whole thing."""
    if n <= 0 or not buf:
        return ()
    if len(buf) <= n:
        return reversed(buf)
    # deque indexing is O(n) for arbitrary positions but O(1) at the ends; this
    # walk is bounded by `n`, so it's fine.
    return (buf[-i] for i in range(1, n + 1))


def _value_at_or_before(samples: list[Sample], ts_ms: int) -> float | None:
    """Linear scan from the right; samples are short-lived (24h max) so this is fine."""
    for s in reversed(samples):
        if s.ts_ms <= ts_ms:
            return s.value
    return None


# ---------- backfill progress ----------

@dataclass
class BackfillProgress:
    """Reported via WS broadcast envelope. Status pill renders `history: NN%`."""
    state: str = "idle"   # "idle" | "running" | "done"
    total: int = 0
    completed: int = 0
    started_at_ms: int | None = None
    finished_at_ms: int | None = None

    @property
    def pct(self) -> float:
        return 0.0 if self.total == 0 else 100.0 * self.completed / self.total

    def snapshot(self) -> dict[str, Any]:
        return {
            "state": self.state,
            "total": self.total,
            "completed": self.completed,
            "pct": round(self.pct, 1),
            "started_at_ms": self.started_at_ms,
            "finished_at_ms": self.finished_at_ms,
        }
