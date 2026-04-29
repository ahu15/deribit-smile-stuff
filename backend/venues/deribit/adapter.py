import asyncio
import logging
import time
from collections import defaultdict
from collections.abc import AsyncIterator

from backend.backfill import Backfill
from backend.chain import (
    BookSummary, ChainRow, ChainSnapshot, OptionMark,
    expiry_ms, parse_expiry, parse_option_type, parse_strike,
)
from backend.fit import FitResult, fit_smile
from backend.history import HistoryStore
from backend.ratelimit import RateLimitStatus
from backend.venues.base import VenueAdapter
from .auth import load_credentials
from .rest_client import DeribitRestClient

log = logging.getLogger(__name__)

_SUPPORTED_CURRENCIES = ["BTC", "ETH"]
_POLL_INTERVAL = 2.0  # seconds between book-summary polls
_HOUR_MS = 60 * 60 * 1000
_DAY_MS = 24 * _HOUR_MS


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

    async def refresh_book_summaries(self, currency: str) -> list[BookSummary]:
        summaries = await self._rest.get_book_summary_by_currency(currency)
        self._merge(currency, summaries)
        snap = self._snapshots.get(currency)
        return list(snap.book_summaries.values()) if snap else []

    # ---------- M3 chain & smile views ----------

    def latest_snapshot(self, currency: str) -> ChainSnapshot | None:
        return self._snapshots.get(currency)

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

            rows.append(ChainRow(
                instrument_name=name,
                expiry=inst_expiry,
                strike=strike,
                option_type=opt_type,
                mark_iv=mark.mark_iv,
                bid_iv=book.bid_iv if book else None,
                ask_iv=book.ask_iv if book else None,
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
        # Per-strike: prefer the side with non-zero IV. If both have IV, average.
        by_strike: dict[float, list[float]] = defaultdict(list)
        for name, mark in snap.marks.items():
            if parse_expiry(name) != expiry:
                continue
            strike = parse_strike(name)
            if strike is None or mark.mark_iv <= 0:
                continue
            by_strike[strike].append(mark.mark_iv)
            if mark.underlying_price > 0:
                forward = mark.underlying_price
        if forward <= 0 or not by_strike:
            return None

        ex_ms = expiry_ms(expiry)
        if ex_ms is None:
            return None
        t_years = (ex_ms - snap.timestamp_ms) / (365.0 * 86400.0 * 1000.0)
        if t_years <= 0:
            return None

        strikes = sorted(by_strike.keys())
        ivs = [sum(by_strike[k]) / len(by_strike[k]) for k in strikes]
        return fit_smile(forward, t_years, strikes, ivs, beta=1.0)

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
