"""DMR-based term-structure CurveBuilders.

Two registered builders (one per time basis):
  * ts_atm_dmr_cal — DMR on per-expiry ATM IV, cal time.
  * ts_atm_dmr_wkg — DMR on per-expiry ATM IV, wkg time.

The per-expiry ATM IV input is built by `_atm_iv_3pt_quadratic_by_expiry` —
a 3-strike log-moneyness quadratic fit `IV(K) = a + b·log(K/F) + c·log(K/F)²`
evaluated at K=F. This is purely a function of raw chain marks: no SABR fit
runs in the prior path, so the prior cannot inherit the smile fit's weight
choice (which would silently double-count the ATM region in any downstream
`alpha-from-ts` calibrator that also uses bid/ask weights).

Fallbacks: if 3 valid strikes can't be located, fall back to a 2-strike
linear interpolation in log-moneyness; skip the expiry if fewer than 2.
"""

from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass
from typing import Literal

import numpy as np

from backend.chain import expiry_ms, parse_expiry, parse_strike
from backend.vol_time import cal_yte, get_active_calendar, vol_yte

from ._fwd_var import vols_to_fwd_var
from .builder import BuildContext, CurveBuilder, TermStructureSnapshot
from .dmr import DmrFit, fit_dmr

log = logging.getLogger(__name__)


# Date offsets for the term-structure grid, in days. Front end is daily so
# wkg-fit curves plotted vs cal-time visibly show weekend kinks (a Sat day
# advances cal-time by 1 but vol-time by `sat_weight`, so fwd-variance held
# constant in wkg-time produces a flatter cal-time slope across weekends).
# Long end thins out — DMR's parametric form is smooth at long tenors so
# extra samples buy nothing past ~6m.
_GRID_DAYS_OFFSETS = (
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    21, 30, 45, 60, 90, 120, 180, 270, 365, 540, 730,
)
_MS_PER_DAY = 86_400 * 1000


def _build_grid(snap_ts_ms: int, calendar) -> tuple[list[float], list[float]]:
    """Build (t_cal_grid, t_wkg_grid) from the same underlying date offsets.

    Plotting the curve under either basis: same y-values, different x-axis.
    """
    t_cal: list[float] = []
    t_wkg: list[float] = []
    for d in _GRID_DAYS_OFFSETS:
        ex_ms = snap_ts_ms + d * _MS_PER_DAY
        t_cal.append(cal_yte(ex_ms, snap_ts_ms))
        t_wkg.append(vol_yte(ex_ms, snap_ts_ms, calendar))
    return t_cal, t_wkg


def _atm_iv_3pt_quadratic_by_expiry(snap, expiries: list[str]) -> dict[str, float]:
    """Per-expiry ATM IV via 3-strike log-moneyness quadratic.

    For each expiry, parity-collapse marks per strike, pick the 3 strikes
    nearest the forward F, fit `IV = a + b·log(K/F) + c·log(K/F)²`, and
    return `a` (= IV at K=F). This captures local skew + curvature so the
    ATF estimate isn't biased when listed strikes straddle F asymmetrically.

    Fallbacks:
      * Exactly 2 valid strikes  → linear interp in log(K/F).
      * Fewer than 2             → expiry is skipped.

    Note: the prior path is intentionally model-free (no SABR optimizer),
    so a downstream `alpha-from-ts` calibrator can apply any weight scheme
    without double-counting the ATM region.
    """
    pairs_by_expiry: dict[str, list[tuple[float, float]]] = defaultdict(list)
    forward_by_expiry: dict[str, float] = {}
    for name, mark in snap.marks.items():
        ex = parse_expiry(name)
        if ex is None or ex not in expiries:
            continue
        k = parse_strike(name)
        if k is None or mark.mark_iv <= 0 or not np.isfinite(mark.mark_iv):
            continue
        pairs_by_expiry[ex].append((k, mark.mark_iv))
        if mark.underlying_price > 0:
            forward_by_expiry[ex] = mark.underlying_price

    out: dict[str, float] = {}
    for ex, samples in pairs_by_expiry.items():
        f = forward_by_expiry.get(ex)
        if not f or f <= 0:
            continue
        # Parity-collapse: average call/put IVs at the same K.
        by_strike: dict[float, list[float]] = defaultdict(list)
        for k, iv in samples:
            by_strike[k].append(iv)
        if len(by_strike) < 2:
            continue
        # Three strikes nearest F (or two if only two are listed). Sort by
        # |K-F|, then take a stable order along the strike axis.
        nearest = sorted(by_strike.keys(), key=lambda k: abs(k - f))[:3]
        nearest.sort()
        ks = np.array(nearest, dtype=float)
        ivs = np.array(
            [sum(by_strike[k]) / len(by_strike[k]) for k in nearest], dtype=float,
        )
        x = np.log(ks / f)
        if len(nearest) >= 3 and not np.isclose(x[0], x[1]) and not np.isclose(x[1], x[2]):
            # Solve [[1, x_i, x_i²]] · [a, b, c]ᵀ = iv. lstsq handles a
            # near-degenerate Vandermonde gracefully if it slips through.
            A = np.column_stack([np.ones_like(x), x, x * x])
            coeffs, *_ = np.linalg.lstsq(A, ivs, rcond=None)
            a = float(coeffs[0])
        else:
            # Linear in log-K between the 2 closest strikes.
            x0, x1 = float(x[0]), float(x[-1])
            v0, v1 = float(ivs[0]), float(ivs[-1])
            a = v0 + (v1 - v0) * (0.0 - x0) / (x1 - x0)
        if np.isfinite(a) and a > 0:
            out[ex] = a
    return out


