import asyncio
import logging
import time
from collections import defaultdict
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from backend.backfill import Backfill
from backend.chain import (
    BookSummary, ChainRow, ChainSnapshot, OptionMark,
    expiry_ms, parse_expiry, parse_option_type, parse_strike,
)
from backend.fit import FitResult, average_iv_by_strike, fit_smile
from backend.history import HistoryStore, Sample
from backend.iv import iv_from_price
from backend.ratelimit import RateLimitStatus
from backend.venues.base import VenueAdapter
from .auth import load_credentials
from .rest_client import DeribitRestClient

log = logging.getLogger(__name__)

_SUPPORTED_CURRENCIES = ["BTC", "ETH"]
_POLL_INTERVAL = 2.0  # seconds between book-summary polls
_MS_PER_YEAR = 365.0 * 86400.0 * 1000.0
_HOUR_MS = 60 * 60 * 1000
_DAY_MS = 24 * _HOUR_MS


@dataclass
class HistoricSmileFit:
    """One-shot SABR fit replayed from `HistoryStore` at a chosen `as_of_ms`.

    `snapped_ms` is the per-instrument-nearest-sample stamp that the fit
    actually used; outside the 24h buffer it collapses to the boundary.
    `earliest_ms` / `latest_ms` describe the window the caller can pick
    from for the requested expiry — used by the UI to surface "no data".
    """
    fit: FitResult | None = None
    market_points: list[tuple[float, float]] = field(default_factory=list)
    snapped_ms: int | None = None
    earliest_ms: int | None = None
    latest_ms: int | None = None
    forward: float | None = None


