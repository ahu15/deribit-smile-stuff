"""Double-mean-reversion (DMR) term-structure fit (M3.8).

Forward-variance model:

    fv(t) = v_final
          + (v0 - v_final)  * exp(-t / λ_short)     [short-tenor reversion]
          +  w0             * exp(-t / λ_long)      [long-tenor perturbation]

At t = 0, fv = v0 + w0; at t -> ∞, fv = v_final. λ_short < λ_long is enforced
by bounds construction.

Fit is two-stage: stage 1 fits a single mean reversion to the back-end (yte
≥ back_end_yte) to anchor (v_final, λ_short). Stage 2 fits the full DMR
using those estimates as a warm start. Both stages run on forward-variance
samples derived from the input vol term structure via `_fwd_var.vols_to_fwd_var`.

Negative forward variances are intentionally NOT clamped — clamping would
bias the fit. They surface via logger warnings instead.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import curve_fit, minimize

from backend.calibration import _smr
from backend.calibration.constants import TOTAL_WKG_D

from ._fwd_var import fwd_var_to_vols, vols_to_fwd_var

DMR_PARAM_NAMES = ("v_final", "v0", "w0", "lambda_short", "lambda_long")


# ---------- model + Jacobian ----------

def _dmr_fwd_var(t, v_final, v0, w0, lambda_short, lambda_long):
    return (
        v_final
        + (v0 - v_final) * np.exp(-t / lambda_short)
        + w0 * np.exp(-t / lambda_long)
    )


def _dmr_jac(t, v_final, v0, w0, lambda_short, lambda_long):
    """Analytic Jacobian. Columns match DMR_PARAM_NAMES."""
    e1 = np.exp(-t / lambda_short)
    e2 = np.exp(-t / lambda_long)
    d_vf = 1.0 - e1
    d_v0 = e1
    d_w0 = e2
    d_l1 = (v0 - v_final) * e1 * (t / lambda_short ** 2)
    d_l2 = w0 * e2 * (t / lambda_long ** 2)
    return np.column_stack([d_vf, d_v0, d_w0, d_l1, d_l2])


# ---------- bounds construction ----------

@dataclass
class _DmrBounds:
    lower: list[float]
    upper: list[float]
    p0: list[float]


def _build_bounds(
    v_fit: np.ndarray,
    y_fwd_var: np.ndarray,
    v_final_init: float,
    lambda_short_init: float,
    d: float,
) -> _DmrBounds:
    """Box constraints + warm-start vector for the DMR fit.

    `v_fit` is the user-space vol grid (used for variance-domain bounds);
    `y_fwd_var` is the forward-variance back-end the optimizer fits. λ ranges
    match the reference SABR-DMR utility's `_build_dmr_bounds` (short
    ∈ [0.1d, 20d], long ∈ [10d, 50d]); these slightly overlap but the warm
    starts (λ_short from the SMR fit, λ_long at 30d) keep the solver in the
    right basin.
    """
    vol_lo = max(v_fit.min() * 0.5, 0.01) ** 2
    vol_hi = (v_fit.max() * 2.0) ** 2
    v0_max = v_fit.max() ** 2
    w0_max = v0_max - vol_lo

    v0_init = float(np.clip(y_fwd_var[-1], vol_lo, min(vol_hi, v0_max)))
    w0_floor = vol_lo - v0_init                       # keeps v0 + w0 >= vol_lo
    w0_range = max(y_fwd_var.max() - y_fwd_var.min(), vol_lo)

    lower = [
        vol_lo,                                       # v_final
        vol_lo,                                       # v0
        max(-w0_max, w0_floor),                       # w0
        0.1 / d,                                      # λ_short
        10 / d,                                       # λ_long
    ]
    upper = [
        max(min(vol_hi, v_final_init * 1.5), vol_lo + 1e-6),
        min(vol_hi, v0_max),
        min(w0_range, w0_max),
        20 / d,
        50 / d,
    ]

    w0_init = float(np.clip(y_fwd_var[0] - v0_init, lower[2], upper[2]))
    p0_raw = [v_final_init, v0_init, w0_init, lambda_short_init, 30 / d]
    # Strict interior so the trust-region solver doesn't start on a face.
    p0 = [
        float(np.clip(val, lo + 1e-6, hi - 1e-6))
        for val, lo, hi in zip(p0_raw, lower, upper)
    ]

    return _DmrBounds(lower=lower, upper=upper, p0=p0)


def _fit_with_bounds(
    t: np.ndarray,
    y: np.ndarray,
    bounds: _DmrBounds,
    weights: np.ndarray | None,
) -> tuple[np.ndarray, np.ndarray]:
    box = (bounds.lower, bounds.upper)
    sigma_kwargs: dict = {}
    if weights is not None and not np.all(np.asarray(weights) == np.asarray(weights)[0]):
        sigma_kwargs = {
            "sigma": 1.0 / np.asarray(weights, dtype=float),
            "absolute_sigma": True,
        }

    try:
        popt, pcov = curve_fit(
            _dmr_fwd_var, t, y, p0=bounds.p0, bounds=box,
            jac=_dmr_jac, maxfev=10_000, **sigma_kwargs,
        )
        perr = np.sqrt(np.diag(pcov))
    except (RuntimeError, ValueError):
        w = np.ones_like(t) if weights is None else np.asarray(weights, dtype=float)

        def sse(p):
            return np.sum(w * (_dmr_fwd_var(t, *p) - y) ** 2)

        # Keep v0 + w0 > 0 so fv(0) stays positive.
        constraints = [{"type": "ineq", "fun": lambda p: p[1] + p[2]}]
        res = minimize(
            sse, bounds.p0, method="SLSQP",
            bounds=list(zip(box[0], box[1])),
            constraints=constraints,
        )
        popt = res.x
        perr = np.full(len(DMR_PARAM_NAMES), np.nan)

    # Floor v0 + w0 to a tiny positive value (avoids fv(0) <= 0).
    if popt[1] + popt[2] <= 0:
        popt[2] = -popt[1] + 1e-6

    return popt, perr


# ---------- diagnostics ----------

def _warn_negative_fwd_var(
    label: str, fwd_yte: np.ndarray, fwd_var: np.ndarray, d: float,
    logger: logging.Logger,
) -> None:
    neg = fwd_var < 0
    if not neg.any():
        return
    dtes = (fwd_yte[neg] * d).round(2).tolist()
    vals = fwd_var[neg].round(6).tolist()
    logger.warning("%s has %d negative entries: dte=%s val=%s", label, neg.sum(), dtes, vals)


# ---------- public API ----------

@dataclass
class DmrFit:
    """Plain-data DMR result. Methods do model evaluation."""
    v_final: float
    v0: float
    w0: float
    lambda_short: float
    lambda_long: float
    rmse: float                               # vol-space residual rms (over fit window)
    std_errors: dict[str, float]
    fitted_vols: np.ndarray                   # at the input yte (pre-mask)
    residuals: np.ndarray                     # vols - fitted_vols
    fwd_yte: np.ndarray = field(default_factory=lambda: np.array([]))
    fwd_var: np.ndarray = field(default_factory=lambda: np.array([]))

    @property
    def params(self) -> dict[str, float]:
        return {
            "v_final": self.v_final,
            "v0": self.v0,
            "w0": self.w0,
            "lambda_short": self.lambda_short,
            "lambda_long": self.lambda_long,
        }

    def fwd_var_at(self, t: np.ndarray) -> np.ndarray:
        return _dmr_fwd_var(
            np.asarray(t, dtype=float),
            self.v_final, self.v0, self.w0, self.lambda_short, self.lambda_long,
        )

    def vol_at(self, t: np.ndarray) -> np.ndarray:
        return fwd_var_to_vols(t, lambda s: self.fwd_var_at(s))

    def alpha_at(self, t: np.ndarray) -> np.ndarray:
        """SABR α at tenor t under β=1 ⇒ α = ATM lognormal vol on the curve."""
        return self.vol_at(t)


def fit_dmr(
    yte: np.ndarray,
    vols: np.ndarray,
    *,
    min_yte: float | None = None,
    back_end_yte: float | None = None,      # SMR back-end skips expiries shorter than this
    back_end_weight: float = 1.0,           # weight on errors at yte >= back_end_yte (1.0 = uniform)
    logger: logging.Logger | None = None,
) -> DmrFit:
    """Fit DMR forward-variance model to an implied-vol term structure.

    Stage 1 fits SMR to the back end (yte ≥ back_end_yte) to anchor v_final
    and λ_short. Stage 2 fits the full DMR using those estimates as a warm
    start. Defaults for `min_yte` (0.5/d) and `back_end_yte` (2/d) match the
    reference SABR-DMR utility's `_dmr_fit_kwargs("vol")`.
    """
    log = logger or logging.getLogger(__name__)

    t = np.asarray(yte, dtype=float)
    v = np.asarray(vols, dtype=float)

    if len(t) != len(v):
        raise ValueError(f"yte and vols must have the same length, got {len(t)} and {len(v)}.")
    if len(t) < 5:
        raise ValueError(f"Need at least 5 points to fit DMR, got {len(t)}.")
    if np.any(v <= 0):
        raise ValueError("All vols must be positive.")
    if np.any(np.diff(t) <= 0):
        raise ValueError("yte must be strictly increasing.")

    d = TOTAL_WKG_D
    if min_yte is None:
        min_yte = 0.5 / d
    if back_end_yte is None:
        back_end_yte = 2.0 / d

    mask = t >= min_yte
    be_mask = t >= back_end_yte
    if mask.sum() < 5:
        raise ValueError(f"Fewer than 5 points remain after applying min_yte={min_yte:.4f}.")
    if be_mask.sum() < 3:
        raise ValueError(
            f"Fewer than 3 points remain after applying back_end_yte={back_end_yte:.4f} for SMR fit."
        )

    t_fit, v_fit = t[mask], v[mask]
    t_be, v_be = t[be_mask], v[be_mask]

    fwd_yte, fwd_var = vols_to_fwd_var(t_fit, v_fit)
    fwd_yte_be, fwd_var_be = vols_to_fwd_var(t_be, v_be)
    _warn_negative_fwd_var("fwd_var", fwd_yte, fwd_var, d, log)
    _warn_negative_fwd_var("fwd_var_be", fwd_yte_be, fwd_var_be, d, log)

    # Stage 1: SMR warm start on the back end.
    smr_fit = _smr.fit_smr(fwd_yte_be, fwd_var_be, transform=_smr.IDENTITY)
    v_final_init = smr_fit.y_inf
    lambda_short_init = smr_fit.lambda_

    # Stage 2: full DMR.
    bounds = _build_bounds(v_fit, fwd_var, v_final_init, lambda_short_init, d)
    weights = np.where(fwd_yte >= back_end_yte, back_end_weight, 1.0)
    popt, perr = _fit_with_bounds(fwd_yte, fwd_var, bounds, weights=weights)

    v_final, v0, w0, lambda_short, lambda_long = (float(p) for p in popt)

    def _model_vol(tau: np.ndarray) -> np.ndarray:
        return fwd_var_to_vols(
            tau,
            lambda s: _dmr_fwd_var(s, v_final, v0, w0, lambda_short, lambda_long),
        )

    fitted_vols = _model_vol(t)
    residuals = v - fitted_vols
    rmse = float(np.sqrt(np.mean(residuals[mask] ** 2)))

    return DmrFit(
        v_final=v_final,
        v0=v0,
        w0=w0,
        lambda_short=lambda_short,
        lambda_long=lambda_long,
        rmse=rmse,
        std_errors=dict(zip(DMR_PARAM_NAMES, perr)),
        fitted_vols=fitted_vols,
        residuals=residuals,
        fwd_yte=fwd_yte,
        fwd_var=fwd_var,
    )


def scaled_dmr_curve(
    fit: DmrFit, beta_short: float, beta_long: float, t: np.ndarray,
) -> np.ndarray:
    """Scale DMR params (in fwd-variance space) and integrate to vols at `t`.

    Front-end multipliers (v0, w0) get β_short²; long-run level (v_final)
    gets β_long². λ time-scales are untouched. Useful for stress scenarios.
    """
    bs2 = beta_short ** 2
    bl2 = beta_long ** 2
    v_final = fit.v_final * bl2
    v0 = fit.v0 * bs2
    w0 = fit.w0 * bs2

    return fwd_var_to_vols(
        t,
        lambda tau: _dmr_fwd_var(tau, v_final, v0, w0, fit.lambda_short, fit.lambda_long),
    )
