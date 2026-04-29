from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone


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
class ChainSnapshot:
    currency: str
    timestamp_ms: int
    marks: dict[str, OptionMark] = field(default_factory=dict)
    book_summaries: dict[str, BookSummary] = field(default_factory=dict)

    def expiries(self) -> list[str]:
        seen: set[str] = set()
        for name in self.marks:
            exp = parse_expiry(name)
            if exp:
                seen.add(exp)
        return sorted(seen, key=lambda e: expiry_ms(e) or 0)


@dataclass
class ChainRow:
    """Flat per-instrument row for the ChainTable widget. All vols are decimal,
    prices are coin-denominated (Deribit native), changes come from the M2.5
    HistoryStore (None until enough history exists).
    """
    instrument_name: str
    expiry: str
    strike: float
    option_type: str          # "C" | "P"
    mark_iv: float
    bid_iv: float | None
    ask_iv: float | None
    mark_price: float
    bid_price: float | None
    ask_price: float | None
    mid_price: float | None
    spread: float | None
    open_interest: float
    volume_24h: float
    underlying_price: float
    change_1h: float | None       # absolute change in mark_price vs ~1h ago
    change_24h: float | None
    change_iv_1h: float | None    # absolute change in mark_iv vs ~1h ago, decimal
    timestamp_ms: int


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


def parse_strike(instrument_name: str) -> float | None:
    parts = instrument_name.split("-")
    if len(parts) < 4:
        return None
    try:
        return float(parts[2])
    except ValueError:
        return None


def parse_option_type(instrument_name: str) -> str | None:
    parts = instrument_name.split("-")
    if len(parts) < 4:
        return None
    t = parts[3].upper()
    return t if t in ("C", "P") else None


def expiry_ms(expiry_token: str) -> int | None:
    """Deribit options expire at 08:00 UTC on the expiry date. Returns the
    expiry epoch in milliseconds, or None if `expiry_token` doesn't parse.
    """
    if not expiry_token or expiry_token == "PERPETUAL":
        return None
    try:
        dt = datetime.strptime(expiry_token, "%d%b%y")
    except ValueError:
        return None
    dt = dt.replace(hour=8, minute=0, second=0, tzinfo=timezone.utc)
    return int(dt.timestamp() * 1000)
