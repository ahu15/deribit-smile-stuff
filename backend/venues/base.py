from abc import ABC, abstractmethod
from collections.abc import AsyncIterator

from backend.chain import ChainSnapshot
from backend.ratelimit import RateLimitStatus


class VenueAdapter(ABC):
    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    @abstractmethod
    def chain_stream(self, currency: str) -> AsyncIterator[ChainSnapshot]: ...

    @property
    @abstractmethod
    def rate_limit_status(self) -> RateLimitStatus: ...
