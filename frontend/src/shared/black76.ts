// Black-76 (Black-Scholes-on-forward) pricer + greeks. Used by QuickPricer
// (M3.5) and is the math foundation the M5 full Pricer will share.
//
// Conventions:
//   * F   = forward price
//   * K   = strike
//   * T   = time to expiry, in years
//   * σ   = implied vol (decimal, NOT percent)
//   * r   = continuously-compounded risk-free rate
//   * cp  = +1 for a call, −1 for a put
//
// Premium returned is in the same currency as F (i.e. USD if F is the
// option's per-expiry forward in USD). To get a Deribit-style coin
// quote, divide by the underlying coin's spot — or by F when r ≈ 0,
// which is the convention used by the chain's `mark_price` field.
//
// Greeks (forward-space):
//   Δ  = ∂P/∂F      (per unit forward move)
//   Γ  = ∂²P/∂F²
//   ν  = ∂P/∂σ      (per 1.0 vol unit, i.e. 100 vol points — divide by
//                    100 to get vega-per-vol-point)
//   Θ  = ∂P/∂t      (per year, with t the calendar clock — divide by 365
//                    to convert to per-day)

const SQRT_2 = Math.sqrt(2);
const SQRT_2PI = Math.sqrt(2 * Math.PI);

function pdf(x: number): number {
  return Math.exp(-0.5 * x * x) / SQRT_2PI;
}

// Abramowitz & Stegun 7.1.26 erf approximation — max error ~1.5e-7.
function erf(x: number): number {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1.0 / (1.0 + p * ax);
  const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return sign * y;
}

function cdf(x: number): number {
  return 0.5 * (1 + erf(x / SQRT_2));
}

export interface PricedLeg {
  premium_fwd: number;   // option premium in same currency as F
  delta: number;
  gamma: number;
  vega: number;          // per 1.0 vol
  theta: number;         // per year
}

export function priceBlack76(
  cp: 1 | -1, F: number, K: number, T: number, sigma: number, r: number,
): PricedLeg | null {
  if (!Number.isFinite(F) || !Number.isFinite(K) || !Number.isFinite(T)
      || !Number.isFinite(sigma) || !Number.isFinite(r)
      || F <= 0 || K <= 0 || T <= 0 || sigma <= 0) {
    return null;
  }
  const sqrtT = Math.sqrt(T);
  const sigmaSqrtT = sigma * sqrtT;
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / sigmaSqrtT;
  const d2 = d1 - sigmaSqrtT;
  const df = Math.exp(-r * T);
  const N = (x: number) => cdf(x);
  const phi = pdf(d1);

  const premium_fwd = cp === 1
    ? df * (F * N(d1) - K * N(d2))
    : df * (K * N(-d2) - F * N(-d1));

  const delta = cp === 1
    ? df * N(d1)
    : -df * N(-d1);
  const gamma = df * phi / (F * sigmaSqrtT);
  const vega = F * df * phi * sqrtT;
  // Black-76 theta (∂P/∂t with t = elapsed time, so ∂P/∂T = -theta_calendar).
  // We want theta as "per year of calendar passage" (so it's negative for a
  // long option that's losing time-value), hence the leading minus.
  const theta_term1 = -F * df * phi * sigma / (2 * sqrtT);
  const theta_term2 = cp === 1
    ? -r * (F * df * N(d1) - K * df * N(d2))
    : -r * (K * df * N(-d2) - F * df * N(-d1));
  const theta = theta_term1 + theta_term2;

  return { premium_fwd, delta, gamma, vega, theta };
}

// SABR Hagan-2002 lognormal vol expansion. β-general, but we default to β=1
// to match Deribit's lognormal convention. Returns null on degenerate inputs.
export function sabrLognormalVol(
  K: number, F: number, T: number,
  alpha: number, beta: number, rho: number, volvol: number,
): number | null {
  if (!Number.isFinite(K) || !Number.isFinite(F) || !Number.isFinite(T)
      || K <= 0 || F <= 0 || T <= 0 || alpha <= 0) {
    return null;
  }
  const eps = 1e-7;
  const logfk = Math.log(F / K);
  const fkbeta = Math.pow(F * K, 1 - beta);
  const a = Math.pow(1 - beta, 2) * alpha * alpha / (24 * fkbeta);
  const b = 0.25 * rho * beta * volvol * alpha / Math.sqrt(fkbeta);
  const c = (2 - 3 * rho * rho) * volvol * volvol / 24;
  const d = Math.sqrt(fkbeta);
  const v = Math.pow(1 - beta, 2) * logfk * logfk / 24;
  const w = Math.pow(1 - beta, 4) * Math.pow(logfk, 4) / 1920;
  const z = volvol * Math.sqrt(fkbeta) * logfk / alpha;

  if (Math.abs(z) > eps) {
    const xRoot = Math.sqrt(1 - 2 * rho * z + z * z) + z - rho;
    const xDen = 1 - rho;
    if (xRoot <= 0 || xDen <= 0) return null;
    const xz = Math.log(xRoot / xDen);
    if (xz === 0) return null;
    return alpha * z * (1 + (a + b + c) * T) / (d * (1 + v + w) * xz);
  }
  return alpha * (1 + (a + b + c) * T) / (d * (1 + v + w));
}
