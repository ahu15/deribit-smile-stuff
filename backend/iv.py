"""Black-76 implied-vol inversion for Deribit's coin-denominated quotes.

Deribit's `get_book_summary_by_currency` doesn't return bid_iv / ask_iv for
options, so we invert the coin-quoted bid / ask price into an IV at request
time. Kept out of `sabr_greeks.py` to honour the PLAN constraint that the
SABR module ships unmodified — only `BSMerton` is imported here.
"""

from __future__ import annotations

import numpy as np

from sabr_greeks import BSMerton


def iv_from_price(
    price_coin: float | None,
    forward: float | None,
    strike: float | None,
    t_years: float,
    is_call: bool,
    iv_guess: float = 0.6,
    tol: float = 1e-5,
    max_iter: int = 50,
) -> float | None:
    """Invert a Deribit-style coin-denominated option price to a Black-76 vol.

    Deribit quotes options as a fraction of the underlying coin (e.g. a BTC
    call printing 0.027 means 0.027 BTC = 270 bps of one BTC). Black-Scholes
    wants a premium in the same currency as F and K, so multiply by the
    per-expiry forward to get the USD premium before inversion.

    Returns None on bad inputs, sub-intrinsic prices, or non-convergence —
    callers should treat that as "no IV available" and skip the point.
    """
    if (price_coin is None or forward is None or strike is None
            or price_coin <= 0 or forward <= 0 or strike <= 0 or t_years <= 0):
        return None
    cp = 1 if is_call else -1
    prem = price_coin * forward
    # Stale bid prints can sit slightly below undiscounted intrinsic when the
    # forward has just moved. No real IV exists there — better to skip than
    # to return a junk value.
    intrinsic = max(0.0, cp * (forward - strike))
    if prem < intrinsic - 1e-9:
        return None
    try:
        bs = BSMerton(
            CallPut=cp, S=forward, K=strike, r=0, q=0,
            T_days=t_years * 365.0, prem=prem,
            IVguess=iv_guess, tol=tol, max_iter=max_iter,
        )
        sigma = bs.IV()
    except Exception:
        return None
    if sigma is None or not np.isfinite(sigma) or sigma <= 0 or sigma > 10:
        return None
    return float(sigma)
