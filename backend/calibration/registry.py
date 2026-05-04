"""MethodologyRegistry (M3.7).

Enumerates smile presets along the four axes from PLAN §M3.6–M3.99:
  family   ∈ {sabr}
  freeze   ∈ {none, alpha-from-ts, volvol-and-alpha-from-ts}
  weights  ∈ {uniform, atm-manual, bidask-spread, bidask-spread-sma}
  time_basis ∈ {cal, wkg}

Methodology id format is `<family>_<freeze>_<weights>_<time_basis>` (per
explicit decision: snake-case underscores, time_basis as suffix). The
registry build is the full Cartesian product, but only the cells whose
calibrator is implemented are registered — unknown cells are skipped at
build time, so M3.8 / M3.9 land variants by adding calibrator factories
without touching this file's structure.

The legacy alias `sabr-naive` resolves to `sabr_none_uniform_cal` to keep
the pre-M3.7 byte-identical default.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Literal

from .calibrator import Calibrator
from .sabr_naive import SabrNaiveCalibrator


@dataclass(frozen=True)
class MethodologySpec:
    """Plain-data registry entry — what `GET /api/methodologies` ships."""
    id: str
    family: str
    freeze: str
    weights: str
    time_basis: Literal["cal", "wkg"]
    requires_ts: bool
    label: str


# ---------- registry build ----------

_FAMILIES = ("sabr",)
_FREEZES = ("none", "alpha-from-ts", "volvol-and-alpha-from-ts")
_WEIGHTS = ("uniform", "atm-manual", "bidask-spread", "bidask-spread-sma")
_BASES: tuple[Literal["cal", "wkg"], ...] = ("cal", "wkg")

# Each implemented (family, freeze, weights) cell registers a calibrator
# factory keyed on time_basis. Adding a new freeze/weights variant is a
# module drop here — the Cartesian product loop below picks it up.
CalibratorFactory = Callable[[str, Literal["cal", "wkg"]], Calibrator]


def _label_for(family: str, freeze: str, weights: str, basis: str) -> str:
    parts = [family.upper()]
    if freeze != "none":
        parts.append(freeze)
    if weights != "uniform":
        parts.append(weights)
    parts.append(basis)
    return " · ".join(parts)


def _sabr_naive_factory(
    methodology_id: str, basis: Literal["cal", "wkg"],
) -> Calibrator:
    return SabrNaiveCalibrator(
        methodology=methodology_id,
        family="sabr",
        freeze="none",
        weights="uniform",
        time_basis=basis,
        requires_ts=False,
        label=_label_for("sabr", "none", "uniform", basis),
    )


_FACTORIES: dict[tuple[str, str, str], CalibratorFactory] = {
    ("sabr", "none", "uniform"): _sabr_naive_factory,
    # M3.8 will register additional cells here:
    # ("sabr", "alpha-from-ts", "uniform"): ...,
    # ("sabr", "alpha-from-ts", "bidask-spread"): ...,
    # ("sabr", "volvol-and-alpha-from-ts", "uniform"): ...,
    # ...
}


def _id_for(family: str, freeze: str, weights: str, basis: str) -> str:
    return f"{family}_{freeze}_{weights}_{basis}"


def _build_registry() -> dict[str, Calibrator]:
    out: dict[str, Calibrator] = {}
    for family in _FAMILIES:
        for freeze in _FREEZES:
            for weights in _WEIGHTS:
                for basis in _BASES:
                    factory = _FACTORIES.get((family, freeze, weights))
                    if factory is None:
                        continue
                    methodology_id = _id_for(family, freeze, weights, basis)
                    out[methodology_id] = factory(methodology_id, basis)
    return out


REGISTRY: dict[str, Calibrator] = _build_registry()


# Legacy alias — keeps M3.5/M3.6 callers working byte-identically.
_ALIASES: dict[str, str] = {
    "sabr-naive": "sabr_none_uniform_cal",
}


def resolve_alias(methodology: str) -> str:
    return _ALIASES.get(methodology, methodology)


def get_calibrator(methodology: str) -> Calibrator | None:
    return REGISTRY.get(resolve_alias(methodology))


def list_methodologies() -> list[MethodologySpec]:
    """Catalog shipped to the frontend via `GET /api/methodologies`.

    Sorted by id so the frontend dropdown order is deterministic across
    backend boots.
    """
    out = [
        MethodologySpec(
            id=c.methodology,
            family=c.family,
            freeze=c.freeze,
            weights=c.weights,
            time_basis=c.time_basis,
            requires_ts=c.requires_ts,
            label=c.label,
        )
        for c in REGISTRY.values()
    ]
    out.sort(key=lambda s: s.id)
    return out
