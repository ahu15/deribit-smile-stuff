from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from backend.chain import BookSummary, ChainSnapshot
from backend.ratelimit import RateLimitStatus


class VenueAdapter(ABC):
    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    @abstractmethod
    def chain_stream(self, currency: str) -> AsyncIterator[ChainSnapshot]: ...

    @abstractmethod
    async def refresh_book_summaries(self, currency: str) -> list[BookSummary]: ...

    @property
    @abstractmethod
    def rate_limit_status(self) -> RateLimitStatus: ...
