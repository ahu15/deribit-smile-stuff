"""Term-structure curve builders.

M3.7 ships only the shapes — `CurveBuilder` Protocol, `BuildContext`,
`TermStructureSnapshot` — so `FitContext.ts_snapshot` and future M3.8
pipeline code have stable types to point at without import cycles.
Concrete builders (`ts_alpha_dmr`, `ts_atm_linear_dmr`) land in M3.8
alongside the DMR math port.
"""

from .builder import CurveBuilder, BuildContext, TermStructureSnapshot

__all__ = ["CurveBuilder", "BuildContext", "TermStructureSnapshot"]
