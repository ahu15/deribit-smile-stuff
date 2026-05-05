"""Curve-builder registry.

Curve builders factor along (family, time_basis). Family today is just
`dmr`; source is implicit (`atm_iv` — 3-strike log-K quadratic in
`dmr_builders.py`). Adding a new family (e.g. variance-swap) is a module
drop that registers a factory here without touching the build loop.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Literal

from .builder import CurveBuilder
from .dmr_builders import TsAtmDmrBuilder


@dataclass(frozen=True)
class CurveMethodSpec:
    """Plain-data registry entry — what `GET /api/term-structure/methods` ships."""
    id: str
    family: str
    source: str
    time_basis: Literal["cal", "wkg"]
    requires: tuple[str, ...]
    label: str


_FAMILIES = ("dmr",)
_BASES: tuple[Literal["cal", "wkg"], ...] = ("cal", "wkg")


def _label_for(family: str, basis: str) -> str:
    return f"{family.upper()} · ATM · {basis}"


CurveBuilderFactory = Callable[[str, Literal["cal", "wkg"]], CurveBuilder]


def _atm_dmr_factory(method_id: str, basis: Literal["cal", "wkg"]) -> CurveBuilder:
    return TsAtmDmrBuilder(
        method=method_id,
        time_basis=basis,
        requires=(),
        label=_label_for("dmr", basis),
    )


_FACTORIES: dict[str, CurveBuilderFactory] = {
    "dmr": _atm_dmr_factory,
}


def _id_for(family: str, basis: str) -> str:
    return f"ts_atm_{family}_{basis}"


def _build_registry() -> dict[str, CurveBuilder]:
    out: dict[str, CurveBuilder] = {}
    for family in _FAMILIES:
        for basis in _BASES:
            factory = _FACTORIES.get(family)
            if factory is None:
                continue
            method_id = _id_for(family, basis)
            out[method_id] = factory(method_id, basis)
    return out


REGISTRY: dict[str, CurveBuilder] = _build_registry()


# Legacy aliases — saved widget profiles created before this redesign carry
# the old method ids. Resolve them to the new ATM-quadratic builder so an
# old config still finds a curve. The chart's runtime fallback (preserve
# unknown id in the dropdown) handles anything beyond this list.
_ALIASES: dict[str, str] = {
    "ts_alpha_dmr_cal": "ts_atm_dmr_cal",
    "ts_alpha_dmr_wkg": "ts_atm_dmr_wkg",
    "ts_atm_linear_dmr_cal": "ts_atm_dmr_cal",
    "ts_atm_linear_dmr_wkg": "ts_atm_dmr_wkg",
}


def resolve_curve_alias(method: str) -> str:
    return _ALIASES.get(method, method)


def get_curve_builder(method: str) -> CurveBuilder | None:
    return REGISTRY.get(resolve_curve_alias(method))


def list_curve_methods() -> list[CurveMethodSpec]:
    """Catalog shipped to the frontend. Sorted by id for deterministic order."""
    out = [
        CurveMethodSpec(
            id=b.method,
            family=b.family,
            source=b.source,
            time_basis=b.time_basis,
            requires=tuple(b.requires),
            label=b.label,
        )
        for b in REGISTRY.values()
    ]
    out.sort(key=lambda s: s.id)
    return out
