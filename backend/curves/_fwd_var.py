"""Forward-variance ↔ implied-vol conversions (M3.8).

Lifted out of the DMR module because they're not DMR-specific — any future
term-structure parameterization (variance-swap etc., deferred to
BUGS_AND_IMPROVEMENTS) reuses them. Module-private (underscore prefix);
external callers should go through the curve builders rather than the
raw conversions.

Total variance:    w(t) = vol(t)^2 * t
Forward variance:  fv_i = (w_i - w_{i-1}) / (t_i - t_{i-1})    for i >= 1
                   fv_0 =  w_0 / t_0
Midpoint anchors:  tm_0 = t_0 / 2,  tm_i = (t_{i-1} + t_i) / 2
"""

from __future__ import annotations

from typing import Callable

import numpy as np


def vols_to_fwd_var(
    yte: np.ndarray, vols: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Convert (yte, vols) to forward-variance pairs anchored at midpoints.

    Inputs need not be sorted; output is sorted ascending in yte.
    """
    idx = np.argsort(yte)
    t = np.asarray(yte, dtype=float)[idx]
    w = (np.asarray(vols, dtype=float)[idx] ** 2) * t

    fwd_var = np.empty_like(t)
    fwd_var[0] = w[0] / t[0]
    fwd_var[1:] = np.diff(w) / np.diff(t)

    fwd_yte = np.empty_like(t)
    fwd_yte[0] = t[0] / 2
    fwd_yte[1:] = (t[:-1] + t[1:]) / 2

    return fwd_yte, fwd_var


def fwd_var_to_vols(
    yte: np.ndarray,
    model_fn: Callable[[np.ndarray], np.ndarray],
) -> np.ndarray:
    """Integrate a forward-variance model into implied vols at the requested tenors.

    Total variance is built by integrating fwd-var over [0, t_i] using the
    midpoint-rule weights that match `vols_to_fwd_var` (so the round trip is
    exact at the original grid).
    """
    yte = np.asarray(yte, dtype=float)
    t_sorted = np.sort(yte)

    # Midpoints for evaluating the model on each [t_{i-1}, t_i] strip
    # (with t_{-1} = 0, so the first midpoint is t_0 / 2).
    t_mid = np.empty_like(t_sorted)
    t_mid[0] = t_sorted[0] / 2
    t_mid[1:] = (t_sorted[:-1] + t_sorted[1:]) / 2

    dt = np.diff(t_sorted, prepend=0.0)
    total_var = np.cumsum(model_fn(t_mid) * dt)
    vols_sorted = np.sqrt(np.maximum(total_var, 0.0) / t_sorted)

    return np.interp(yte, t_sorted, vols_sorted)
