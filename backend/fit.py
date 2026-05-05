"""Per-expiry SABR fit math.

Wraps `sabr_greeks.SABR.SABRfit` (Hagan 2002 lognormal expansion) and
returns the raw parameter bag + sampled grid + market residual. The
methodology-engine `FitResult` (tagged union with calendar_rev,
t_years_cal/wkg, frozen params, weighted residuals etc.) lives in
`backend.calibration.types` and is stamped by the calibrator on top of
this raw result. All inputs/outputs use decimal vols (e.g. 0.85 = 85%).

`fit_smile_frozen` (M3.8) generalizes the standard fit by allowing any
subset of (alpha, rho, volvol) to be pinned externally — used by the
`alpha-from-ts` freeze-axis calibrator (`sabr_alpha_frozen`) and any
weighted-fit variant of `freeze=none` (`sabr_naive` non-uniform weights).
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable

import numpy as np
from scipy.optimize import curve_fit

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
class SabrFit:
    """Raw SABR fit (math layer) — calibrator wraps in a `FitResult`.

    `frozen` is a list of `{param, value, source}` dicts populated by
    `fit_smile_frozen` when any subset of (alpha, rho, volvol) is pinned;
    the standard `fit_smile` returns an empty list. `weights` carries the
    per-strike residual weights actually used (1.0s under uniform).
    """
    alpha: float
    rho: float
    volvol: float
    beta: float
    forward: float
    t_years: float
    strikes: list[float]
    fitted_iv: list[float]
    market_strikes: list[float]
    market_iv: list[float]
    residual_rms: float
    weighted_residual_rms: float = 0.0
    weights_used: list[float] | None = None
    frozen: list[dict] | None = None


def fit_smile(
    forward: float,
    t_years: float,
    strikes: list[float],
    market_iv: list[float],
    beta: float = 1.0,
    grid_size: int = 81,
) -> SabrFit | None:
    """Fit SABR to a single expiry. Returns the raw parameter bag + grid +
    residual; the calibrator stamps M3.7 metadata (methodology, calendar_rev,
    t_years_{cal,wkg}, weights, frozen) on top.

    Returns None if there aren't enough usable points (need ≥ 4 strikes with
    positive vol). Filters out 0 / NaN IVs that Deribit sometimes emits for
    far-OTM contracts.
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

    k_min = float(k_arr.min())
    k_max = float(k_arr.max())
    grid = np.linspace(k_min, k_max, grid_size)
    fitted = SABR.lognormal_vol(
        k=grid, f=forward, t=t_years,
        alpha=alpha, beta=beta, rho=rho, volvol=volvol,
    )

    fitted_at_market = SABR.lognormal_vol(
        k=k_arr, f=forward, t=t_years,
        alpha=alpha, beta=beta, rho=rho, volvol=volvol,
    )
    residual = np.asarray(fitted_at_market) - v_arr
    rms = float(np.sqrt(np.mean(residual * residual)))

    return SabrFit(
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
        weighted_residual_rms=rms,                # uniform → equal
        weights_used=[1.0] * len(k_arr),
        frozen=[],
    )


# ---------- frozen-param fit (M3.8) ----------

# Default optimizer bounds + warm start, matching `sabr_greeks.SABRfit`'s
# defaults. Splitting them out lets the frozen-fit code skip frozen params'
# slots cleanly.
_FREE_PARAM_BOUNDS = {
    "alpha":  (0.3, 2.0),
    "rho":    (-1.0, 1.0),
    "volvol": (1.0, 10.0),
}
_FREE_PARAM_P0 = {"alpha": 0.75, "rho": -0.1, "volvol": 2.5}


