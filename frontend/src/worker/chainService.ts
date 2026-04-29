// chainService — dual-mode chain snapshot stream.
//
// Subscriptions are keyed by {currency, expiry?}. The oracle's refcount
// dedups so multiple tabs/widgets on the same slice share one backend
// conversation. Server emits a ChainSnapshot envelope every chain poll
// (~2s); we yield those envelopes verbatim.

import { isOracleContext, registerService, subscribeRemote } from './hrtWorker';

export interface ChainRow {
  instrument_name: string;
  expiry: string;
  strike: number;
  option_type: 'C' | 'P';
  mark_iv: number;
  bid_iv: number | null;
  ask_iv: number | null;
  mark_price: number;
  bid_price: number | null;
  ask_price: number | null;
  mid_price: number | null;
  spread: number | null;
  open_interest: number;
  volume_24h: number;
  underlying_price: number;
  change_1h: number | null;
  change_24h: number | null;
  change_iv_1h: number | null;
  timestamp_ms: number;
}

export interface ChainSnapshot {
  currency: string;
  expiry: string | null;
  timestamp_ms: number;
  rows: ChainRow[];
  expiries: string[];
}

interface ChainParams { currency: string; expiry?: string | null }

if (isOracleContext) {
  registerService('chain', async function* (params) {
    const { currency, expiry } = params as ChainParams;
    const { backendConversation } = await import('./oracle');
    for await (const env of backendConversation({
      type: 'subscribe_chain', currency, expiry: expiry ?? null,
    })) {
      if (env.type === 'chain_snapshot') {
        yield env.data as ChainSnapshot;
      } else if (env.type === 'error') {
        throw new Error(`chain: ${(env as { message?: string }).message ?? 'unknown error'}`);
      }
    }
  });
}

export function chainStream(currency: string, expiry?: string | null): AsyncGenerator<ChainSnapshot> {
  return subscribeRemote('chain', { currency, expiry: expiry ?? null }) as AsyncGenerator<ChainSnapshot>;
}

// Lightweight HTTP fallback for the expiry list (small, cheap, refresh on widget mount).
export async function fetchExpiries(currency: string): Promise<string[]> {
  const resp = await fetch(`/api/chain/expiries?currency=${encodeURIComponent(currency)}`);
  if (!resp.ok) throw new Error(`expiries ${currency}: ${resp.status}`);
  const body = await resp.json();
  return (body.expiries ?? []) as string[];
}
