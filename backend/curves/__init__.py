"""Term-structure curve builders.

M3.8 ships:
  * `dmr.fit_dmr` + `DmrFit` — the math kernel (forward-variance DMR fit).
  * `dmr_builders.TsAtmDmrBuilder` — consumes chain snapshot directly (per-
    expiry ATM IV via 3-strike log-K quadratic), emits `TermStructureSnapshot`.
  * `registry` — Cartesian-product build over (family, time_basis).
"""

from .builder import BuildContext, CurveBuilder, TermStructureSnapshot
from .registry import (
    REGISTRY,
    CurveMethodSpec,
    get_curve_builder,
    list_curve_methods,
)

__all__ = [
    "BuildContext",
    "CurveBuilder",
    "TermStructureSnapshot",
    "REGISTRY",
    "CurveMethodSpec",
    "get_curve_builder",
    "list_curve_methods",
]
