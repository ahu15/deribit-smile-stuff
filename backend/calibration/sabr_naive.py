"""SABR-naive calibrators (M3.7).

Two cells of the methodology Cartesian product land here:
  * `sabr_none_uniform_cal` — calendar-time t_years, uniform residual weights.
  * `sabr_none_uniform_wkg` — wkg-time t_years, uniform residual weights.

Both wrap `backend.fit.fit_smile` (the math kernel). The wkg variant is the
only one whose cache key depends on `calendar_rev`; the cal variant is
calendar-independent (its t_years comes from `cal_yte`, which doesn't read
the active calendar at all). Adapter caching honors that distinction.

Naive in this context means freeze=none and weights=uniform — no term-
structure dependency, no per-strike weighting. The "naive SABR" alias
resolves to `sabr_none_uniform_cal` to preserve the M3.5 / M3.6 behavior
byte-for-byte.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from backend.chain import parse_expiry, parse_strike
from backend.fit import average_iv_by_strike, fit_smile

from .types import FitContext, FitResult


@dataclass
class SabrNaiveCalibrator:
    """SABR with no frozen params and uniform residual weights."""
    methodology: str
    family: str
    freeze: str
    weights: str
    time_basis: Literal["cal", "wkg"]
    requires_ts: bool
    label: str

    def fit(self, ctx: FitContext) -> FitResult | None:
        snap = ctx.snapshot
        forward = 0.0
        pairs: list[tuple[float, float]] = []
        for name, mark in snap.marks.items():
            if parse_expiry(name) != ctx.expiry:
                continue
            strike = parse_strike(name)
            if strike is None:
                continue
            pairs.append((strike, mark.mark_iv))
            if mark.underlying_price > 0:
                forward = mark.underlying_price
        strikes, ivs = average_iv_by_strike(pairs)
        if forward <= 0 or not strikes:
            return None

        t = ctx.t_years_wkg if self.time_basis == "wkg" else ctx.t_years_cal
        if t <= 0:
            return None

        raw = fit_smile(forward, t, strikes, ivs, beta=1.0)
        if raw is None:
            return None

        weights = [1.0] * len(raw.market_strikes)
        return FitResult(
            kind="sabr",
            methodology=self.methodology,
            params={
                "alpha": raw.alpha,
                "rho": raw.rho,
                "volvol": raw.volvol,
                "beta": raw.beta,
            },
            forward=raw.forward,
            t_years=raw.t_years,
            t_years_cal=ctx.t_years_cal,
            t_years_wkg=ctx.t_years_wkg,
            calendar_rev=ctx.calendar_rev,
            strikes=raw.strikes,
            fitted_iv=raw.fitted_iv,
            market_strikes=raw.market_strikes,
            market_iv=raw.market_iv,
            weights_used=weights,
            residual_rms=raw.residual_rms,
            weighted_residual_rms=raw.residual_rms,  # uniform → equal
            frozen=[],
        )
