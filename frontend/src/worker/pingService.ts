// pingService — end-to-end M1 test.
//
// In oracle context: registers a 'ping' service that periodically asks the
// backend to round-trip through Deribit (public/get_time) and yields the result.
// In client context: a thin proxy that subscribes via the SharedWorker.
//
// This proves the full pipeline: Deribit → backend → oracle → tab.

import { isOracleContext, registerService, subscribeRemote } from './hrtWorker';

export interface Ping {
  client_ts_ms: number;   // when the backend started the request
  deribit_ts_ms: number;  // server time reported by Deribit
  rtt_ms: number;         // round-trip duration on the backend
  oracle_ts_ms: number;   // when the oracle received the reply
}

if (isOracleContext) {
  registerService('ping', async function* () {
    // dynamic import to avoid eager top-level cycle
    const { backendPing } = await import('./oracle');
    while (true) {
      try {
        const env = await backendPing();
        const data = env.data as Omit<Ping, 'oracle_ts_ms'>;
        yield { ...data, oracle_ts_ms: Date.now() } satisfies Ping;
      } catch {
        // backend likely down; pause and retry
        await new Promise((r) => setTimeout(r, 2000));
      }
      await new Promise((r) => setTimeout(r, 5000));
    }
  });
}

export function pingStream(): AsyncGenerator<Ping> {
  return subscribeRemote('ping') as AsyncGenerator<Ping>;
}
