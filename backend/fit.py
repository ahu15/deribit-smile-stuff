"""Per-expiry SABR fit helpers.

Wraps `sabr_greeks.SABR.SABRfit` (Hagan 2002 lognormal expansion) with
boundary handling and strike-grid sampling for the live smile chart. All
inputs/outputs use decimal vols (e.g. 0.85 = 85%).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable

import numpy as np

from sabr_greeks import SABR


def average_iv_by_strike(pairs: Iterable[tuple[float, float]]) -> tuple[list[float], list[float]]:
    """Collapse (strike, iv) pairs into ascending-strike + per-strike-mean lists.

    Deribit options are call/put pairs at the same strike whose mark IVs are
    parity-quoted, so combining them just denoises. Drops zeros / non-finite /
    None inputs the caller didn't pre-filter.
    """
    by_strike: dict[float, list[float]] = defaultdict(list)
    for k, v in pairs:
        if k is None or v is None or not np.isfinite(v) or v <= 0:
            continue
        by_strike[k].append(v)
    strikes = sorted(by_strike.keys())
    ivs = [sum(by_strike[k]) / len(by_strike[k]) for k in strikes]
    return strikes, ivs


@dataclass
class FitResult:
    alpha: float
    rho: float
    volvol: float
    beta: float
    forward: float
    t_years: float
    strikes: list[float]          # sampled strike grid for the fitted curve
    fitted_iv: list[float]        # SABR vol at each grid strike
    market_strikes: list[float]   # the strikes that actually fed the fit
    market_iv: list[float]        # market mark_iv at those strikes
    residual_rms: float


def fit_smile(
    forward: float,
    t_years: float,
    strikes: list[float],
    market_iv: list[float],
    beta: float = 1.0,
    grid_size: int = 81,
) -> FitResult | None:
    """Fit SABR to a single expiry.

    Returns None if there aren't enough usable points to fit (need ≥ 4 strikes
    with positive vol). Filters out 0 / NaN IVs that Deribit sometimes emits
    for far-OTM contracts.
    """
    if forward <= 0 or t_years <= 0 or len(strikes) != len(market_iv):
        return None

    pairs = [
        (k, v) for k, v in zip(strikes, market_iv)
        if k > 0 and v is not None and np.isfinite(v) and v > 0
    ]
    if len(pairs) < 4:
        return None

    pairs.sort(key=lambda kv: kv[0])
    k_arr = np.array([p[0] for p in pairs], dtype=float)
    v_arr = np.array([p[1] for p in pairs], dtype=float)

    try:
        alpha, rho, volvol = SABR.SABRfit(k_arr, forward, t_years, v_arr, beta=beta)
    except Exception:
        return None

    # Sample a smooth curve across the observed strike range for plotting.
    k_min = float(k_arr.min())
    k_max = float(k_arr.max())
    grid = np.linspace(k_min, k_max, grid_size)
    fitted = SABR.lognormal_vol(
        k=grid, f=forward, t=t_years,
        alpha=alpha, beta=beta, rho=rho, volvol=volvol,
    )

    # RMS residual of fit vs market on the actual quoted strikes.
    fitted_at_market = SABR.lognormal_vol(
        k=k_arr, f=forward, t=t_years,
        alpha=alpha, beta=beta, rho=rho, volvol=volvol,
    )
    residual = np.asarray(fitted_at_market) - v_arr
    rms = float(np.sqrt(np.mean(residual * residual)))

    return FitResult(
        alpha=float(alpha),
        rho=float(rho),
        volvol=float(volvol),
        beta=float(beta),
        forward=float(forward),
        t_years=float(t_years),
        strikes=[float(x) for x in grid],
        fitted_iv=[float(x) for x in np.asarray(fitted)],
        market_strikes=[float(x) for x in k_arr],
        market_iv=[float(x) for x in v_arr],
        residual_rms=rms,
    )
