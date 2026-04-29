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
            exp = parse_expiry(name)
            if exp:
                seen.add(exp)
        return sorted(seen)


def parse_expiry(instrument_name: str) -> str | None:
    """Deribit instrument naming: `{CCY}-{EXPIRY}-{STRIKE}-{C|P}` for options,
    `{CCY}-{EXPIRY}` for dated futures, `{CCY}-PERPETUAL` for perpetuals.
    Returns the EXPIRY token (e.g. "26APR26") or None for perpetuals / malformed names.
    """
    parts = instrument_name.split("-")
    if len(parts) < 2:
        return None
    expiry = parts[1]
    if expiry == "PERPETUAL":
        return None
    return expiry
