"""Methodology engine (M3.7).

Tagged-union `FitResult`, the `Calibrator` Protocol, and the methodology
registry. Naive SABR lives here as `sabr_none_uniform_cal` /
`sabr_none_uniform_wkg`; the legacy `sabr-naive` string alias resolves to
the cal variant for byte-identical M3.5 / M3.6 behavior. Per-snapshot dedup
of compute lives in `DeribitAdapter`; the registry is a pure catalog.

`CurveBuilder` (term-structure analog) lives in `backend.curves` — separated
because curve outputs feed multiple smile presets and would create import
cycles if co-located.
"""

from .types import FitResult, FitContext
from .calibrator import Calibrator
from .registry import (
    MethodologySpec,
    REGISTRY,
    list_methodologies,
    get_calibrator,
    resolve_alias,
)
from .buckets import (
    HOUR_MS,
    DAY_MS,
    SmileBucketKey,
    TsBucketKey,
    bucket_boundaries,
    bucket_floor,
    evict_old_smile_buckets,
    evict_old_ts_buckets,
)

__all__ = [
    "FitResult",
    "FitContext",
    "Calibrator",
    "MethodologySpec",
    "REGISTRY",
    "list_methodologies",
    "get_calibrator",
    "resolve_alias",
    "HOUR_MS",
    "DAY_MS",
    "SmileBucketKey",
    "TsBucketKey",
    "bucket_boundaries",
    "bucket_floor",
    "evict_old_smile_buckets",
    "evict_old_ts_buckets",
]
