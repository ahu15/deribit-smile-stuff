// smileService — dual-mode live smile fit per (currency, expiry, methodology,
// termStructure), plus a one-shot historic-fit lookup. Both flows route
// through the oracle so tabs never hit FastAPI directly (HRT principle 1)
// and duplicate subscriptions / requests dedup at the oracle refcount.
//
// M3.7 widens `SmileFit` to the tagged-union FitResult shape: `kind`
// discriminator + `methodology` id + per-kind `params` bag + cal & wkg
// t_years + calendar_rev. Pre-M3.7 callers that read `fit.alpha` etc. now
// read `fit.params.alpha`. The oracle dedup key is the entire params object
// the consumer passes — `calendar_rev` deliberately rides on the snapshot
// envelope, not the key, so a recalibrate doesn't churn open subscriptions
// (HRT principle 6).

import { isOracleContext, registerService, subscribeRemote } from './hrtWorker';

export interface SmileFit {
  kind: 'sabr';                              // tagged-union discriminator (open — SVI etc. join later)
  methodology: string;                       // resolved registry id
  params: Record<string, number>;            // per-kind bag (SABR: alpha/rho/volvol/beta)
  forward: number;
  t_years: number;                           // basis actually used by the fit
  t_years_cal: number;
  t_years_wkg: number;
  calendar_rev: string;
  strikes: number[];
  fitted_iv: number[];
  market_strikes: number[];
  market_iv: number[];
  weights_used: number[];
  residual_rms: number;
  weighted_residual_rms: number;
  frozen: { param: string; value: number; source: string }[];
}

export interface SmileSnapshot {
  currency: string;
  expiry: string;
  methodology: string;
  termStructure: string | null;
  timestamp_ms: number;
  calendar_rev: string;
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
  calendar_rev: string;
  fit: SmileFit | null;
  market_points: { strike: number; iv: number }[];
}

interface SmileParams {
  currency: string;
  expiry: string;
  methodology: string;
  termStructure: string | null;
}
interface HistoricParams {
  currency: string;
  expiry: string;
  asOfMs: number;
  methodology: string;
  termStructure: string | null;
}

if (isOracleContext) {
  registerService('smile', async function* (params) {
    const { currency, expiry, methodology, termStructure } = params as SmileParams;
    const { backendConversation } = await import('./oracle');
    for await (const env of backendConversation({
      type: 'subscribe_smile',
      currency, expiry, methodology, termStructure,
    })) {
      if (env.type === 'smile_snapshot') {
        yield env.data as SmileSnapshot;
      } else if (env.type === 'error') {
        throw new Error(`smile: ${(env as { message?: string }).message ?? 'unknown error'}`);
      }
    }
  });

  // One-shot historic fit. Refcount-shared via the oracle so saved profiles
  // mounting several SmileCharts at the same (expiry, asof, methodology, ts)
  // hit one HTTP fetch.
  registerService('historicSmile', async function* (params) {
    const { currency, expiry, asOfMs, methodology, termStructure } = params as HistoricParams;
    const q = new URLSearchParams({
      currency, expiry,
      as_of_ms: String(asOfMs),
      methodology,
    });
    if (termStructure) q.set('term_structure', termStructure);
    const resp = await fetch(`/api/smile/historic?${q.toString()}`);
    if (!resp.ok) throw new Error(`historic ${currency}/${expiry}: ${resp.status}`);
    yield (await resp.json()) as HistoricSmile;
  });
}

export function smileStream(
  currency: string,
  expiry: string,
  methodology: string = 'sabr-naive',
  termStructure: string | null = null,
): AsyncGenerator<SmileSnapshot> {
  return subscribeRemote(
    'smile', { currency, expiry, methodology, termStructure },
  ) as AsyncGenerator<SmileSnapshot>;
}

export async function fetchHistoricSmile(
  currency: string,
  expiry: string,
  asOfMs: number,
  methodology: string = 'sabr-naive',
  termStructure: string | null = null,
): Promise<HistoricSmile> {
  const gen = subscribeRemote('historicSmile', {
    currency, expiry, asOfMs, methodology, termStructure,
  }) as AsyncGenerator<HistoricSmile>;
  try {
    const { value, done } = await gen.next();
    if (done) throw new Error('historicSmile yielded no value');
    return value;
  } finally {
    await gen.return(undefined);
  }
}
