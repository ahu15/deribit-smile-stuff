"""M2.5 — Startup backfill orchestrator.

Seeds the `HistoryStore` with the past 24h of:
  * per-instrument mark/IV history reconstructed from `get_last_trades_by_currency`
    (one call per ccy returns trades across all instruments — cheapest path).
  * forward-curve path: `get_tradingview_chart_data` for the perp + each future.
  * DVOL: `get_volatility_index_data` per currency.

All requests run at PRIORITY_BACKFILL through the rate-limit-aware queue, so
the live 2s chain poll preempts. Dead instruments (no trades in lookback) are
skipped — we never per-instrument poll them. Per-expiry option groups are
ordered ATM-first so the front month gets depth fastest.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Any, Callable

from backend.chain import parse_expiry
from backend.history import (
    BackfillProgress,
    HistoryStore,
    LOOKBACK_MS,
    TradePrint,
)
from backend.venues.deribit.rest_client import DeribitRestClient

log = logging.getLogger(__name__)


@dataclass
class _ForwardInstrument:
    name: str
    is_perpetual: bool


class Backfill:
    def __init__(
        self,
        rest: DeribitRestClient,
        store: HistoryStore,
        currencies: list[str],
        lookback_ms: int = LOOKBACK_MS,
    ) -> None:
        self._rest = rest
        self._store = store
        self._currencies = currencies
        self._lookback_ms = lookback_ms
        self.progress = BackfillProgress()
        self._listeners: set[Callable[[dict[str, Any]], None]] = set()

    # ---------- subscriber protocol for status pill ----------

    def subscribe(self, fn: Callable[[dict[str, Any]], None]) -> Callable[[], None]:
        self._listeners.add(fn)
        fn(self.progress.snapshot())
        return lambda: self._listeners.discard(fn)

    def _publish(self) -> None:
        snap = self.progress.snapshot()
        for fn in tuple(self._listeners):
            try:
                fn(snap)
            except Exception as exc:  # listener errors must not break the orchestrator
                log.warning("backfill listener error: %s", exc)

    # ---------- run ----------

    async def run(self) -> None:
        now = int(time.time() * 1000)
        start = now - self._lookback_ms

        # Plan: 1 trade-history task per ccy, 1 DVOL task per ccy, plus N forward-curve
        # tasks (perp + futures). We learn N after fetching instruments; bump total when
        # we do, so progress only ever increases (never decreases past completed).
        self.progress.state = "running"
        self.progress.started_at_ms = now
        self.progress.total = len(self._currencies) * 2  # trades + dvol per ccy
        self.progress.completed = 0
        self._publish()

        tasks: list[asyncio.Task] = []
        for ccy in self._currencies:
            tasks.append(asyncio.create_task(self._backfill_trades(ccy, start, now)))
            tasks.append(asyncio.create_task(self._backfill_dvol(ccy, start, now)))
            tasks.append(asyncio.create_task(self._backfill_forwards(ccy, start, now)))

        # Wait for all top-level tasks; per-task failures are logged inside.
        await asyncio.gather(*tasks, return_exceptions=True)

        self.progress.state = "done"
        self.progress.finished_at_ms = int(time.time() * 1000)
        self._publish()
        log.info(
            "backfill complete in %.1fs (%d/%d tasks)",
            (self.progress.finished_at_ms - self.progress.started_at_ms) / 1000.0,
            self.progress.completed,
            self.progress.total,
        )

    # ---------- ccy-wide trade backfill ----------

    async def _backfill_trades(self, currency: str, start_ms: int, end_ms: int) -> None:
        try:
            trades = await self._rest.get_last_trades_by_currency(
                currency, start_ms, end_ms, kind="option", count=1000,
            )
            seen: set[str] = set()
            for t in trades:
                inst = t.get("instrument_name") or ""
                if not inst:
                    continue
                seen.add(inst)
                ts = int(t.get("timestamp") or 0)
                price = float(t.get("price") or 0.0)
                iv = t.get("iv")
                iv_decimal = (iv / 100.0) if isinstance(iv, (int, float)) else None
                self._store.append_trade(TradePrint(
                    instrument_name=inst,
                    ts_ms=ts,
                    price=price,
                    iv=iv_decimal,
                    direction=t.get("direction") or "",
                    amount=float(t.get("amount") or 0.0),
                    trade_id=str(t.get("trade_id") or ""),
                ))
                # Seed mark/IV history from each print — these are the actual
                # transaction prices and traded IVs, the densest available signal.
                self._store.append_series(inst, "mark", ts, price)
                if iv_decimal is not None:
                    self._store.append_series(inst, "mark_iv", ts, iv_decimal)
            log.info("backfill %s trades: %d prints across %d instruments", currency, len(trades), len(seen))
        except Exception as exc:
            log.warning("backfill trades %s failed: %s", currency, exc)
        finally:
            self.progress.completed += 1
            self._publish()

    # ---------- ccy-wide DVOL ----------

    async def _backfill_dvol(self, currency: str, start_ms: int, end_ms: int) -> None:
        try:
            data = await self._rest.get_volatility_index_data(currency, start_ms, end_ms, resolution="60")
            # Deribit returns {"data": [[ts, open, high, low, close], ...]}.
            for row in data.get("data") or []:
                if len(row) < 5:
                    continue
                ts = int(row[0])
                close = float(row[4])
                self._store.append_aggregate(currency, "dvol", ts, close)
            log.info("backfill %s DVOL: %d bars", currency, len(data.get("data") or []))
        except Exception as exc:
            log.warning("backfill DVOL %s failed: %s", currency, exc)
        finally:
            self.progress.completed += 1
            self._publish()

    # ---------- forward curve (perp + futures) ----------

    async def _backfill_forwards(self, currency: str, start_ms: int, end_ms: int) -> None:
        try:
            instruments = await self._rest.get_instruments(currency, kind="future")
            forwards = [
                _ForwardInstrument(name=i["instrument_name"], is_perpetual=i.get("settlement_period") == "perpetual")
                for i in instruments
                if i.get("instrument_name")
            ]
        except Exception as exc:
            log.warning("backfill forwards %s instruments lookup failed: %s", currency, exc)
            return

        # Each forward is one progress unit — bump the total once we know it.
        self.progress.total += len(forwards)
        self._publish()

        for fwd in forwards:
            await self._backfill_one_forward(currency, fwd, start_ms, end_ms)

    async def _backfill_one_forward(
        self,
        currency: str,
        fwd: _ForwardInstrument,
        start_ms: int,
        end_ms: int,
    ) -> None:
        try:
            chart = await self._rest.get_tradingview_chart_data(
                fwd.name, start_ms, end_ms, resolution="1",
            )
            ticks = chart.get("ticks") or []
            closes = chart.get("close") or []
            if fwd.is_perpetual:
                field_name = "perp"
            else:
                expiry = parse_expiry(fwd.name)
                if not expiry:
                    log.warning("backfill forward: could not parse expiry from %s, skipping", fwd.name)
                    return
                field_name = f"forward_fut:{expiry}"
            for ts, close in zip(ticks, closes):
                if close is None:
                    continue
                self._store.append_aggregate(currency, field_name, int(ts), float(close))
        except Exception as exc:
            log.warning("backfill forward %s failed: %s", fwd.name, exc)
        finally:
            self.progress.completed += 1
            self._publish()
