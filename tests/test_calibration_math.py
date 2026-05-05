"""Round-trip tests for the M3.8 math ports."""

from __future__ import annotations

import numpy as np
import pytest

from backend.calibration import _smr
from backend.calibration.rho_smr import fit_rho_smr
from backend.curves._fwd_var import fwd_var_to_vols, vols_to_fwd_var
from backend.curves.dmr import fit_dmr


# ---------- _smr kernel ----------

def test_smr_identity_recovers_known_params():
    yte = np.array([0.05, 0.1, 0.25, 0.5, 1.0, 2.0])
    z_inf, z_0, lam = 0.04, 0.09, 0.6
    y = z_inf + (z_0 - z_inf) * np.exp(-yte / lam)
    fit = _smr.fit_smr(yte, y, transform=_smr.IDENTITY)
    assert abs(fit.y_inf - z_inf) < 1e-3
    assert abs(fit.y_0 - z_0) < 1e-3
    assert abs(fit.lambda_ - lam) < 5e-2


def test_smr_atanh_recovers_rho_term_structure():
    yte = np.array([0.05, 0.1, 0.25, 0.5, 1.0, 2.0])
    rho_inf, rho_0, lam = -0.3, -0.7, 0.5
    z_inf, z_0 = np.arctanh(rho_inf), np.arctanh(rho_0)
    rho = np.tanh(z_inf + (z_0 - z_inf) * np.exp(-yte / lam))
    fit = _smr.fit_smr(yte, rho, transform=_smr.ATANH)
    assert abs(fit.y_inf - rho_inf) < 5e-3
    assert abs(fit.y_0 - rho_0) < 5e-3
    assert abs(fit.lambda_ - lam) < 5e-2


def test_smr_log_recovers_positive_parameter():
    yte = np.array([0.05, 0.1, 0.25, 0.5, 1.0, 2.0])
    nu_inf, nu_0, lam = 1.2, 2.5, 0.4
    log_inf, log_0 = np.log(nu_inf), np.log(nu_0)
    nu = np.exp(log_inf + (log_0 - log_inf) * np.exp(-yte / lam))
    fit = _smr.fit_smr(yte, nu, transform=_smr.LOG)
    assert abs(fit.y_inf - nu_inf) < 5e-3
    assert abs(fit.y_0 - nu_0) < 5e-3
    assert abs(fit.lambda_ - lam) < 5e-2


def test_smr_log_rejects_nonpositive_input():
    yte = np.array([0.05, 0.1, 0.25])
    with pytest.raises(ValueError):
        _smr.fit_smr(yte, np.array([1.0, 2.0, -0.5]), transform=_smr.LOG)


def test_smr_requires_strictly_increasing_tenors():
    with pytest.raises(ValueError):
        _smr.fit_smr(
            np.array([0.1, 0.1, 0.5]), np.array([0.1, 0.2, 0.3]),
            transform=_smr.IDENTITY,
        )


def test_smr_minimum_three_points():
    with pytest.raises(ValueError):
        _smr.fit_smr(
            np.array([0.1, 0.5]), np.array([0.1, 0.2]),
            transform=_smr.IDENTITY,
        )


# ---------- fwd-var round trips ----------

def test_fwd_var_roundtrip_recovers_vols_on_grid():
    """vols_to_fwd_var ∘ fwd_var_to_vols is exact at the original grid."""
    yte = np.array([0.05, 0.1, 0.25, 0.5, 1.0, 2.0])
    vols = np.array([0.85, 0.78, 0.72, 0.68, 0.65, 0.62])
    fwd_yte, fwd_var = vols_to_fwd_var(yte, vols)

    # Build a piecewise-constant fwd-variance model that the integrator
    # reads back exactly when sampled at the same grid.
    def _model(t_query: np.ndarray) -> np.ndarray:
        return np.interp(t_query, fwd_yte, fwd_var)

    recovered = fwd_var_to_vols(yte, _model)
    np.testing.assert_allclose(recovered, vols, atol=1e-10)


def test_fwd_var_handles_unsorted_input():
    yte = np.array([0.5, 0.05, 1.0, 0.25])
    vols = np.array([0.68, 0.85, 0.65, 0.72])
    fwd_yte, fwd_var = vols_to_fwd_var(yte, vols)
    # Output is sorted by tenor.
    assert np.all(np.diff(fwd_yte) > 0)
    assert len(fwd_var) == len(yte)


# ---------- DMR ----------

