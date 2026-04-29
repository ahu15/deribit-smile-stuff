// historyService — dual-mode access to the M2.5 historical & live data layer.
//
// Streams (oracle-mediated, multi-tab dedup via SharedWorker refcount):
//   * seriesStream(instrument, field) — initial 24h snapshot, then live appends.
//   * aggregateStream(currency, field) — initial 24h snapshot, then live appends.
//   * tradesStream(instrument)         — initial trade-print log, then live appends.
//   * backfillProgressStream()         — broadcast progress envelope for the StatusPill.
//
// One-shot reads (also oracle-mediated, per HRT principle 1 — tabs never hit
// FastAPI directly; the oracle owns the HTTP fetch and yields the result once):
//   * change(instrument, field, lookbackMs)
//   * sessionOpen(instrument, field, sessionStartMs)
//   * range(instrument, field, t0Ms, t1Ms)

import { isOracleContext, registerService, subscribeRemote } from './hrtWorker';

// ---------- types ----------

export interface SeriesSample {
  ts_ms: number;
  value: number;
}

export interface TradePrint {
  instrument_name: string;
  ts_ms: number;
  price: number;
  iv: number | null;
  direction: string;
  amount: number;
  trade_id: string;
}

export type SeriesField =
  | 'mark' | 'mark_iv' | 'bid_price' | 'ask_price' | 'mid' | 'spread' | 'underlying_price';

export interface SeriesSnapshotEvent {
  kind: 'snapshot';
  instrument: string;
  field: string;
  samples: SeriesSample[];
}

export interface SeriesAppendEvent {
  kind: 'append';
  instrument: string;
  field: string;
  sample: SeriesSample;
}

export type SeriesEvent = SeriesSnapshotEvent | SeriesAppendEvent;

// Per-currency aggregates:
//   'dvol' | 'perp'                 — DVOL, perpetual mark
//   `forward_opt:${expiry}`         — option-implied forward (live, from book_summary)
//   `forward_fut:${expiry}`         — future mark (backfilled from chart data)
export type AggregateField = 'dvol' | 'perp' | string;

export interface AggregateSnapshotEvent {
  kind: 'snapshot';
  currency: string;
  field: string;
  samples: SeriesSample[];
}

export interface AggregateAppendEvent {
  kind: 'append';
  currency: string;
  field: string;
  sample: SeriesSample;
}

export type AggregateEvent = AggregateSnapshotEvent | AggregateAppendEvent;

export interface TradesSnapshotEvent {
  kind: 'snapshot';
  instrument: string;
  trades: TradePrint[];
}

export interface TradeAppendEvent {
  kind: 'append';
  instrument: string;
  trade: TradePrint;
}

export type TradesEvent = TradesSnapshotEvent | TradeAppendEvent;

export interface BackfillProgress {
  state: 'idle' | 'running' | 'done';
  total: number;
  completed: number;
  pct: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
}

interface SeriesParams { instrument: string; field: SeriesField }
interface AggregateParams { currency: string; field: AggregateField }
interface TradesParams { instrument: string }

// ---------- oracle-side service registration ----------

