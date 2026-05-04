// SABR family helpers for the per-kind evaluator table.
//
// Wraps the Hagan-2002 math kernel in `shared/black76.ts` so the math lives
// in one place. This module exists to give the calibration registry a
// params-object surface (`SabrParams`) and an array path the chart layer
// can call without looping per-strike.
//
// The base kernel (`shared/black76.ts:sabrLognormalVol`) returns null on
// degenerate inputs (K/F/T <= 0, alpha <= 0, the |z|>eps branch's `_x`
// blow-up). For chart rendering we want a plottable number even at the
// ATM strike, so the array path falls back to the |z|<=eps closed form
// when the kernel returns null — matching the Python implementation's
// numpy NaN→ATM substitution.

import { sabrLognormalVol as kernelSabrLognormalVol } from '../shared/black76';

export interface SabrParams {
  alpha: number;
  beta: number;
  rho: number;
  volvol: number;
}

/** Single-strike SABR lognormal vol. Returns NaN on degenerate inputs. */
export function sabrLognormalVol(
  k: number, f: number, t: number, params: SabrParams,
): number {
  const v = kernelSabrLognormalVol(k, f, t, params.alpha, params.beta, params.rho, params.volvol);
  return v ?? NaN;
}

/** Vector path. Strikes whose kernel returns null/NaN (typically ATM where
 *  the Hagan `_x(rho, z)` denominator is 0/0) collapse to the closed-form
 *  ATM value, matching the Python implementation. */
export function sabrLognormalVolArray(
  strikes: number[], f: number, t: number, params: SabrParams,
): number[] {
  const { alpha, beta, rho, volvol } = params;
  // Pre-compute the |z|<=eps closed form at the forward (used as the ATM
  // fallback for any strike the main kernel fails on).
  const fkbetaAtm = Math.pow(f * f, 1 - beta);
  const a = Math.pow(1 - beta, 2) * alpha * alpha / (24 * fkbetaAtm);
  const b = 0.25 * rho * beta * volvol * alpha / Math.sqrt(fkbetaAtm);
  const c = (2 - 3 * rho * rho) * volvol * volvol / 24;
  const dAtm = Math.sqrt(fkbetaAtm);
  const atmFallback = alpha * (1 + (a + b + c) * t) / dAtm;

  return strikes.map((k) => {
    const v = kernelSabrLognormalVol(k, f, t, alpha, beta, rho, volvol);
    return v != null && Number.isFinite(v) ? v : atmFallback;
  });
}