def _market_fwd_var(
    time_basis: Literal["cal", "wkg"],
    market_t_cal: list[float],
    market_t_wkg: list[float],
    market_atm: list[float],
) -> tuple[list[float], list[float], list[float]]:
    """Per-pair empirical forward variance + midpoint anchors in both bases.

    Mirrors `vols_to_fwd_var` so the chart's "market dots" in fwd-var view
    sit on the same midpoint convention the DMR fit consumed. For wkg-fit
    curves, returns midpoints in BOTH bases so the chart can plot in either
    x-axis without recomputing.
    """
    if not market_atm:
        return [], [], []
    t_fit = np.array(
        market_t_wkg if time_basis == "wkg" else market_t_cal, dtype=float,
    )
    t_c = np.array(market_t_cal, dtype=float)
    t_w = np.array(market_t_wkg, dtype=float)
    v = np.array(market_atm, dtype=float)
    idx = np.argsort(t_fit)
    t_fit = t_fit[idx]; t_c = t_c[idx]; t_w = t_w[idx]; v = v[idx]
    _, fv = vols_to_fwd_var(t_fit, v)
    mid_c = np.empty_like(t_c)
    mid_w = np.empty_like(t_w)
    mid_c[0] = t_c[0] / 2
    mid_w[0] = t_w[0] / 2
    mid_c[1:] = (t_c[:-1] + t_c[1:]) / 2
    mid_w[1:] = (t_w[:-1] + t_w[1:]) / 2
    return (
        [float(x) for x in fv],
        [float(x) for x in mid_c],
        [float(x) for x in mid_w],
    )


def _stamp_snapshot(
    method: str,
    currency: str,
    time_basis: Literal["cal", "wkg"],
    fit: DmrFit,
    snap_ts_ms: int,
    calendar,
    calendar_rev: str,
    market_t_cal: list[float],
    market_t_wkg: list[float],
    market_atm: list[float],
    market_expiries: list[str],
) -> TermStructureSnapshot:
    """Sample the DMR curve at the standard grid in both bases."""
    t_cal_grid, t_wkg_grid = _build_grid(snap_ts_ms, calendar)
    fit_grid = t_cal_grid if time_basis == "cal" else t_wkg_grid
    fit_grid_arr = np.array(fit_grid, dtype=float)
    atm_vol = fit.vol_at(fit_grid_arr)
    fwd_var = fit.fwd_var_at(fit_grid_arr)
    fv_market, fv_t_cal, fv_t_wkg = _market_fwd_var(
        time_basis, market_t_cal, market_t_wkg, market_atm,
    )
    return TermStructureSnapshot(
        method=method,
        currency=currency,
        time_basis=time_basis,
        t_years_cal_grid=t_cal_grid,
        t_years_wkg_grid=t_wkg_grid,
        atm_vol_grid=[float(v) for v in atm_vol],
        alpha_grid=[float(v) for v in atm_vol],   # β=1 ⇒ α ≈ ATM lognormal vol
        fwd_var_grid=[float(v) for v in fwd_var],
        params=dict(fit.params),
        rmse=fit.rmse,
        calendar_rev=calendar_rev,
        market_t_cal=market_t_cal,
        market_t_wkg=market_t_wkg,
        market_atm_vol=market_atm,
        market_expiries=market_expiries,
        market_fwd_var=fv_market,
        market_fwd_var_t_cal=fv_t_cal,
        market_fwd_var_t_wkg=fv_t_wkg,
    )