class DeribitAdapter(VenueAdapter):
    def __init__(self) -> None:
        self._creds = load_credentials()
        self._rest = DeribitRestClient(self._creds)
        self._mark_queues: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._snapshots: dict[str, ChainSnapshot] = {}
        self._tasks: list[asyncio.Task] = []
        self.history = HistoryStore()
        self.backfill = Backfill(self._rest, self.history, _SUPPORTED_CURRENCIES)

    async def start(self) -> None:
        await self._rest.start()
        for ccy in _SUPPORTED_CURRENCIES:
            self._tasks.append(asyncio.create_task(self._poll_loop(ccy)))
        # Backfill runs at PRIORITY_BACKFILL — live polling preempts via the queue.
        self._tasks.append(asyncio.create_task(self.backfill.run()))
        log.info("DeribitAdapter started — REST polling @ %.0fs + backfill", _POLL_INTERVAL)

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await self._rest.stop()

    async def _poll_loop(self, currency: str) -> None:
        while True:
            try:
                summaries = await self._rest.get_book_summary_by_currency(currency)
                self._merge(currency, summaries)
                snap = self._snapshots.get(currency)
                if snap:
                    self._emit(currency, snap)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                log.warning("poll error %s: %s", currency, exc)
            await asyncio.sleep(_POLL_INTERVAL)

    def _merge(self, currency: str, summaries: list[dict]) -> None:
        ts = _now_ms()
        snap = self._snapshots.setdefault(
            currency, ChainSnapshot(currency=currency, timestamp_ms=ts)
        )
        snap.timestamp_ms = ts
        # Per-expiry option-implied forward — every option carries its expiry's
        # forward in `underlying_price`. One value per expiry per snapshot;
        # written out once at the end of the loop to avoid 50× redundant appends.
        forward_opt_by_expiry: dict[str, float] = {}
        for s in summaries:
            name = s.get("instrument_name", "")
            if not name:
                continue
            # book_summary IV is quoted in percent — normalise to decimal.
            mark_iv = (s.get("mark_iv") or 0.0) / 100.0
            mark_price = s.get("mark_price") or 0.0
            bid_price = s.get("bid_price")
            ask_price = s.get("ask_price")
            bid_iv = (s["bid_iv"] / 100.0) if s.get("bid_iv") is not None else None
            ask_iv = (s["ask_iv"] / 100.0) if s.get("ask_iv") is not None else None
            underlying = s.get("underlying_price") or 0.0

            expiry = parse_expiry(name)
            if expiry and underlying and expiry not in forward_opt_by_expiry:
                forward_opt_by_expiry[expiry] = underlying

            snap.marks[name] = OptionMark(
                instrument_name=name,
                mark_iv=mark_iv,
                mark_price=mark_price,
                underlying_price=underlying,
                timestamp_ms=ts,
            )
            snap.book_summaries[name] = BookSummary(
                instrument_name=name,
                bid_iv=bid_iv,
                ask_iv=ask_iv,
                bid_price=bid_price,
                ask_price=ask_price,
                open_interest=s.get("open_interest") or 0.0,
                volume_24h=s.get("volume") or 0.0,
                underlying_price=underlying,
                timestamp_ms=ts,
            )

            # Live append into the M2.5 store — same source of truth for the live UI
            # and for any "vs N hours ago" / session-high-low computation.
            self.history.append_series(name, "mark", ts, mark_price)
            self.history.append_series(name, "mark_iv", ts, mark_iv)
            if bid_price is not None:
                self.history.append_series(name, "bid_price", ts, bid_price)
            if ask_price is not None:
                self.history.append_series(name, "ask_price", ts, ask_price)
            if bid_price is not None and ask_price is not None:
                mid = 0.5 * (bid_price + ask_price)
                self.history.append_series(name, "mid", ts, mid)
                self.history.append_series(name, "spread", ts, ask_price - bid_price)

        for expiry, fwd in forward_opt_by_expiry.items():
            self.history.append_aggregate(currency, f"forward_opt:{expiry}", ts, fwd)

    def _emit(self, currency: str, snap: ChainSnapshot) -> None:
        for q in list(self._mark_queues[currency]):
            try:
                q.put_nowait(snap)
            except asyncio.QueueFull:
                pass

    async def chain_stream(self, currency: str) -> AsyncIterator[ChainSnapshot]:
        if currency not in _SUPPORTED_CURRENCIES:
            raise ValueError(f"unsupported currency: {currency}")
        q: asyncio.Queue = asyncio.Queue(maxsize=50)
        self._mark_queues[currency].append(q)
        try:
            while True:
                snap = await q.get()
                yield snap
        finally:
            try:
                self._mark_queues[currency].remove(q)
            except ValueError:
                pass

    # ---------- M3 chain & smile views ----------

    def expiries(self, currency: str) -> list[str]:
        snap = self._snapshots.get(currency)
        return snap.expiries() if snap else []

    def chain_rows(self, currency: str, expiry: str | None) -> list[ChainRow]:
        snap = self._snapshots.get(currency)
        if not snap:
            return []
        rows: list[ChainRow] = []
        for name, mark in snap.marks.items():
            inst_expiry = parse_expiry(name)
            if expiry and inst_expiry != expiry:
                continue
            strike = parse_strike(name)
            opt_type = parse_option_type(name)
            if strike is None or opt_type is None or inst_expiry is None:
                continue
            book = snap.book_summaries.get(name)
            bid = book.bid_price if book else None
            ask = book.ask_price if book else None
            mid = 0.5 * (bid + ask) if (bid is not None and ask is not None) else None
            spread = (ask - bid) if (bid is not None and ask is not None) else None

            # Deribit's get_book_summary_by_currency doesn't return bid_iv /
            # ask_iv for options, so book.* is None in practice. Invert the
            # coin-denominated quote to a vol via BS (forward = mark.underlying_price,
            # which is per-expiry on Deribit), seeded from mark_iv so Newton
            # converges in a couple of iterations.
            bid_iv = book.bid_iv if book else None
            ask_iv = book.ask_iv if book else None
            if (bid_iv is None or ask_iv is None) and mark.mark_iv > 0:
                ex_ms = expiry_ms(inst_expiry)
                if ex_ms is not None:
                    t_years = (ex_ms - mark.timestamp_ms) / _MS_PER_YEAR
                    is_call = (opt_type == "C")
                    if bid_iv is None and bid is not None and bid > 0:
                        bid_iv = iv_from_price(
                            bid, mark.underlying_price, strike, t_years,
                            is_call=is_call, iv_guess=mark.mark_iv,
                        )
                    if ask_iv is None and ask is not None and ask > 0:
                        ask_iv = iv_from_price(
                            ask, mark.underlying_price, strike, t_years,
                            is_call=is_call, iv_guess=mark.mark_iv,
                        )

            rows.append(ChainRow(
                instrument_name=name,
                expiry=inst_expiry,
                strike=strike,
                option_type=opt_type,
                mark_iv=mark.mark_iv,
                bid_iv=bid_iv,
                ask_iv=ask_iv,
                mark_price=mark.mark_price,
                bid_price=bid,
                ask_price=ask,
                mid_price=mid,
                spread=spread,
                open_interest=book.open_interest if book else 0.0,
                volume_24h=book.volume_24h if book else 0.0,
                underlying_price=mark.underlying_price,
                change_1h=self.history.change(name, "mark", _HOUR_MS),
                change_24h=self.history.change(name, "mark", _DAY_MS),
                change_iv_1h=self.history.change(name, "mark_iv", _HOUR_MS),
                timestamp_ms=mark.timestamp_ms,
            ))
        rows.sort(key=lambda r: (expiry_ms(r.expiry) or 0, r.strike, r.option_type))
        return rows

    def smile_fit(self, currency: str, expiry: str) -> FitResult | None:
        """Fit SABR to the option-implied IVs for one expiry of the latest chain.

        Uses both calls and puts; Deribit's mark_iv agrees across the parity
        pair, so combining gives a denser quote set without bias.
        """
        snap = self._snapshots.get(currency)
        if not snap:
            return None
        forward = 0.0
        pairs: list[tuple[float, float]] = []
        for name, mark in snap.marks.items():
            if parse_expiry(name) != expiry:
                continue
            strike = parse_strike(name)
            if strike is None:
                continue
            pairs.append((strike, mark.mark_iv))
            if mark.underlying_price > 0:
                forward = mark.underlying_price
        strikes, ivs = average_iv_by_strike(pairs)
        if forward <= 0 or not strikes:
            return None

        ex_ms = expiry_ms(expiry)
        if ex_ms is None:
            return None
        t_years = (ex_ms - snap.timestamp_ms) / _MS_PER_YEAR
        if t_years <= 0:
            return None
        return fit_smile(forward, t_years, strikes, ivs, beta=1.0)

    def historic_smile_fit(
        self, currency: str, expiry: str, as_of_ms: int,
    ) -> HistoricSmileFit:
        """One-shot SABR fit from each instrument's closest mark_iv sample to
        `as_of_ms`. Frozen reference curve for the smile chart's "compare-to"
        overlay — outside the 24h buffer the snap collapses to the boundary
        so the user always gets *some* curve back.
        """
        snap = self._snapshots.get(currency)
        if not snap:
            return HistoricSmileFit()

        # Walk the expiry's universe once: capture the available window for
        # the UI's "data range" hint *and* the per-strike samples we'll snap.
        earliest_ms: int | None = None
        latest_ms: int | None = None
        per_inst_samples: list[tuple[float, list[Sample]]] = []
        for name in snap.marks:
            if parse_expiry(name) != expiry:
                continue
            strike = parse_strike(name)
            if strike is None:
                continue
            samples = self.history.series(name, "mark_iv")
            if not samples:
                continue
            if earliest_ms is None or samples[0].ts_ms < earliest_ms:
                earliest_ms = samples[0].ts_ms
            if latest_ms is None or samples[-1].ts_ms > latest_ms:
                latest_ms = samples[-1].ts_ms
            per_inst_samples.append((strike, samples))

        result = HistoricSmileFit(earliest_ms=earliest_ms, latest_ms=latest_ms)
        if not per_inst_samples:
            return result

        # Snap each instrument to its sample closest to `as_of_ms` (not
        # strictly at-or-before): outside the 24h window we clamp to a
        # boundary; inside it we tolerate sparse samples.
        pairs: list[tuple[float, float]] = []
        snapped_ms: int | None = None
        for strike, samples in per_inst_samples:
            best = min(samples, key=lambda s: abs(s.ts_ms - as_of_ms))
            pairs.append((strike, best.value))
            if snapped_ms is None or abs(best.ts_ms - as_of_ms) < abs(snapped_ms - as_of_ms):
                snapped_ms = best.ts_ms

        strikes, ivs = average_iv_by_strike(pairs)
        if not strikes or snapped_ms is None:
            return result

        # Forward at the snapped timestamp from the option-implied series.
        # Fall back to the latest snapshot's value if this expiry has no
        # forward history yet — order-of-magnitude correct for plotting.
        forward = self._forward_at(currency, expiry, snapped_ms)
        if forward is None or forward <= 0:
            return result

        ex_ms = expiry_ms(expiry)
        if ex_ms is None:
            return result
        t_years = (ex_ms - snapped_ms) / _MS_PER_YEAR
        if t_years <= 0:
            return result

        result.fit = fit_smile(forward, t_years, strikes, ivs, beta=1.0)
        result.market_points = list(zip(strikes, ivs))
        result.snapped_ms = snapped_ms
        result.forward = forward
        return result

    def _forward_at(self, currency: str, expiry: str, ts_ms: int) -> float | None:
        fwd_samples = self.history.aggregate(currency, f"forward_opt:{expiry}")
        if fwd_samples:
            best = min(fwd_samples, key=lambda s: abs(s.ts_ms - ts_ms))
            if best.value > 0:
                return best.value
        snap = self._snapshots.get(currency)
        if snap:
            for mark in snap.marks.values():
                if parse_expiry(mark.instrument_name) == expiry and mark.underlying_price > 0:
                    return mark.underlying_price
        return None

    async def ping_deribit(self) -> dict:
        """Round-trip ping that hits Deribit — for end-to-end pingService test."""
        t0 = time.time() * 1000
        server_time = await self._rest.get_time()
        return {
            "client_ts_ms": int(t0),
            "deribit_ts_ms": int(server_time),
            "rtt_ms": int(time.time() * 1000 - t0),
        }

    @property
    def rate_limit_status(self) -> RateLimitStatus:
        return self._rest.rate_limit_status


def _now_ms() -> int:
    return int(time.time() * 1000)
