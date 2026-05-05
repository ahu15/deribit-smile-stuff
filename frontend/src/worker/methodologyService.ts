// methodologyService — one-shot catalog fetch for the M3.7 calibration registry.
// Wraps `GET /api/methodologies`; refcount-shared via the oracle so every
// dropdown across every tab hits one fetch (HRT principles 1, 2). The
// catalog is build-time-constant on the backend, so a session-long cache
// is correct — refresh is on tab reload.

import { isOracleContext, registerService, subscribeRemote } from './hrtWorker';

export interface MethodologySpec {
  id: string;
  family: string;
  freeze: string;          // "none" | "alpha-from-ts"
  weights: string;         // "uniform" | "atm-manual" | "bidask-spread" | "bidask-spread-sma"
  time_basis: 'cal' | 'wkg';
  requires_ts: boolean;
  label: string;
}

if (isOracleContext) {
  registerService('methodologyCatalog', async function* () {
    const resp = await fetch('/api/methodologies');
    if (!resp.ok) throw new Error(`methodologies: ${resp.status}`);
    const body = (await resp.json()) as { methodologies: MethodologySpec[] };
    yield body.methodologies;
  });
}

export async function fetchMethodologies(): Promise<MethodologySpec[]> {
  const gen = subscribeRemote('methodologyCatalog', {}) as AsyncGenerator<MethodologySpec[]>;
  try {
    const { value, done } = await gen.next();
    if (done) throw new Error('methodologyCatalog yielded no value');
    return value;
  } finally {
    await gen.return(undefined);
  }
}
