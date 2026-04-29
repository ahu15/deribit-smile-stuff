// smileService — dual-mode live SABR smile fit per (currency, expiry).
//
// Server fits SABR on every chain snapshot for the requested expiry and emits
// a smile_snapshot envelope. Multiple SmileChart widgets on the same expiry
// share one backend conversation via the oracle's refcounted dedup.

import { isOracleContext, registerService, subscribeRemote } from './hrtWorker';

export interface SmileFit {
  alpha: number;
  rho: number;
  volvol: number;
  beta: number;
  forward: number;
  t_years: number;
  strikes: number[];
  fitted_iv: number[];
  market_strikes: number[];
  market_iv: number[];
  residual_rms: number;
}

export interface SmileSnapshot {
  currency: string;
  expiry: string;
  timestamp_ms: number;
  fit: SmileFit | null;
}

interface SmileParams { currency: string; expiry: string }

if (isOracleContext) {
  registerService('smile', async function* (params) {
    const { currency, expiry } = params as SmileParams;
    const { backendConversation } = await import('./oracle');
    for await (const env of backendConversation({
      type: 'subscribe_smile', currency, expiry,
    })) {
      if (env.type === 'smile_snapshot') {
        yield env.data as SmileSnapshot;
      } else if (env.type === 'error') {
        throw new Error(`smile: ${(env as { message?: string }).message ?? 'unknown error'}`);
      }
    }
  });
}

export function smileStream(currency: string, expiry: string): AsyncGenerator<SmileSnapshot> {
  return subscribeRemote('smile', { currency, expiry }) as AsyncGenerator<SmileSnapshot>;
}
