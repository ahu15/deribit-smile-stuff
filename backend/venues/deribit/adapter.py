import asyncio
import logging
import time
from collections import defaultdict
from collections.abc import AsyncIterator

from backend.chain import BookSummary, ChainSnapshot, OptionMark
from backend.ratelimit import RateLimitStatus
from backend.venues.base import VenueAdapter
from .auth import load_credentials
from .rest_client import DeribitRestClient

log = logging.getLogger(__name__)

_SUPPORTED_CURRENCIES = ["BTC", "ETH"]
_POLL_INTERVAL = 2.0  # seconds between book-summary polls


class DeribitAdapter(VenueAdapter):
    def __init__(self) -> None:
        self._creds = load_credentials()
        self._rest = DeribitRestClient(self._creds)
        self._mark_queues: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._snapshots: dict[str, ChainSnapshot] = {}
        self._tasks: list[asyncio.Task] = []

    async def start(self) -> None:
        await self._rest.start()
        for ccy in _SUPPORTED_CURRENCIES:
            self._tasks.append(asyncio.create_task(self._poll_loop(ccy)))
        log.info("DeribitAdapter started — REST polling @ %.0fs", _POLL_INTERVAL)

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
        for s in summaries:
            name = s.get("instrument_name", "")
            if not name:
                continue
            # book_summary IV is quoted in percent — normalise to decimal.
            mark_iv_pct = s.get("mark_iv") or 0.0
            snap.marks[name] = OptionMark(
                instrument_name=name,
                mark_iv=mark_iv_pct / 100.0,
                mark_price=s.get("mark_price") or 0.0,
                underlying_price=s.get("underlying_price") or 0.0,
                timestamp_ms=ts,
            )
            snap.book_summaries[name] = BookSummary(
                instrument_name=name,
                bid_iv=(s["bid_iv"] / 100.0) if s.get("bid_iv") is not None else None,
                ask_iv=(s["ask_iv"] / 100.0) if s.get("ask_iv") is not None else None,
                bid_price=s.get("bid_price"),
                ask_price=s.get("ask_price"),
                open_interest=s.get("open_interest") or 0.0,
                volume_24h=s.get("volume") or 0.0,
                underlying_price=s.get("underlying_price") or 0.0,
                timestamp_ms=ts,
            )

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
