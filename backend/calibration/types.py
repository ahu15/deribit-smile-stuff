"""FitResult tagged union + FitContext (M3.7).

The pre-M3.7 `FitResult` (a flat SABR-only dataclass in `backend/fit.py`)
moves here and widens into a tagged union over `family`. SABR is the only
family at launch; the open enum lets SVI etc. join later as a module drop.

Plain data only — no methods cross the WS port (HRT principle 4). The
frontend reconstructs whatever curve it needs from `params` + a per-family
evaluator table in `frontend/src/calibration/`.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from backend.chain import ChainSnapshot
    from backend.curves import TermStructureSnapshot


@dataclass
class FitResult:
    """Result of a single (currency, expiry, methodology) fit.

    `kind` is the tagged-union discriminator — defines the shape of `params`.
    SABR ships `params = {alpha, rho, volvol, beta}`; future families (e.g.
    SVI) declare their own param schema and a matching frontend evaluator
    in `frontend/src/calibration/<family>.ts`. The methodology's `family`
    axis (in `MethodologySpec`) is conceptually the same value but lives
    on the catalog row, not on every fit.

    Both `t_years_cal` and `t_years_wkg` are stamped on every fit so the
    frontend axis-toggle is free and the M3.99 pricer can pick its basis
    per-leg without a re-fetch. `calendar_rev` is the calendar hash from
    `backend.vol_time.calendar_rev` — cal-basis fits stamp it too for
    debug / round-trip symmetry, but their cache key does not depend on it.
    """
    kind: str                              # tagged-union discriminator, e.g. "sabr"
    methodology: str                       # registry id, e.g. "sabr_none_uniform_cal"
    params: dict[str, float]               # per-kind parameters
    forward: float
    t_years: float                         # the basis actually used by the fit
    t_years_cal: float
    t_years_wkg: float
    calendar_rev: str
    strikes: list[float]                   # sampled strike grid for the fitted curve
    fitted_iv: list[float]                 # vol at each grid strike (per family math)
    market_strikes: list[float]            # strikes that fed the fit
    market_iv: list[float]                 # market mark_iv at those strikes
    weights_used: list[float]              # residual weights (1.0s under uniform)
    residual_rms: float
    weighted_residual_rms: float           # equals residual_rms under uniform weights
    frozen: list[dict] = field(default_factory=list)
    # frozen: list of {param: str, value: float, source: str}; empty under freeze=none.


@dataclass
class FitContext:
    """Per-call context handed to a `Calibrator.fit` invocation.

    Captures enough to do the work without the calibrator reaching into the
    adapter — pure functions of (snapshot, expiry-tagged data, time bases).
    `ts_snapshot` is the upstream `TermStructureSnapshot` for freeze-axis
    calibrators that consume one. M3.7 only ships freeze=none, so it's
    always None for now; M3.8 wires the term-structure stage of the
    per-snapshot pipeline to populate it.
    """
    currency: str
    expiry: str
    snapshot: "ChainSnapshot"
    t_years_cal: float
    t_years_wkg: float
    calendar_rev: str
    ts_snapshot: "TermStructureSnapshot | None" = None
