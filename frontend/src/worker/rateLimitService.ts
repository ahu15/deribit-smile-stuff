// rateLimitService — dual-mode rate-limit status stream.

import { isOracleContext, registerService, subscribeRemote } from './hrtWorker';

export interface RateLimitStatus {
  bucket_fill_pct: number;
  queue_depth: number;
  last_throttled: number | null;
}

if (isOracleContext) {
  registerService('rateLimit', async function* () {
    const { backendStream } = await import('./oracle');
    for await (const data of backendStream('rate_limit_status')) {
      yield data as RateLimitStatus;
    }
  });
}

export function rateLimitStream(): AsyncGenerator<RateLimitStatus> {
  return subscribeRemote('rateLimit') as AsyncGenerator<RateLimitStatus>;
}
