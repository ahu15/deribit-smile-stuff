"""SABR no-freeze calibrator (M3.7 + M3.8).

`SabrNaiveCalibrator` covers the freeze=none family. M3.7 shipped two
cells: `sabr_none_uniform_cal` and `sabr_none_uniform_wkg`. M3.8 widens
the weights axis: any of `uniform`, `atm-manual`, `bidask-spread`,
`bidask-spread-sma` is now legal. Uniform is the legacy alias `sabr-naive`'s
target; the others land via the registry's Cartesian product.

The wkg variants are the only ones whose cache key depends on
`calendar_rev`; the cal variants are calendar-independent (t_years comes
from `cal_yte`, which doesn't read the active calendar at all).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from backend.chain import parse_expiry, parse_strike
from backend.fit import average_iv_by_strike, fit_smile, fit_smile_frozen

from . import weights as weights_mod
from .types import FitContext, FitResult


@dataclass
class SabrNaiveCalibrator:
    """SABR with no frozen params; weights variant configurable."""
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

        # Uniform weights → fast path through the unweighted SABR fitter
        # (preserves M3.5/M3.6 byte-for-byte). Any other weight variant
        # routes through the generalized frozen-fit code which handles
        # `sigma=1/w, absolute_sigma=True`.
        if self.weights == "uniform":
            raw = fit_smile(forward, t, strikes, ivs, beta=1.0)
        else:
            w = weights_mod.compute_weights(
                self.weights,
                strikes=strikes, forward=forward, expiry=ctx.expiry,
                snapshot=snap, history_store=ctx.history_store,
            )
            raw = fit_smile_frozen(
                forward, t, strikes, ivs,
                beta=1.0, weights=w,
            )
        if raw is None:
            return None

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
            weights_used=raw.weights_used or [1.0] * len(raw.market_strikes),
            residual_rms=raw.residual_rms,
            weighted_residual_rms=raw.weighted_residual_rms or raw.residual_rms,
            frozen=raw.frozen or [],
        )
