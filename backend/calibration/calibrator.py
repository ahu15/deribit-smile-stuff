"""Calibrator protocol (M3.7).

Stable surface that every smile preset (sabr-naive today, alpha-from-ts /
volvol-and-alpha-from-ts in M3.8) implements. The registry stores instances
of this protocol; `DeribitAdapter` calls `.fit(ctx)` per (currency, expiry,
methodology) per chain poll, with snapshot-keyed caching one layer up.

Kept as a Protocol rather than an ABC so the existing module-level
`fit_smile` math doesn't need an OO wrapper — a plain object with the right
attributes + a `fit` method satisfies it.
"""

from __future__ import annotations

from typing import Literal, Protocol, runtime_checkable

from .types import FitContext, FitResult


@runtime_checkable
class Calibrator(Protocol):
    methodology: str                              # registry id, e.g. "sabr_none_uniform_cal"
    family: str                                   # registry axis — matches FitResult.kind by construction
    freeze: str                                   # "none" | "alpha-from-ts" | "volvol-and-alpha-from-ts"
    weights: str                                  # "uniform" | "atm-manual" | "bidask-spread" | "bidask-spread-sma"
    time_basis: Literal["cal", "wkg"]
    requires_ts: bool                             # true iff freeze axis pins a param from a TS curve
    label: str                                    # UI label
    def fit(self, ctx: FitContext) -> FitResult | None: ...
