// Per-family curve evaluators (M3.7).
//
// `evaluate(kind, params, strikes, forward, t)` reconstructs the fitted vol
// curve from the params bag the backend ships. Backend also pre-samples
// `fitted_iv` over a strike grid for chart rendering; this evaluator covers
// the off-grid case (e.g. exact-strike pricer reads).
//
// `kind` is the FitResult's tagged-union discriminator. SABR is the only
// kind at launch; SVI etc. join by adding a sibling module + a case here.

import { sabrLognormalVolArray, type SabrParams } from './sabr';

export type FitKind = 'sabr';

export function evaluate(
  kind: FitKind,
  params: Record<string, number>,
  strikes: number[],
  forward: number,
  t: number,
): number[] {
  if (kind === 'sabr') {
    const sabr: SabrParams = {
      alpha: params.alpha,
      beta: params.beta,
      rho: params.rho,
      volvol: params.volvol,
    };
    return sabrLognormalVolArray(strikes, forward, t, sabr);
  }
  // Unknown kind — return NaNs; callers can fall back to the pre-sampled grid.
  return strikes.map(() => NaN);
}

export { sabrLognormalVol, sabrLognormalVolArray, type SabrParams } from './sabr';
