// Shared methodology helpers — used by SmileChart, ChainTable, QuickPricer,
// TermStructureChart. The auto-link rule for term-structure-dependent
// calibrators (`requires_ts`) lives here so every widget that consumes a
// methodology resolves the same way.

import type { MethodologySpec } from '../worker/methodologyService';

/** Term-structure curve method id matching the calibrator's basis.
 *  freeze=alpha-from-ts requires the prior to be sampled in the curve's
 *  basis — pairing a cal calibrator with a wkg curve would mis-align the
 *  α(T) lookup grid. Returns null for calibrators that don't need a TS. */
export function termStructureFor(spec: MethodologySpec | null | undefined): string | null {
  if (!spec || !spec.requires_ts) return null;
  return `ts_atm_dmr_${spec.time_basis}`;
}

/** Look up a methodology by id; returns null when not in the catalog
 *  (loading or stale id). */
export function findMethodology(
  catalog: MethodologySpec[],
  id: string,
): MethodologySpec | null {
  return catalog.find(m => m.id === id) ?? null;
}
