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
  // Session-long cache: the catalog is build-time constant on the backend,
  // so the first successful fetch is reused for the rest of the session by
  // every widget that calls `fetchMethodologies()`. Without this each
  // widget mount races to its own fetch — `subscribeRemote` only refcount-
  // shares while the generator is open, and one-shot generators close
  // immediately after yielding, so concurrent mounts each spin up a fresh
  // request. A failed fetch clears the cache so the next call retries.
  let cached: Promise<MethodologySpec[]> | null = null;
  registerService('methodologyCatalog', async function* () {
    if (!cached) {
      cached = (async () => {
        const resp = await fetch('/api/methodologies');
        if (!resp.ok) throw new Error(`methodologies: ${resp.status}`);
        const body = (await resp.json()) as { methodologies: MethodologySpec[] };
        return body.methodologies;
      })().catch(err => { cached = null; throw err; });
    }
    yield await cached;
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
