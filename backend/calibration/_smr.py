"""Single-mean-reversion kernel (M3.8).

`fit_smr` is the one-and-only SMR fitter; the original three near-duplicate
fitters (forward-variance, ρ atanh-space, ν positive-bound) collapse into one
parameterized code path keyed on a `Transform` describing how to (a) move
input data into z-space, (b) move fitted z back to original space, (c) build
bounds for z and warm-start the optimizer.

Model in z-space:  z(t) = z_inf + (z_0 - z_inf) * exp(-t / λ)
Same shape for all transforms — only the mapping in/out and bounds change.

Three transforms ship with this module:
  * IDENTITY — z = y. For forward-variance back-end fits (DMR stage 1).
  * ATANH    — z = atanh(y), y in (-1, 1). For ρ.
  * LOG      — z = log(y), y > 0.            For ν (volvol).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
from scipy.optimize import curve_fit, minimize

SMR_PARAM_NAMES = ("z_inf", "z_0", "lambda_")


def _smr_model(t, z_inf, z_0, lambda_):
    return z_inf + (z_0 - z_inf) * np.exp(-t / lambda_)


def _smr_jac(t, z_inf, z_0, lambda_):
    """Analytic Jacobian. Columns match SMR_PARAM_NAMES."""
    e = np.exp(-t / lambda_)
    d_zinf = 1.0 - e
    d_z0 = e
    d_lam = (z_0 - z_inf) * e * (t / lambda_ ** 2)
    return np.column_stack([d_zinf, d_z0, d_lam])


# ---------- transforms ----------

@dataclass(frozen=True)
class Transform:
    """How to move user-space y into / out of z-space + how to bound z.

    `forward(y) -> z` maps the user's data into the SMR fit space; any
    domain-restriction clipping (atanh's |y| < 1) lives inside the
    transform's own `forward`. `inverse(z) -> y` maps fitted z back.
    `z_floor` / `z_ceil` are the optimizer's hard z-bounds.
    """
    name: str
    forward: Callable[[np.ndarray], np.ndarray]
    inverse: Callable[[np.ndarray], np.ndarray]
    z_floor: float
    z_ceil: float


def _identity_forward(y: np.ndarray) -> np.ndarray:
    return np.asarray(y, dtype=float)


def _identity_inverse(z: np.ndarray) -> np.ndarray:
    return np.asarray(z, dtype=float)


IDENTITY = Transform(
    name="identity",
    forward=_identity_forward,
    inverse=_identity_inverse,
    z_floor=-np.inf,
    z_ceil=np.inf,
)

# Atanh transform clips just inside ±1 so atanh stays finite if the user
# passes ρ samples right at the boundary.
_ATANH_CLIP = 1.0 - 1e-6


def _atanh_clip_y(y: np.ndarray) -> np.ndarray:
    return np.clip(np.asarray(y, dtype=float), -_ATANH_CLIP, _ATANH_CLIP)


def _atanh_forward(y: np.ndarray) -> np.ndarray:
    return np.arctanh(_atanh_clip_y(y))


def _atanh_inverse(z: np.ndarray) -> np.ndarray:
    return np.tanh(np.asarray(z, dtype=float))


ATANH = Transform(
    name="atanh",
    forward=_atanh_forward,
    inverse=_atanh_inverse,
    # |ρ| < ~0.95 ⇒ |z| < ~1.8 in practice. Generous box for the optimizer.
    z_floor=-3.0,
    z_ceil=3.0,
)


def _log_forward(y: np.ndarray) -> np.ndarray:
    arr = np.asarray(y, dtype=float)
    if np.any(arr <= 0):
        raise ValueError("LOG transform requires strictly positive inputs.")
    return np.log(arr)


def _log_inverse(z: np.ndarray) -> np.ndarray:
    return np.exp(np.asarray(z, dtype=float))


LOG = Transform(
    name="log",
    forward=_log_forward,
    inverse=_log_inverse,
    # ν typically lives in [0.1, 5]; log puts that in [-2.3, 1.6]. Leave room.
    z_floor=-6.0,
    z_ceil=6.0,
)


# ---------- public fit kernel ----------

@dataclass
class SmrFit:
    """Plain-data SMR fit result.

    z-space params: `z_inf`, `z_0`, `lambda_`. User-space readouts:
    `y_inf`, `y_0` (back-converted via the transform's `inverse`). λ is
    identical in both since the time scale doesn't transform.
    """
    transform: str
    z_inf: float
    z_0: float
    lambda_: float
    y_inf: float
    y_0: float
    rmse: float                                  # in z-space
    rmse_y: float                                # in user-space (after inverse)
    std_errors: dict[str, float]
    fitted_y: np.ndarray
    residuals_y: np.ndarray

    def model_y(self, tau: np.ndarray) -> np.ndarray:
        """Evaluate the smoothed user-space curve at arbitrary tenors."""
        z = _smr_model(np.asarray(tau, dtype=float), self.z_inf, self.z_0, self.lambda_)
        return _inverse_for(self.transform)(z)


def _inverse_for(name: str) -> Callable[[np.ndarray], np.ndarray]:
    if name == IDENTITY.name:
        return IDENTITY.inverse
    if name == ATANH.name:
        return ATANH.inverse
    if name == LOG.name:
        return LOG.inverse
    raise ValueError(f"unknown transform: {name}")


def fit_smr(
    yte: np.ndarray,
    y: np.ndarray,
    *,
    transform: Transform,
    weights: np.ndarray | None = None,
) -> SmrFit:
    """Fit `y(t) = inv(z_inf + (z_0 - z_inf) * exp(-t/λ))` under `transform`.

    Parameters
    ----------
    yte       : strictly increasing tenors.
    y         : observations in user-space.
    transform : IDENTITY | ATANH | LOG.
    weights   : optional per-point weights; uniform if None.

    Returns
    -------
    SmrFit. Optimization-failure path falls back to L-BFGS-B and reports
    `std_errors` filled with NaN; otherwise std errors come from the
    covariance returned by `curve_fit`.
    """
    t = np.asarray(yte, dtype=float)
    y_arr = np.asarray(y, dtype=float)

    if len(t) != len(y_arr):
        raise ValueError(f"yte and y must have the same length, got {len(t)} and {len(y_arr)}.")
    if len(t) < 3:
        raise ValueError(f"Need at least 3 points to fit SMR, got {len(t)}.")
    if np.any(np.diff(t) <= 0):
        raise ValueError("yte must be strictly increasing.")

    z = transform.forward(y_arr)

    z_lo, z_hi = transform.z_floor, transform.z_ceil
    lam_lo, lam_hi = t[0] / 4, t[-1] * 4

    p0_raw = [z[-1], z[0], t[-1] / 2]   # back-end -> z_inf, front-end -> z_0
    lower = [z_lo, z_lo, lam_lo]
    upper = [z_hi, z_hi, lam_hi]
    p0 = [
        float(np.clip(v, lo + 1e-6, hi - 1e-6))
        for v, lo, hi in zip(p0_raw, lower, upper)
    ]

    sigma_kwargs: dict = {}
    if weights is not None and not np.all(np.asarray(weights) == np.asarray(weights)[0]):
        sigma_kwargs = {
            "sigma": 1.0 / np.asarray(weights, dtype=float),
            "absolute_sigma": True,
        }

    try:
        popt, pcov = curve_fit(
            _smr_model, t, z, p0=p0,
            bounds=(lower, upper), jac=_smr_jac,
            maxfev=10_000, **sigma_kwargs,
        )
        perr = np.sqrt(np.diag(pcov))
    except (RuntimeError, ValueError):
        w = np.ones_like(t) if weights is None else np.asarray(weights, dtype=float)

        def sse(p):
            return np.sum(w * (_smr_model(t, *p) - z) ** 2)

        res = minimize(
            sse, p0, method="L-BFGS-B",
            bounds=list(zip(lower, upper)),
        )
        popt = res.x
        perr = np.full(len(SMR_PARAM_NAMES), np.nan)

    z_inf, z_0, lam = (float(p) for p in popt)
    fitted_z = _smr_model(t, z_inf, z_0, lam)
    fitted_y = transform.inverse(fitted_z)
    residuals_y = y_arr - fitted_y
    rmse_z = float(np.sqrt(np.mean((fitted_z - z) ** 2)))
    rmse_y = float(np.sqrt(np.mean(residuals_y ** 2)))

    return SmrFit(
        transform=transform.name,
        z_inf=z_inf,
        z_0=z_0,
        lambda_=lam,
        y_inf=float(transform.inverse(np.array([z_inf]))[0]),
        y_0=float(transform.inverse(np.array([z_0]))[0]),
        rmse=rmse_z,
        rmse_y=rmse_y,
        std_errors=dict(zip(SMR_PARAM_NAMES, perr)),
        fitted_y=fitted_y,
        residuals_y=residuals_y,
    )
