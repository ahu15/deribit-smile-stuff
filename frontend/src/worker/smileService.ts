// smileService — dual-mode live SABR smile fit per (currency, expiry), plus
// a one-shot historic-fit lookup. Both live and historic flows route through
// the oracle so tabs never hit FastAPI directly (HRT principle 1) and
// duplicate subscriptions / requests dedup at the oracle refcount.

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

export interface HistoricSmile {
  currency: string;
  expiry: string;
  as_of_ms: number;
  snapped_ms: number | null;
  earliest_ms: number | null;
  latest_ms: number | null;
  forward: number | null;
  fit: SmileFit | null;
  market_points: { strike: number; iv: number }[];
}

interface SmileParams { currency: string; expiry: string }
interface HistoricParams { currency: string; expiry: string; asOfMs: number }

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

  // One-shot historic SABR fit. Each (currency, expiry, asOfMs) triple shares
  // one HTTP fetch via the oracle's refcount — useful when a saved profile
  // mounts several SmileCharts at the same expiry/asof on reload.
  registerService('historicSmile', async function* (params) {
    const { currency, expiry, asOfMs } = params as HistoricParams;
    const q = new URLSearchParams({
      currency, expiry, as_of_ms: String(asOfMs),
    });
    const resp = await fetch(`/api/smile/historic?${q.toString()}`);
    if (!resp.ok) throw new Error(`historic ${currency}/${expiry}: ${resp.status}`);
    yield (await resp.json()) as HistoricSmile;
  });
}

export function smileStream(currency: string, expiry: string): AsyncGenerator<SmileSnapshot> {
  return subscribeRemote('smile', { currency, expiry }) as AsyncGenerator<SmileSnapshot>;
}

export async function fetchHistoricSmile(
  currency: string, expiry: string, asOfMs: number,
): Promise<HistoricSmile> {
  const gen = subscribeRemote('historicSmile', { currency, expiry, asOfMs }) as AsyncGenerator<HistoricSmile>;
  try {
    const { value, done } = await gen.next();
    if (done) throw new Error('historicSmile yielded no value');
    return value;
  } finally {
    await gen.return(undefined);
  }
}
