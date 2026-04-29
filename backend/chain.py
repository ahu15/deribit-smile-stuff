from dataclasses import dataclass, field


@dataclass
class OptionMark:
    instrument_name: str
    mark_iv: float          # decimal, e.g. 0.85 = 85%
    mark_price: float       # in coin units
    underlying_price: float
    timestamp_ms: int


@dataclass
class BookSummary:
    instrument_name: str
    bid_iv: float | None
    ask_iv: float | None
    bid_price: float | None
    ask_price: float | None
    open_interest: float
    volume_24h: float
    underlying_price: float
    timestamp_ms: int


@dataclass
class ForwardPrice:
    instrument_name: str
    mark_price: float
    underlying_price: float
    timestamp_ms: int


@dataclass
class ChainSnapshot:
    currency: str
    timestamp_ms: int
    marks: dict[str, OptionMark] = field(default_factory=dict)
    forwards: dict[str, ForwardPrice] = field(default_factory=dict)
    book_summaries: dict[str, BookSummary] = field(default_factory=dict)

    def expiries(self) -> list[str]:
        seen: set[str] = set()
        for name in self.marks:
            parts = name.split("-")
            if len(parts) >= 3:
                seen.add(parts[1])
        return sorted(seen)
