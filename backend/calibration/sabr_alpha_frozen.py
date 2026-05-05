"""SABR with α pinned from a term-structure curve (M3.8).

Freeze axis: `alpha-from-ts`. Reads the per-expiry α from
`ctx.ts_snapshot.alpha_grid` interpolated at the leg's t_years (in the
preset's basis), then runs `fit_smile_frozen` with α fixed and (ρ, ν) free.

Weights axis is data-driven: passed in at factory time, computed per
chain poll via `backend.calibration.weights.compute_weights`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

from backend.chain import ChainSnapshot, parse_expiry, parse_strike
from backend.fit import average_iv_by_strike, fit_smile_frozen

from . import weights as weights_mod
from .types import FitContext, FitResult


def _interp_grid(t_years_grid: list[float], y_grid: list[float], t: float) -> float | None:
    """Linear interpolation of `y_grid(t_years_grid)` at `t`. None if degenerate."""
    if not t_years_grid or len(t_years_grid) != len(y_grid):
        return None
    arr_t = np.array(t_years_grid, dtype=float)
    arr_y = np.array(y_grid, dtype=float)
    if t <= arr_t[0]:
        return float(arr_y[0])
    if t >= arr_t[-1]:
        return float(arr_y[-1])
    return float(np.interp(t, arr_t, arr_y))


def _collect_expiry_quotes(
    snapshot: ChainSnapshot, expiry: str,
) -> tuple[float, list[float], list[float]]:
    """Walk the snapshot for one expiry's (forward, strikes, mark_ivs).

    Returns parity-collapsed (strikes, ivs) — same convention as
    `average_iv_by_strike`. `forward` is the per-expiry option-implied
    forward (`mark.underlying_price`) — uniform across all options at
    the same expiry on Deribit, so we take the first valid one.
    """
    forward = 0.0
    pairs: list[tuple[float, float]] = []
    for name, mark in snapshot.marks.items():
        if parse_expiry(name) != expiry:
            continue
        k = parse_strike(name)
        if k is None:
            continue
        pairs.append((k, mark.mark_iv))
        if forward <= 0 and mark.underlying_price > 0:
            forward = mark.underlying_price
    strikes, ivs = average_iv_by_strike(pairs)
    return forward, strikes, ivs


@dataclass
class SabrAlphaFrozenCalibrator:
    """SABR with α pinned from `ctx.ts_snapshot`, ρ/ν free."""
    methodology: str
    family: str
    freeze: str                                    # "alpha-from-ts"
    weights: str                                   # "uniform"|"atm-manual"|"bidask-spread"|"bidask-spread-sma"
    time_basis: Literal["cal", "wkg"]
    requires_ts: bool
    label: str

    def fit(self, ctx: FitContext) -> FitResult | None:
        ts = ctx.ts_snapshot
        if ts is None:
            return None
        forward, strikes, ivs = _collect_expiry_quotes(ctx.snapshot, ctx.expiry)
        if forward <= 0 or not strikes:
            return None

        t = ctx.t_years_wkg if self.time_basis == "wkg" else ctx.t_years_cal
        if t <= 0:
            return None

        # α prior is sampled in the CURVE's basis (`alpha_grid[i]` is the
        # DMR model evaluated at `ts.t_years_<basis>_grid[i]`), so the
        # lookup must use that same basis. Using `self.time_basis` here
        # would pair `alpha_grid` values with the wrong x-grid whenever
        # the calibrator basis differs from the curve's basis.
        ts_basis = ts.time_basis
        ts_t_grid = (
            ts.t_years_wkg_grid if ts_basis == "wkg"
            else ts.t_years_cal_grid
        )
        t_for_prior = ctx.t_years_wkg if ts_basis == "wkg" else ctx.t_years_cal
        alpha = _interp_grid(ts_t_grid, ts.alpha_grid, t_for_prior)
        if alpha is None or not np.isfinite(alpha) or alpha <= 0:
            return None

        w = weights_mod.compute_weights(
            self.weights,
            strikes=strikes, forward=forward, expiry=ctx.expiry,
            snapshot=ctx.snapshot, history_store=ctx.history_store,
        )

        raw = fit_smile_frozen(
            forward, t, strikes, ivs,
            beta=1.0, alpha=alpha, weights=w,
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
            weighted_residual_rms=raw.weighted_residual_rms,
            frozen=raw.frozen or [],
        )