def _synth_dmr_vols(yte: np.ndarray, params: dict[str, float]) -> np.ndarray:
    """Generate vols from known DMR params via the round-trip pipeline."""
    def _model(t):
        return (
            params["v_final"]
            + (params["v0"] - params["v_final"]) * np.exp(-t / params["lambda_short"])
            + params["w0"] * np.exp(-t / params["lambda_long"])
        )
    return fwd_var_to_vols(yte, _model)


def test_dmr_recovers_known_parameters():
    """End-to-end recovery: synthesize vols from known DMR, refit, compare.

    Params are chosen inside the DMR bounds (λ_short ≤ 20 wkg-d, λ_long ≤
    50 wkg-d) — the optimizer is tuned for short-term reversion dynamics
    typical of crypto vol surfaces, not multi-year tradfi reversion.
    """
    true_params = {
        "v_final": 0.45 ** 2,
        "v0": 0.85 ** 2,
        "w0": 0.10 ** 2,
        "lambda_short": 0.04,                  # ~10 wkg-d
        "lambda_long": 0.16,                   # ~40 wkg-d
    }
    # Crypto-ish term structure: 1d → 2y. Strictly increasing, decent density.
    yte = np.array([
        1 / 365, 7 / 365, 14 / 365, 1 / 12, 2 / 12, 3 / 12, 6 / 12, 1.0, 1.5, 2.0,
    ])
    vols = _synth_dmr_vols(yte, true_params)

    fit = fit_dmr(yte, vols)

    # Structural recovery: λ_short < λ_long and v_final hits the asymptote.
    # Per-parameter recovery of (w0, λ_long) is intentionally loose because
    # multiple (w0, λ_long) pairs can reproduce nearly identical vol curves
    # when w0 is small. The reconstructed-curve assertion below is the
    # meaningful test of fit quality.
    assert abs(fit.v_final - true_params["v_final"]) / true_params["v_final"] < 0.10
    assert fit.lambda_short < fit.lambda_long
    assert abs(fit.lambda_short - true_params["lambda_short"]) < 0.02

    # Reconstructed vol curve is close at all tenors — the actual quality bar.
    reconstructed = fit.vol_at(yte)
    np.testing.assert_allclose(reconstructed, vols, atol=5e-3)


def test_dmr_rejects_too_few_points():
    yte = np.linspace(0.1, 1.0, 4)
    vols = np.full(4, 0.7)
    with pytest.raises(ValueError):
        fit_dmr(yte, vols)


def test_dmr_rejects_nonpositive_vols():
    yte = np.linspace(0.1, 1.0, 6)
    vols = np.array([0.7, 0.65, -0.1, 0.6, 0.58, 0.55])
    with pytest.raises(ValueError):
        fit_dmr(yte, vols)


def test_dmr_lambda_short_strictly_less_than_long():
    """Bound construction enforces λ_short < λ_long even on degenerate data."""
    yte = np.array([
        1 / 365, 7 / 365, 14 / 365, 1 / 12, 2 / 12, 3 / 12, 6 / 12, 1.0, 1.5, 2.0,
    ])
    vols = np.full_like(yte, 0.7)              # flat curve
    fit = fit_dmr(yte, vols)
    assert fit.lambda_short < fit.lambda_long


# ---------- ρ SMR + ν SMR adapters ----------

def test_fit_rho_smr_recovers_term_structure():
    yte = np.array([0.05, 0.1, 0.25, 0.5, 1.0, 2.0])
    rho_inf, rho_0, lam = -0.25, -0.6, 0.4
    rho = np.tanh(np.arctanh(rho_inf) + (np.arctanh(rho_0) - np.arctanh(rho_inf)) * np.exp(-yte / lam))
    fit = fit_rho_smr(yte, rho)
    assert abs(fit.rho_inf - rho_inf) < 5e-3
    assert abs(fit.rho_0 - rho_0) < 5e-3
    assert abs(fit.lambda_r - lam) < 5e-2
    # Model evaluates at arbitrary tenors.
    np.testing.assert_allclose(fit.model_rho(yte), rho, atol=5e-3)


def test_fit_rho_smr_rejects_boundary_values():
    yte = np.array([0.05, 0.1, 0.25])
    with pytest.raises(ValueError):
        fit_rho_smr(yte, np.array([0.5, 0.6, 1.0]))      # ρ = 1 at boundary
    with pytest.raises(ValueError):
        fit_rho_smr(yte, np.array([0.5, 0.6, -1.5]))     # outside (-1, 1)