def fit_smile_frozen(
    forward: float,
    t_years: float,
    strikes: list[float],
    market_iv: list[float],
    *,
    beta: float = 1.0,
    alpha: float | None = None,
    rho: float | None = None,
    volvol: float | None = None,
    weights: list[float] | None = None,
    grid_size: int = 81,
) -> SabrFit | None:
    """SABR fit with any subset of (alpha, rho, volvol) pinned externally.

    `alpha` / `rho` / `volvol` arguments: `None` = optimize freely, value =
    pin to that value (excluded from the fit). `weights` is per-strike
    residual weighting (`sigma = 1/w`, `absolute_sigma=True`); `None` =
    uniform. Returns the same `SabrFit` shape as `fit_smile`, with `frozen`
    listing every pinned param and `weights_used` echoing the input.
    """
    if forward <= 0 or t_years <= 0 or len(strikes) != len(market_iv):
        return None

    triples = list(zip(strikes, market_iv, weights or [1.0] * len(strikes)))
    triples = [
        (k, v, w) for k, v, w in triples
        if k > 0 and v is not None and np.isfinite(v) and v > 0
        and w is not None and np.isfinite(w) and w > 0
    ]
    if len(triples) < 2:
        return None
    triples.sort(key=lambda kvw: kvw[0])
    k_arr = np.array([t[0] for t in triples], dtype=float)
    v_arr = np.array([t[1] for t in triples], dtype=float)
    w_arr = np.array([t[2] for t in triples], dtype=float)

    pinned: dict[str, float] = {}
    if alpha is not None:
        pinned["alpha"] = float(alpha)
    if rho is not None:
        pinned["rho"] = float(rho)
    if volvol is not None:
        pinned["volvol"] = float(volvol)

    free = [p for p in ("alpha", "rho", "volvol") if p not in pinned]
    if not free:
        # All three frozen → no fit, just evaluate. The "fit" residual is
        # against the pinned vol curve.
        a = pinned["alpha"]
        r = pinned["rho"]
        nu = pinned["volvol"]
    elif len(triples) < len(free) + 1:
        # Need at least #free + 1 strikes for the optimizer to be well-posed.
        return None
    else:
        def _vol(k_query, *fp):
            params = dict(pinned)
            for name, val in zip(free, fp):
                params[name] = val
            return SABR.lognormal_vol(
                k=k_query, f=forward, t=t_years,
                alpha=params["alpha"], beta=beta,
                rho=params["rho"], volvol=params["volvol"],
            )

        p0 = [_FREE_PARAM_P0[p] for p in free]
        lower = [_FREE_PARAM_BOUNDS[p][0] for p in free]
        upper = [_FREE_PARAM_BOUNDS[p][1] for p in free]

        sigma_kwargs: dict = {}
        if weights is not None and not np.all(w_arr == w_arr[0]):
            sigma_kwargs = {"sigma": 1.0 / w_arr, "absolute_sigma": True}

        try:
            popt, _ = curve_fit(
                _vol, k_arr, v_arr, p0=p0,
                bounds=(lower, upper), maxfev=10_000,
                **sigma_kwargs,
            )
        except (RuntimeError, ValueError):
            return None

        params_full = dict(pinned)
        for name, val in zip(free, popt):
            params_full[name] = float(val)
        a = params_full["alpha"]
        r = params_full["rho"]
        nu = params_full["volvol"]

    grid = np.linspace(float(k_arr.min()), float(k_arr.max()), grid_size)
    fitted = SABR.lognormal_vol(
        k=grid, f=forward, t=t_years,
        alpha=a, beta=beta, rho=r, volvol=nu,
    )
    fitted_at_market = SABR.lognormal_vol(
        k=k_arr, f=forward, t=t_years,
        alpha=a, beta=beta, rho=r, volvol=nu,
    )
    residual = np.asarray(fitted_at_market) - v_arr
    rms = float(np.sqrt(np.mean(residual * residual)))
    weighted_rms = float(np.sqrt(np.average(residual * residual, weights=w_arr)))

    frozen_list = [
        {"param": name, "value": float(val), "source": "ts"}
        for name, val in pinned.items()
    ]

    return SabrFit(
        alpha=float(a),
        rho=float(r),
        volvol=float(nu),
        beta=float(beta),
        forward=float(forward),
        t_years=float(t_years),
        strikes=[float(x) for x in grid],
        fitted_iv=[float(x) for x in np.asarray(fitted)],
        market_strikes=[float(x) for x in k_arr],
        market_iv=[float(x) for x in v_arr],
        residual_rms=rms,
        weighted_residual_rms=weighted_rms,
        weights_used=[float(x) for x in w_arr],
        frozen=frozen_list,
    )
