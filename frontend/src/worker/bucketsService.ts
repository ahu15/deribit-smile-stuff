// bucketsService — dual-mode hourly-bucket historic-fit streams (M3.9).
//
// Two services:
//   * `smileBuckets(currency, expiry, methodology, termStructure, lookbackMs)`
//     emits {kind:'snapshot', buckets: [...]} once on subscribe, then a
//     {kind:'append', bucket_ts, fit} on every chain poll. The append's
//     `isNewBucket` flag tells the consumer whether to *replace* the
//     in-progress head bucket or *push* a fresh one onto the array.
//   * `termStructureBuckets(currency, method, lookbackMs)` — same shape
//     for term-structure snapshots.
//
// Refcount-shared via the oracle keyed on the full params tuple — two
// SmileCharts on the same (currency, expiry, methodology, termStructure,
// lookbackMs) hit one backend conversation. `calendar_rev` rides on every
// envelope (HRT principle 6) so a recalibrate doesn't churn open
// subscriptions; the M3.9d invalidation envelope replays a snapshot on
// the same conversation.

import type { SmileFit } from './smileService';
import type { TermStructureSnapshot } from './termstructureService';
import { isOracleContext, registerService, subscribeRemote } from './hrtWorker';

export interface SmileBucketEntry {
  bucket_ts: number;
  fit: SmileFit | null;
}

export interface SmileBucketsSnapshot {
  kind: 'snapshot';
  currency: string;
  expiry: string;
  methodology: string;
  termStructure: string | null;
  lookbackMs: number;
  calendar_rev: string;
  buckets: SmileBucketEntry[];
}

export interface SmileBucketsAppend {
  kind: 'append';
  currency: string;
  expiry: string;
  methodology: string;
  termStructure: string | null;
  calendar_rev: string;
  bucket_ts: number;
  fit: SmileFit | null;
  isNewBucket: boolean;
}

export type SmileBucketsEnvelope = SmileBucketsSnapshot | SmileBucketsAppend;

export interface TsBucketEntry {
  bucket_ts: number;
  snapshot: TermStructureSnapshot | null;
}

export interface TsBucketsSnapshot {
  kind: 'snapshot';
  currency: string;
  method: string;
  lookbackMs: number;
  calendar_rev: string;
  buckets: TsBucketEntry[];
}

export interface TsBucketsAppend {
  kind: 'append';
  currency: string;
  method: string;
  calendar_rev: string;
  bucket_ts: number;
  snapshot: TermStructureSnapshot | null;
  isNewBucket: boolean;
}

export type TsBucketsEnvelope = TsBucketsSnapshot | TsBucketsAppend;

interface SmileBucketsParams {
  currency: string;
  expiry: string;
  methodology: string;
  termStructure: string | null;
  lookbackMs: number;
}

interface TsBucketsParams {
  currency: string;
  method: string;
  lookbackMs: number;
}

if (isOracleContext) {
  registerService('smileBuckets', async function* (params) {
    const { currency, expiry, methodology, termStructure, lookbackMs } =
      params as SmileBucketsParams;
    const { backendConversation } = await import('./oracle');
    for await (const env of backendConversation({
      type: 'subscribe_smile_buckets',
      currency, expiry, methodology, termStructure, lookbackMs,
    })) {
      if (env.type === 'smile_buckets_snapshot') {
        const d = env.data as Omit<SmileBucketsSnapshot, 'kind'>;
        yield { kind: 'snapshot', ...d } satisfies SmileBucketsSnapshot;
      } else if (env.type === 'smile_bucket_append') {
        const d = env.data as Record<string, unknown>;
        yield {
          kind: 'append',
          currency: d.currency as string,
          expiry: d.expiry as string,
          methodology: d.methodology as string,
          termStructure: (d.termStructure as string | null) ?? null,
          calendar_rev: d.calendar_rev as string,
          bucket_ts: d.bucket_ts as number,
          fit: (d.fit as SmileFit | null) ?? null,
          isNewBucket: Boolean(d.is_new_bucket),
        } satisfies SmileBucketsAppend;
      } else if (env.type === 'error') {
        throw new Error(`smileBuckets: ${(env as { message?: string }).message ?? 'unknown error'}`);
      }
    }
  });

  registerService('termStructureBuckets', async function* (params) {
    const { currency, method, lookbackMs } = params as TsBucketsParams;
    const { backendConversation } = await import('./oracle');
    for await (const env of backendConversation({
      type: 'subscribe_termstructure_buckets',
      currency, method, lookbackMs,
    })) {
      if (env.type === 'termstructure_buckets_snapshot') {
        const d = env.data as Omit<TsBucketsSnapshot, 'kind'>;
        yield { kind: 'snapshot', ...d } satisfies TsBucketsSnapshot;
      } else if (env.type === 'termstructure_bucket_append') {
        const d = env.data as Record<string, unknown>;
        yield {
          kind: 'append',
          currency: d.currency as string,
          method: d.method as string,
          calendar_rev: d.calendar_rev as string,
          bucket_ts: d.bucket_ts as number,
          snapshot: (d.snapshot as TermStructureSnapshot | null) ?? null,
          isNewBucket: Boolean(d.is_new_bucket),
        } satisfies TsBucketsAppend;
      } else if (env.type === 'error') {
        throw new Error(`tsBuckets: ${(env as { message?: string }).message ?? 'unknown error'}`);
      }
    }
  });
}

export function smileBucketsStream(
  currency: string,
  expiry: string,
  methodology: string,
  termStructure: string | null,
  lookbackMs: number,
): AsyncGenerator<SmileBucketsEnvelope> {
  return subscribeRemote('smileBuckets', {
    currency, expiry, methodology, termStructure, lookbackMs,
  }) as AsyncGenerator<SmileBucketsEnvelope>;
}

export function termStructureBucketsStream(
  currency: string,
  method: string,
  lookbackMs: number,
): AsyncGenerator<TsBucketsEnvelope> {
  return subscribeRemote('termStructureBuckets', {
    currency, method, lookbackMs,
  }) as AsyncGenerator<TsBucketsEnvelope>;
}
