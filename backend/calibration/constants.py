"""Constants for the calibration / curves modules.

Lifted out of the original `data_structures` reference so the math modules
have one stable source of truth instead of importing from a peer file.
"""

from __future__ import annotations

# Working days per year. Used by the DMR optimizer to express λ bounds in
# working-day terms (`0.1/d`, `20/d`, etc.) so the bounds tighten / loosen
# correctly across calendars. Static value — bounds tightness doesn't need
# to track live calendar edits.
TOTAL_WKG_D: float = 252.0

# Window length (in chain-poll samples) for the bidask-spread SMA weighting
# variant. 30 samples × 2 s polling = 1 minute of recent-history smoothing.
BIDASK_SMA_WINDOW: int = 30
