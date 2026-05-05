"""CurveBuilder protocol + TermStructureSnapshot shape."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal, Protocol, runtime_checkable

if TYPE_CHECKING:
    from backend.chain import ChainSnapshot


@dataclass
class TermStructureSnapshot:
    """Pre-sampled term-structure curves + parameters (HRT principle 4).

    Backend ships pre-sampled grids and the fitted `params` so the frontend
    `TermStructureChart` reconstructs whatever curve it needs from plain data.
    Both `t_years_cal_grid` and `t_years_wkg_grid` are stamped from the same
    underlying date grid so the frontend axis-toggle is free regardless of
    which basis the curve was fit in.
    """
    method: str = ""
    currency: str = ""
    time_basis: Literal["cal", "wkg"] = "cal"
    t_years_cal_grid: list[float] = field(default_factory=list)
    t_years_wkg_grid: list[float] = field(default_factory=list)
    atm_vol_grid: list[float] = field(default_factory=list)
    alpha_grid: list[float] = field(default_factory=list)
    fwd_var_grid: list[float] = field(default_factory=list)
    params: dict[str, float] = field(default_factory=dict)
    rmse: float = 0.0
    calendar_rev: str = ""

    # Sample inputs that fed the fit, for the chart's "market dots" overlay.
    market_t_cal: list[float] = field(default_factory=list)
    market_t_wkg: list[float] = field(default_factory=list)
    market_atm_vol: list[float] = field(default_factory=list)
    market_expiries: list[str] = field(default_factory=list)

    # Per-pair forward variance derived from the input vols via
    # `vols_to_fwd_var` — same midpoint convention the DMR fit consumes.
    # Anchored at midpoints between consecutive expiries; the first entry
    # uses (t/2, w[0]/t[0]) so length matches `market_atm_vol`.
    market_fwd_var: list[float] = field(default_factory=list)
    market_fwd_var_t_cal: list[float] = field(default_factory=list)
    market_fwd_var_t_wkg: list[float] = field(default_factory=list)


@dataclass
class BuildContext:
    """Per-call context handed to a `CurveBuilder.build` invocation.

    Adapter populates per-expiry t_years in both bases so cal- and wkg-
    basis builders can read whichever they need without recomputing.
    """
    currency: str
    snapshot: "ChainSnapshot"
    t_years_cal_by_expiry: dict[str, float]
    t_years_wkg_by_expiry: dict[str, float]
    calendar_rev: str = ""


@runtime_checkable
class CurveBuilder(Protocol):
    method: str                                   # e.g. "ts_alpha_dmr_cal"
    family: str                                   # registry axis — e.g. "dmr"
    source: str                                   # input source — "naive_alpha" | "atm_mark_iv"
    requires: tuple[str, ...]                     # other methods/methodologies this depends on
    time_basis: Literal["cal", "wkg"]
    label: str
    def build(self, ctx: BuildContext) -> TermStructureSnapshot | None: ...
