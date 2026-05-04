"""CurveBuilder protocol + TermStructureSnapshot shape.

M3.7 ships the shapes only — `FitContext.ts_snapshot: TermStructureSnapshot
| None` consumes the type today (always None in M3.7 since freeze=none is
the only registered freeze). M3.8 lands concrete builders.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable


@dataclass
class TermStructureSnapshot:
    """Pre-sampled term-structure curves + parameters (HRT principle 4).

    Backend ships pre-sampled `(t_years_grid, atm_vol_grid, alpha_grid,
    fwd_var_grid)` arrays and the fitted `params` so the frontend
    `TermStructureChart` (M3.8) reconstructs whatever curve it needs from
    plain data. M3.7 only declares the shape.
    """
    method: str = ""
    currency: str = ""
    t_years_cal_grid: list[float] = field(default_factory=list)
    t_years_wkg_grid: list[float] = field(default_factory=list)
    atm_vol_grid: list[float] = field(default_factory=list)
    alpha_grid: list[float] = field(default_factory=list)
    fwd_var_grid: list[float] = field(default_factory=list)
    params: dict[str, float] = field(default_factory=dict)
    calendar_rev: str = ""


@dataclass
class BuildContext:
    currency: str
    snapshot: object                              # ChainSnapshot — typed loose to avoid import cycle
    naive_fits_by_expiry: dict[str, object] | None = None  # populated in M3.8
    calendar_rev: str = ""


@runtime_checkable
class CurveBuilder(Protocol):
    method: str                                   # e.g. "ts_alpha_dmr"
    requires: tuple[str, ...]                     # other methods/methodologies this depends on
    time_basis: Literal["cal", "wkg"]
    label: str
    def build(self, ctx: BuildContext) -> TermStructureSnapshot | None: ...
