import asyncio
import logging
import ssl
import time
from typing import Any

import httpx
import truststore

from backend.ratelimit import PriorityRestQueue, RateLimitStatus, TokenBucket
from .auth import DeribitCredentials


def _make_ssl_ctx() -> ssl.SSLContext:
    ctx = truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ctx.check_hostname = True
    ctx.verify_mode = ssl.CERT_REQUIRED
    return ctx

log = logging.getLogger(__name__)

_ENDPOINT_COSTS: dict[str, float] = {
    "public/get_book_summary_by_currency": 2.0,
    "public/get_last_trades_by_instrument_and_time": 2.0,
    "public/get_last_trades_by_currency": 2.0,
    "public/get_last_trades_by_currency_and_time": 2.0,
    "public/get_tradingview_chart_data": 2.0,
    "public/get_volatility_index_data": 1.0,
    "public/get_instruments": 1.0,
}


class DeribitRestClient:
    def __init__(self, credentials: DeribitCredentials):
        self._base = credentials.rest_base_url
        self._bucket = TokenBucket(sustained_rate=5.0, burst_size=20.0)
        self._queue = PriorityRestQueue(self._bucket, _ENDPOINT_COSTS)
        self._client: httpx.AsyncClient | None = None
        self._run_task: asyncio.Task | None = None

    async def start(self) -> None:
        self._client = httpx.AsyncClient(timeout=15.0, verify=_make_ssl_ctx())
        self._run_task = asyncio.create_task(self._queue.run())

    async def stop(self) -> None:
        self._queue.stop()
        if self._run_task:
            self._run_task.cancel()
        if self._client:
            await self._client.aclose()

    async def _get(
        self,
        endpoint: str,
        params: dict[str, Any],
        priority: int = PriorityRestQueue.PRIORITY_LIVE,
    ) -> Any:
        url = f"{self._base}/{endpoint}"
        cost = self._queue.endpoint_cost(endpoint)

        async def fetch() -> Any:
            for attempt in range(5):
                try:
                    resp = await self._client.get(url, params=params)
                    if resp.status_code == 429:
                        self._bucket.last_throttled = time.time()
                        await asyncio.sleep(2 ** attempt)
                        continue
                    body = resp.json()
                    if "error" in body:
                        code = body["error"].get("code", 0)
                        if code == 10028:
                            self._bucket.last_throttled = time.time()
                            backoff = 2 ** attempt
                            log.warning("10028 on %s, backing off %.0fs", endpoint, backoff)
                            await asyncio.sleep(backoff)
                            continue
                        raise RuntimeError(f"Deribit error: {body['error']}")
                    return body.get("result")
                except (httpx.RequestError, RuntimeError) as exc:
                    log.warning("%s attempt %d: %s", endpoint, attempt + 1, exc)
                    await asyncio.sleep(2 ** attempt)
            raise RuntimeError(f"max retries exceeded for {endpoint}")

        return await self._queue.submit(fetch, priority=priority, cost=cost)

    async def get_book_summary_by_currency(
        self, currency: str, kind: str = "option"
    ) -> list[dict]:
        return await self._get(
            "public/get_book_summary_by_currency",
            {"currency": currency, "kind": kind},
        ) or []

    async def get_time(self) -> int:
        """Cheap endpoint — returns Deribit server time (ms). Used by pingService."""
        return await self._get("public/get_time", {})

    async def get_last_trades_by_instrument(
        self,
        instrument_name: str,
        start_timestamp: int,
        end_timestamp: int,
        count: int = 1000,
    ) -> list[dict]:
        result = await self._get(
            "public/get_last_trades_by_instrument_and_time",
            {
                "instrument_name": instrument_name,
                "start_timestamp": start_timestamp,
                "end_timestamp": end_timestamp,
                "count": count,
            },
            priority=PriorityRestQueue.PRIORITY_BACKFILL,
        )
        return (result or {}).get("trades", [])

    async def get_last_trades_by_currency(
        self,
        currency: str,
        start_timestamp: int,
        end_timestamp: int,
        kind: str = "option",
        count: int = 1000,
    ) -> list[dict]:
        """One call returns trades across every instrument of `kind` for `currency`.

        Deribit returns trades **oldest-first** for a `[start, end]` window
        with `include_old=true`, so we page forward by advancing
        `start_timestamp` past the latest trade in the previous page until
        `has_more` is false. (The original implementation walked the cursor
        backwards from `end`, which made the first page chase its own tail
        and silently capped the backfill at ~1000 trades — the oldest
        sliver of the window only.)
        """
        all_trades: list[dict] = []
        cursor_start = start_timestamp
        for _ in range(20):  # hard ceiling — 20 * 1000 = 20k trades / ccy / 24h is plenty
            result = await self._get(
                "public/get_last_trades_by_currency_and_time",
                {
                    "currency": currency,
                    "kind": kind,
                    "start_timestamp": cursor_start,
                    "end_timestamp": end_timestamp,
                    "count": count,
                    "include_old": True,
                },
                priority=PriorityRestQueue.PRIORITY_BACKFILL,
            )
            page = (result or {}).get("trades", [])
            if not page:
                break
            all_trades.extend(page)
            if not (result or {}).get("has_more"):
                break
            # Advance past the most-recent trade in this page so the next
            # call returns the next batch forward in time.
            latest_ts = max(t.get("timestamp", cursor_start) for t in page)
            if latest_ts >= end_timestamp:
                break
            cursor_start = latest_ts + 1
        return all_trades

    async def get_tradingview_chart_data(
        self,
        instrument_name: str,
        start_timestamp: int,
        end_timestamp: int,
        resolution: str = "1",
    ) -> dict:
        """OHLCV bars. `resolution` is minutes ("1", "5", ...) or "1D"."""
        result = await self._get(
            "public/get_tradingview_chart_data",
            {
                "instrument_name": instrument_name,
                "start_timestamp": start_timestamp,
                "end_timestamp": end_timestamp,
                "resolution": resolution,
            },
            priority=PriorityRestQueue.PRIORITY_BACKFILL,
        )
        return result or {}

    async def get_volatility_index_data(
        self,
        currency: str,
        start_timestamp: int,
        end_timestamp: int,
        resolution: str = "60",
    ) -> dict:
        """DVOL series. `resolution` is in seconds (e.g. "60" = 1-min bars)."""
        result = await self._get(
            "public/get_volatility_index_data",
            {
                "currency": currency,
                "start_timestamp": start_timestamp,
                "end_timestamp": end_timestamp,
                "resolution": resolution,
            },
            priority=PriorityRestQueue.PRIORITY_BACKFILL,
        )
        return result or {}

    async def get_instruments(self, currency: str, kind: str | None = None) -> list[dict]:
        params: dict[str, Any] = {"currency": currency, "expired": False}
        if kind:
            params["kind"] = kind
        result = await self._get("public/get_instruments", params)
        return result or []

    @property
    def rate_limit_status(self) -> RateLimitStatus:
        return self._queue.status()
