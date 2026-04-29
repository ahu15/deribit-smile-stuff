import asyncio
import heapq
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Coroutine

log = logging.getLogger(__name__)


@dataclass
class RateLimitStatus:
    bucket_fill_pct: float = 100.0
    queue_depth: int = 0
    last_throttled: float | None = None


class TokenBucket:
    def __init__(self, sustained_rate: float = 5.0, burst_size: float = 20.0):
        self._rate = sustained_rate
        self._capacity = burst_size
        self._tokens = burst_size
        self._last_refill = time.monotonic()
        self._lock = asyncio.Lock()
        self.last_throttled: float | None = None

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)
        self._last_refill = now

    async def acquire(self, cost: float = 1.0) -> None:
        async with self._lock:
            while True:
                self._refill()
                if self._tokens >= cost:
                    self._tokens -= cost
                    return
                wait = (cost - self._tokens) / self._rate
                self.last_throttled = time.time()
                log.warning("rate limited, waiting %.2fs", wait)
                await asyncio.sleep(wait)

    def fill_pct(self) -> float:
        self._refill()
        return 100.0 * self._tokens / self._capacity


@dataclass(order=True)
class _PriorityItem:
    priority: int
    seq: int
    coro_fn: Callable[[], Coroutine[Any, Any, Any]] = field(compare=False)


class PriorityRestQueue:
    PRIORITY_LIVE = 0
    PRIORITY_BACKFILL = 10

    def __init__(self, bucket: TokenBucket, endpoint_costs: dict[str, float] | None = None):
        self._bucket = bucket
        self._endpoint_costs = endpoint_costs or {}
        self._heap: list[_PriorityItem] = []
        self._seq = 0
        self._event = asyncio.Event()
        self._heap_lock = asyncio.Lock()
        self._running = False

    def endpoint_cost(self, endpoint: str) -> float:
        return self._endpoint_costs.get(endpoint, 1.0)

    async def submit(
        self,
        coro_factory: Callable[[], Coroutine[Any, Any, Any]],
        priority: int = PRIORITY_LIVE,
        cost: float = 1.0,
    ) -> Any:
        result_q: asyncio.Queue = asyncio.Queue(maxsize=1)

        async def wrapped() -> None:
            try:
                val = await coro_factory()
                await result_q.put(("ok", val))
            except Exception as exc:
                await result_q.put(("err", exc))

        async with self._heap_lock:
            item = _PriorityItem(priority=priority, seq=self._seq, coro_fn=wrapped)
            self._seq += 1
            heapq.heappush(self._heap, item)
            self._event.set()

        kind, val = await result_q.get()
        if kind == "err":
            raise val
        return val

    def queue_depth(self) -> int:
        return len(self._heap)

    async def run(self) -> None:
        self._running = True
        while self._running:
            await self._event.wait()
            async with self._heap_lock:
                if not self._heap:
                    self._event.clear()
                    continue
                item = heapq.heappop(self._heap)
                if not self._heap:
                    self._event.clear()
            await self._bucket.acquire()
            await item.coro_fn()

    def stop(self) -> None:
        self._running = False
        self._event.set()

    def status(self) -> RateLimitStatus:
        return RateLimitStatus(
            bucket_fill_pct=self._bucket.fill_pct(),
            queue_depth=self.queue_depth(),
            last_throttled=self._bucket.last_throttled,
        )
