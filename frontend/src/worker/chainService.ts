// chainService — dual-mode chain snapshot stream.
//
// Oracle: registers 'chain' that yields snapshots from the backend WS.
// Client: subscribeRemote('chain') is exposed as chainStream().

import { isOracleContext, registerService, subscribeRemote } from './hrtWorker';

export interface Mark {
  mark_iv: number;
  mark_price: number;
  underlying_price: number;
}

export interface ChainSnapshot {
  currency: string;
  timestamp_ms: number;
  mark_count: number;
  marks: Record<string, Mark>;
}

if (isOracleContext) {
  registerService('chain', async function* () {
    const { backendStream } = await import('./oracle');
    for await (const data of backendStream('chain_snapshot')) {
      yield data as ChainSnapshot;
    }
  });
}

export function chainStream(): AsyncGenerator<ChainSnapshot> {
  return subscribeRemote('chain') as AsyncGenerator<ChainSnapshot>;
}
