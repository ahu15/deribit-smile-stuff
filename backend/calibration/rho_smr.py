"""ρ single-mean-reversion fitter (M3.8).

Thin adapter over the generic `_smr` kernel using the ATANH transform.
ρ ∈ (-1, 1); fit happens in atanh-space where the model is unbounded
and exponential decay is well-conditioned. Available for any preset
that wants ρ-smoothing across the term structure (not on the freeze
axis — see PLAN §M3.8 for why DMR doesn't apply to ρ directly).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from . import _smr


@dataclass
class RhoSmrFit:
    """ρ SMR result. `model_rho(τ)` evaluates the smoothed curve at arbitrary tenors."""
    rho_inf: float           # asymptotic ρ as t -> ∞
    rho_0: float             # front-end ρ at t = 0
    lambda_r: float          # mean-reversion time scale, years
    z_inf: float             # atanh(rho_inf) — exposed for diagnostics
    z_0: float               # atanh(rho_0)
    rmse: float              # rho-space residual rms
    std_errors: dict[str, float]
    fitted_rho: np.ndarray
    residuals: np.ndarray
    _smr: _smr.SmrFit

    def model_rho(self, tau: np.ndarray) -> np.ndarray:
        return self._smr.model_y(tau)


def fit_rho_smr(
    yte: np.ndarray,
    rho: np.ndarray,
    weights: np.ndarray | None = None,
) -> RhoSmrFit:
    """Fit a single mean reversion to a ρ term structure in atanh-space.

    Caller must pre-validate ρ ∈ (-1, 1) at the application boundary; this
    layer trusts inputs (it would otherwise need to choose between clipping
    and erroring per call site).
    """
    rho_arr = np.asarray(rho, dtype=float)
    if np.any(np.abs(rho_arr) >= 1.0):
        raise ValueError("All rho values must lie strictly in (-1, 1).")

    fit = _smr.fit_smr(yte, rho_arr, transform=_smr.ATANH, weights=weights)

    # Std-error keys come back as the generic SMR_PARAM_NAMES from the kernel;
    # remap to the rho-domain names callers expect.
    rho_std_errors = {
        "z_inf": fit.std_errors.get("z_inf", float("nan")),
        "z_0": fit.std_errors.get("z_0", float("nan")),
        "lambda_r": fit.std_errors.get("lambda_", float("nan")),
    }

    return RhoSmrFit(
        rho_inf=fit.y_inf,
        rho_0=fit.y_0,
        lambda_r=fit.lambda_,
        z_inf=fit.z_inf,
        z_0=fit.z_0,
        rmse=fit.rmse_y,
        std_errors=rho_std_errors,
        fitted_rho=fit.fitted_y,
        residuals=fit.residuals_y,
        _smr=fit,
    )