if (isOracleContext) {
  registerService('historySeries', async function* (params) {
    const { instrument, field } = params as SeriesParams;
    const { backendConversation } = await import('./oracle');
    for await (const env of backendConversation({ type: 'subscribe_history', instrument, field })) {
      if (env.type === 'history_snapshot') {
        const data = env.data as { instrument: string; field: string; samples: SeriesSample[] };
        yield {
          kind: 'snapshot',
          instrument: data.instrument,
          field: data.field,
          samples: data.samples,
        } satisfies SeriesSnapshotEvent;
      } else if (env.type === 'history_append') {
        yield {
          kind: 'append',
          instrument,
          field,
          sample: env.data as SeriesSample,
        } satisfies SeriesAppendEvent;
      } else if (env.type === 'error') {
        throw new Error(`historySeries: ${(env as { message?: string }).message ?? 'unknown error'}`);
      }
    }
  });

  registerService('historyAggregate', async function* (params) {
    const { currency, field } = params as AggregateParams;
    const { backendConversation } = await import('./oracle');
    for await (const env of backendConversation({ type: 'subscribe_aggregate', currency, field })) {
      if (env.type === 'aggregate_snapshot') {
        const data = env.data as { currency: string; field: string; samples: SeriesSample[] };
        yield {
          kind: 'snapshot',
          currency: data.currency,
          field: data.field,
          samples: data.samples,
        } satisfies AggregateSnapshotEvent;
      } else if (env.type === 'aggregate_append') {
        yield {
          kind: 'append',
          currency,
          field,
          sample: env.data as SeriesSample,
        } satisfies AggregateAppendEvent;
      } else if (env.type === 'error') {
        throw new Error(`historyAggregate: ${(env as { message?: string }).message ?? 'unknown error'}`);
      }
    }
  });

  registerService('historyTrades', async function* (params) {
    const { instrument } = params as TradesParams;
    const { backendConversation } = await import('./oracle');
    for await (const env of backendConversation({ type: 'subscribe_trades', instrument })) {
      if (env.type === 'trades_snapshot') {
        const data = env.data as { instrument: string; trades: TradePrint[] };
        yield {
          kind: 'snapshot',
          instrument: data.instrument,
          trades: data.trades,
        } satisfies TradesSnapshotEvent;
      } else if (env.type === 'trade_append') {
        yield {
          kind: 'append',
          instrument,
          trade: env.data as TradePrint,
        } satisfies TradeAppendEvent;
      } else if (env.type === 'error') {
        throw new Error(`historyTrades: ${(env as { message?: string }).message ?? 'unknown error'}`);
      }
    }
  });

  registerService('backfillProgress', async function* () {
    const { backendStream } = await import('./oracle');
    for await (const data of backendStream('backfill_progress')) {
      yield data as BackfillProgress;
    }
  });

  // One-shot HTTP-backed reads. Routing through the oracle (per HRT principle 1)
  // means the SharedWorker owns the `fetch`; tabs only see the AsyncGenerator API.
  // Each generator yields exactly once and completes.
  registerService('historyChange', async function* (params) {
    const p = params as { instrument: string; field: string; lookbackMs: number };
    const q = new URLSearchParams({
      instrument: p.instrument, field: p.field, lookback_ms: String(p.lookbackMs),
    });
    const resp = await fetch(`/api/history/change?${q.toString()}`);
    if (!resp.ok) throw new Error(`change ${p.instrument}/${p.field}: ${resp.status}`);
    const body = await resp.json();
    yield (body.value ?? null) as number | null;
  });

  registerService('historySessionOpen', async function* (params) {
    const p = params as { instrument: string; field: string; sessionStartMs: number };
    const q = new URLSearchParams({
      instrument: p.instrument, field: p.field, session_start_ms: String(p.sessionStartMs),
    });
    const resp = await fetch(`/api/history/session-open?${q.toString()}`);
    if (!resp.ok) throw new Error(`sessionOpen ${p.instrument}/${p.field}: ${resp.status}`);
    const body = await resp.json();
    yield (body.value ?? null) as number | null;
  });

  registerService('historyRange', async function* (params) {
    const p = params as { instrument: string; field: string; t0Ms: number; t1Ms: number };
    const q = new URLSearchParams({
      instrument: p.instrument, field: p.field, t0_ms: String(p.t0Ms), t1_ms: String(p.t1Ms),
    });
    const resp = await fetch(`/api/history/range?${q.toString()}`);
    if (!resp.ok) throw new Error(`range ${p.instrument}/${p.field}: ${resp.status}`);
    const body = await resp.json();
    yield (body.samples ?? []) as SeriesSample[];
  });
}

// One-shot driver: consume the first value of an oracle-routed generator and
// drop the rest. The generator's `finally` (in subscribeRemote) sends the
// `unsubscribe` message — keeping principle 6 (explicit cleanup) intact.
async function oneShot<T>(gen: AsyncGenerator<unknown>): Promise<T> {
  try {
    const { value, done } = await gen.next();
    if (done) throw new Error('one-shot service yielded no value');
    return value as T;
  } finally {
    await gen.return(undefined);
  }
}

// ---------- client-side stream API ----------

export function seriesStream(instrument: string, field: SeriesField): AsyncGenerator<SeriesEvent> {
  return subscribeRemote('historySeries', { instrument, field }) as AsyncGenerator<SeriesEvent>;
}

export function aggregateStream(currency: string, field: AggregateField): AsyncGenerator<AggregateEvent> {
  return subscribeRemote('historyAggregate', { currency, field }) as AsyncGenerator<AggregateEvent>;
}

export function tradesStream(instrument: string): AsyncGenerator<TradesEvent> {
  return subscribeRemote('historyTrades', { instrument }) as AsyncGenerator<TradesEvent>;
}

export function backfillProgressStream(): AsyncGenerator<BackfillProgress> {
  return subscribeRemote('backfillProgress') as AsyncGenerator<BackfillProgress>;
}

// ---------- client-side one-shot helpers (oracle-routed) ----------

export function change(instrument: string, field: SeriesField, lookbackMs: number): Promise<number | null> {
  return oneShot<number | null>(subscribeRemote('historyChange', { instrument, field, lookbackMs }));
}

export function sessionOpen(instrument: string, field: SeriesField, sessionStartMs: number): Promise<number | null> {
  return oneShot<number | null>(subscribeRemote('historySessionOpen', { instrument, field, sessionStartMs }));
}

export function range(
  instrument: string, field: SeriesField, t0Ms: number, t1Ms: number,
): Promise<SeriesSample[]> {
  return oneShot<SeriesSample[]>(subscribeRemote('historyRange', { instrument, field, t0Ms, t1Ms }));
}
