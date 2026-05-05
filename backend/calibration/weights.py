"""Per-strike residual weighting for the SABR objective (M3.8).

Four variants are catalog axes (PLAN §M3.8):
  * `uniform`           — w_i = 1 for all i.
  * `atm-manual`        — Gaussian bump centered at K = F, sigma in K-units.
  * `bidask-spread`     — w_i ∝ 1 / spread_i (current snapshot spread).
  * `bidask-spread-sma` — w_i ∝ 1 / SMA(spread_i, N) using HistoryStore.

Weights are returned aligned with the strike list the caller passes in
(after parity-collapse). Values that can't be computed (no spread, etc.)
fall back to the median weight so the strike isn't dropped — the caller
applies `weights * 0` only at the math layer for non-finite IVs.
"""

from __future__ import annotations

from collections import defaultdict
from typing import TYPE_CHECKING

import numpy as np

from backend.chain import parse_expiry, parse_strike

from .constants import BIDASK_SMA_WINDOW

if TYPE_CHECKING:
    from backend.chain import ChainSnapshot
    from backend.history import HistoryStore


def compute_weights(
    variant: str,
    *,
    strikes: list[float],
    forward: float,
    expiry: str,
    snapshot: "ChainSnapshot",
    history_store: "HistoryStore | None" = None,
) -> list[float]:
    """Return per-strike residual weights, length = len(strikes).

    Strikes are after parity-collapse (one per K). For spread-based variants,
    each per-strike weight is the average of call+put spreads at that K
    (mirroring how `average_iv_by_strike` collapses IVs).
    """
    n = len(strikes)
    if n == 0:
        return []
    if variant == "uniform":
        return [1.0] * n
    if variant == "atm-manual":
        return _atm_manual(strikes, forward)
    if variant == "bidask-spread":
        spreads = _spreads_by_strike(snapshot, expiry, snapshot_only=True)
        return _from_spreads(strikes, spreads)
    if variant == "bidask-spread-sma":
        spreads = _spreads_by_strike(
            snapshot, expiry,
            snapshot_only=False,
            history_store=history_store,
        )
        return _from_spreads(strikes, spreads)
    # Unknown variant → uniform (calibrator declares its variant statically,
    # so this is a defensive fallback).
    return [1.0] * n


def _atm_manual(strikes: list[float], forward: float) -> list[float]:
    """Gaussian bump centered at F. σ = 0.15·F (15% wide), so wings get ~0.6×
    the ATM weight at ±15% moneyness."""
    if forward <= 0 or not strikes:
        return [1.0] * len(strikes)
    sigma = 0.15 * forward
    arr = np.array(strikes, dtype=float)
    return [float(np.exp(-((k - forward) ** 2) / (2 * sigma ** 2))) for k in arr]


def _spreads_by_strike(
    snapshot: "ChainSnapshot",
    expiry: str,
    *,
    snapshot_only: bool,
    history_store: "HistoryStore | None" = None,
) -> dict[float, float]:
    """Per-strike average spread for `expiry`. Snapshot mode reads the
    current `book_summaries[name].{bid,ask}_price`; SMA mode averages the
    last N samples of `HistoryStore.series(name, "spread")`."""
    by_strike: dict[float, list[float]] = defaultdict(list)
    for name, book in snapshot.book_summaries.items():
        if parse_expiry(name) != expiry:
            continue
        k = parse_strike(name)
        if k is None:
            continue
        if snapshot_only:
            bid = book.bid_price
            ask = book.ask_price
            if bid is None or ask is None or ask <= bid:
                continue
            by_strike[k].append(ask - bid)
        else:
            if history_store is None:
                # No history available — fall back to current snapshot spread.
                bid = book.bid_price
                ask = book.ask_price
                if bid is None or ask is None or ask <= bid:
                    continue
                by_strike[k].append(ask - bid)
                continue
            samples = history_store.series(name, "spread")
            if not samples:
                continue
            window = samples[-BIDASK_SMA_WINDOW:]
            avg = sum(s.value for s in window) / len(window)
            if avg > 0:
                by_strike[k].append(avg)
    return {k: float(sum(v) / len(v)) for k, v in by_strike.items() if v}


def _from_spreads(strikes: list[float], spreads: dict[float, float]) -> list[float]:
    """Convert per-strike spreads to weights ∝ 1/spread. Strikes missing
    from `spreads` fall back to the median of available spreads — better
    than dropping the strike, which would silently shrink the fit data set
    on the wings where bid/ask are sometimes missing."""
    if not spreads:
        return [1.0] * len(strikes)
    median = float(np.median(list(spreads.values())))
    out: list[float] = []
    for k in strikes:
        s = spreads.get(k, median)
        out.append(1.0 / s if s > 0 else 1.0 / median if median > 0 else 1.0)
    # Renormalize so the largest weight is 1.0 (kinder to optimizer scaling).
    mx = max(out) or 1.0
    return [w / mx for w in out]
