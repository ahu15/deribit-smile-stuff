// termstructureService — dual-mode live term-structure snapshot per
// (currency, method), plus a one-shot historic-fit lookup and a one-shot
// curve-method catalog fetch. All flows route through the oracle so tabs
// never hit FastAPI directly (HRT principle 1) and duplicate subscriptions
// dedup at the oracle refcount.
//
// The conversation key is `(currency, method)`; calendar_rev rides on
// every envelope (not the key) so a recalibrate doesn't churn open
// subscriptions (HRT principle 6) — same pattern as smileService.

import { isOracleContext, registerService, subscribeRemote } from './hrtWorker';

export interface TermStructureSnapshot {
  method: string;
  currency: string;
  time_basis: 'cal' | 'wkg';
  t_years_cal_grid: number[];
  t_years_wkg_grid: number[];
  atm_vol_grid: number[];
  alpha_grid: number[];
  fwd_var_grid: number[];
  params: Record<string, number>;
  rmse: number;
  calendar_rev: string;
  // Sample inputs the curve fit consumed — for the chart's market-dot overlay.
  market_t_cal: number[];
  market_t_wkg: number[];
  market_atm_vol: number[];
  market_expiries: string[];
  // Per-pair forward variance (midpoint anchors in both bases) so fwd-var
  // markers sit on the same convention the DMR fit consumed.
  market_fwd_var: number[];
  market_fwd_var_t_cal: number[];
  market_fwd_var_t_wkg: number[];
}

export interface TermStructureEnvelope {
  currency: string;
  method: string;
  timestamp_ms: number;
  calendar_rev: string;
  snapshot: TermStructureSnapshot | null;
}

export interface HistoricTermStructure {
  currency: string;
  method: string;
  as_of_ms: number;
  snapped_ms: number | null;
  earliest_ms: number | null;
  latest_ms: number | null;
  calendar_rev: string;
  snapshot: TermStructureSnapshot | null;
}

export interface CurveMethodSpec {
  id: string;
  family: string;
  // Backend currently emits `atm_iv` (3-strike log-K quadratic). Open string
  // so additional sources (e.g. `naive_alpha` once a SABR-α-driven builder
  // joins the registry) don't require a frontend type change.
  source: string;
  time_basis: 'cal' | 'wkg';
  requires: string[];
  label: string;
}

interface TsParams {
  currency: string;
  method: string;
}
interface HistoricTsParams {
  currency: string;
  method: string;
  asOfMs: number;
}

if (isOracleContext) {
  registerService('termstructure', async function* (params) {
    const { currency, method } = params as TsParams;
    const { backendConversation } = await import('./oracle');
    for await (const env of backendConversation({
      type: 'subscribe_termstructure',
      currency, method,
    })) {
      if (env.type === 'termstructure_snapshot') {
        yield env.data as TermStructureEnvelope;
      } else if (env.type === 'error') {
        throw new Error(`termstructure: ${(env as { message?: string }).message ?? 'unknown error'}`);
      }
    }
  });

  registerService('historicTermStructure', async function* (params) {
    const { currency, method, asOfMs } = params as HistoricTsParams;
    const q = new URLSearchParams({
      currency, method, as_of_ms: String(asOfMs),
    });
    const resp = await fetch(`/api/term-structure/historic?${q.toString()}`);
    if (!resp.ok) throw new Error(`historic ${currency}/${method}: ${resp.status}`);
    yield (await resp.json()) as HistoricTermStructure;
  });

  registerService('curveMethodCatalog', async function* () {
    const resp = await fetch('/api/term-structure/methods');
    if (!resp.ok) throw new Error(`curve methods: ${resp.status}`);
    const body = (await resp.json()) as { methods: CurveMethodSpec[] };
    yield body.methods;
  });
}

export function termStructureStream(
  currency: string,
  method: string,
): AsyncGenerator<TermStructureEnvelope> {
  return subscribeRemote(
    'termstructure', { currency, method },
  ) as AsyncGenerator<TermStructureEnvelope>;
}

export async function fetchHistoricTermStructure(
  currency: string,
  method: string,
  asOfMs: number,
): Promise<HistoricTermStructure> {
  const gen = subscribeRemote('historicTermStructure', {
    currency, method, asOfMs,
  }) as AsyncGenerator<HistoricTermStructure>;
  try {
    const { value, done } = await gen.next();
    if (done) throw new Error('historicTermStructure yielded no value');
    return value;
  } finally {
    await gen.return(undefined);
  }
}

export async function fetchCurveMethods(): Promise<CurveMethodSpec[]> {
  const gen = subscribeRemote('curveMethodCatalog', {}) as AsyncGenerator<CurveMethodSpec[]>;
  try {
    const { value, done } = await gen.next();
    if (done) throw new Error('curveMethodCatalog yielded no value');
    return value;
  } finally {
    await gen.return(undefined);
  }
}