# ---------- ATM IV source (3-pt quadratic in log-K, prior is model-free) ----------

@dataclass
class TsAtmDmrBuilder:
    """DMR fit on per-expiry ATM IV (3-strike log-K quadratic at F)."""
    method: str
    time_basis: Literal["cal", "wkg"]
    family: str = "dmr"
    source: str = "atm_iv"
    requires: tuple[str, ...] = ()
    label: str = ""

    def build(self, ctx: BuildContext) -> TermStructureSnapshot | None:
        snap = ctx.snapshot
        expiries = sorted(
            set(ctx.t_years_cal_by_expiry.keys()),
            key=lambda e: expiry_ms(e) or 0,
        )
        atm_by_expiry = _atm_iv_3pt_quadratic_by_expiry(snap, expiries)
        return _build_dmr_snapshot(
            self, ctx, list(atm_by_expiry.items()), get_active_calendar(),
        )


# ---------- shared fit + stamp ----------

def _build_dmr_snapshot(
    builder: CurveBuilder, ctx: BuildContext,
    per_expiry: list[tuple[str, float]], calendar,
) -> TermStructureSnapshot | None:
    if len(per_expiry) < 5:
        log.debug(
            "%s/%s: need ≥5 expiries to fit DMR, got %d",
            ctx.currency, builder.method, len(per_expiry),
        )
        return None

    t_by_expiry = (
        ctx.t_years_wkg_by_expiry if builder.time_basis == "wkg"
        else ctx.t_years_cal_by_expiry
    )
    points: list[tuple[float, float, float, float, str]] = []  # (t_fit, atm, t_cal, t_wkg, ex)
    for ex, atm in per_expiry:
        t_cal = ctx.t_years_cal_by_expiry.get(ex)
        t_wkg = ctx.t_years_wkg_by_expiry.get(ex)
        if t_cal is None or t_wkg is None:
            continue
        t_fit = t_by_expiry.get(ex)
        if t_fit is None or t_fit <= 0:
            continue
        points.append((t_fit, atm, t_cal, t_wkg, ex))
    if len(points) < 5:
        return None
    points.sort(key=lambda p: p[0])
    # De-dupe identical t_fit values (different expiries with the same wkg
    # mapping under a degenerate calendar shouldn't break the fit).
    deduped: list[tuple[float, float, float, float, str]] = []
    for p in points:
        if deduped and p[0] <= deduped[-1][0]:
            continue
        deduped.append(p)
    if len(deduped) < 5:
        return None

    t_arr = np.array([p[0] for p in deduped], dtype=float)
    v_arr = np.array([p[1] for p in deduped], dtype=float)
    try:
        fit = fit_dmr(t_arr, v_arr, logger=log)
    except ValueError as exc:
        log.debug("%s/%s: fit_dmr rejected: %s", ctx.currency, builder.method, exc)
        return None

    return _stamp_snapshot(
        method=builder.method,
        currency=ctx.currency,
        time_basis=builder.time_basis,
        fit=fit,
        snap_ts_ms=ctx.snapshot.timestamp_ms,
        calendar=calendar,
        calendar_rev=ctx.calendar_rev,
        market_t_cal=[p[2] for p in deduped],
        market_t_wkg=[p[3] for p in deduped],
        market_atm=[p[1] for p in deduped],
        market_expiries=[p[4] for p in deduped],
    )


