// busService — first cross-widget interaction primitive (M3.5).
//
// Two surfaces:
//   * Generic pub/sub: `busPublish(topic, payload)` and `busSubscribe(topic)`.
//     Fire-and-forget, no replay. Topic strings follow the
//     `<consumer>.<verb>.<scope>` convention (see PLAN.md §M3.5).
//   * QuickPricer presence: `registerQuickPricer(instanceId)` plus
//     `quickPricerStatusStream()`. The presence stream yields the current
//     `{open}` state on subscribe + on every change, so a tab that opens
//     after a pricer is already mounted still sees it. The bus alone
//     wouldn't suffice — it has no replay.
//
// Both flows live in the oracle context; tabs are pure clients (HRT
// principle 1). Payloads must be structured-clone-safe.

import { isOracleContext, registerService, subscribeRemote } from './hrtWorker';

// ────────────────────────────────────────────────────────────────────────────
// Oracle-side state
// ────────────────────────────────────────────────────────────────────────────

interface QueueListener<T = unknown> {
  push: (payload: T) => void;
}

const _topics = new Map<string, Set<QueueListener>>();
// Open QuickPricer instance IDs. A Set (not a count) so a duplicated
// register call from React StrictMode's double-mount can't double-count,
// and a missed unregister on tab close eventually clears once the worker
// dies. Keyed on instance id; each register/unregister carries a unique
// `_tag` to defeat the oracle's refcount dedup so neither call collapses.
const _quickPricerInstances = new Set<string>();
const _statusListeners = new Set<QueueListener<{ open: boolean }>>();

function emitStatus(): void {
  const status = { open: _quickPricerInstances.size > 0 };
  for (const sub of _statusListeners) sub.push(status);
}

function makeQueueGenerator<T>(register: (l: QueueListener<T>) => () => void): AsyncGenerator<T> {
  const queue: T[] = [];
  let notify: (() => void) | null = null;
  const listener: QueueListener<T> = {
    push: (payload) => {
      queue.push(payload);
      notify?.();
      notify = null;
    },
  };
  const unregister = register(listener);
  async function* gen(): AsyncGenerator<T> {
    try {
      while (true) {
        if (queue.length > 0) yield queue.shift()!;
        else await new Promise<void>((res) => { notify = res; });
      }
    } finally {
      unregister();
    }
  }
  return gen();
}

if (isOracleContext) {
  registerService('busSubscribe', async function* (params) {
    const { topic } = params as { topic: string };
    yield* makeQueueGenerator<unknown>((listener) => {
      let subs = _topics.get(topic);
      if (!subs) { subs = new Set(); _topics.set(topic, subs); }
      subs.add(listener);
      return () => {
        const s = _topics.get(topic);
        if (!s) return;
        s.delete(listener);
        if (s.size === 0) _topics.delete(topic);
      };
    });
  });

  registerService('busPublish', async function* (params) {
    const { topic, payload } = params as { topic: string; payload: unknown };
    const subs = _topics.get(topic);
    if (subs) for (const fn of subs) fn.push(payload);
    // Yield nothing — caller awaits one .next() to confirm delivery.
  });

  // Register / unregister are fire-and-forget. The earlier "suspend the
  // factory until the consumer cancels" version got stuck whenever the
  // panel was closed via the dock tab × — `acquireSharedStream`'s abort
  // signal can't break a forever-await inside a factory generator, so the
  // finally block never ran and the singleton flag stayed "open" forever.
  // Splitting into two one-shot calls dodges the issue entirely.
  registerService('quickPricerRegister', async function* (params) {
    const { instanceId } = params as { instanceId: string };
    if (!_quickPricerInstances.has(instanceId)) {
      _quickPricerInstances.add(instanceId);
      emitStatus();
    }
    yield { ok: true };
  });

  registerService('quickPricerUnregister', async function* (params) {
    const { instanceId } = params as { instanceId: string };
    if (_quickPricerInstances.delete(instanceId)) emitStatus();
    yield { ok: true };
  });

  registerService('quickPricerStatus', async function* () {
    yield* makeQueueGenerator<{ open: boolean }>((listener) => {
      _statusListeners.add(listener);
      // Replay current state immediately so a late subscriber doesn't
      // see stale "no pricer open" until the next change.
      listener.push({ open: _quickPricerInstances.size > 0 });
      return () => { _statusListeners.delete(listener); };
    });
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Client API
// ────────────────────────────────────────────────────────────────────────────

let _publishCounter = 0;
let _registerCounter = 0;
let _statusCounter = 0;

export function busSubscribe<T = unknown>(topic: string): AsyncGenerator<T> {
  return subscribeRemote('busSubscribe', { topic }) as AsyncGenerator<T>;
}

/** Fire-and-forget publish. Resolves once the oracle has fanned out to all
 *  subscribers connected at the time of the call. The unique `_tag` field
 *  prevents the oracle's refcount from collapsing repeated identical
 *  publishes into a single shared (and therefore one-shot) factory call. */
export async function busPublish(topic: string, payload: unknown): Promise<void> {
  const _tag = `${++_publishCounter}-${Date.now()}`;
  const gen = subscribeRemote('busPublish', { topic, payload, _tag }) as AsyncGenerator<unknown>;
  try {
    await gen.next();
  } finally {
    await gen.return(undefined).catch(() => {});
  }
}

/** QuickPricer registration. Call on mount; invoke the returned release on
 *  unmount. Both calls are fire-and-forget one-shots — the oracle holds the
 *  open-instance set, not a long-lived conversation, so the panel can be
 *  closed cleanly via the dock tab × (the previous suspended-await design
 *  leaked the registration when that path was used).
 *  Each call carries a unique `_tag` so the oracle's refcount can't collapse
 *  rapid mount/unmount/mount cycles (StrictMode dev mode) into one. */
export function registerQuickPricer(instanceId: string): () => void {
  fireOneShot('quickPricerRegister', { instanceId });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fireOneShot('quickPricerUnregister', { instanceId });
  };
}

function fireOneShot(service: string, params: Record<string, unknown>): void {
  const _tag = `${++_registerCounter}-${Date.now()}`;
  const gen = subscribeRemote(service, { ...params, _tag }) as AsyncGenerator<unknown>;
  // Best-effort: if the worker is gone or the call rejects, swallow it.
  // Register/unregister are advisory presence pings — the QuickPricer set
  // self-heals when the worker restarts, and dropping a stray unregister
  // worst-case leaves a stale entry that clears on the next page nav.
  (async () => {
    try { await gen.next(); } catch { /* noop */ }
    try { await gen.return(undefined); } catch { /* noop */ }
  })();
}

/** Status stream for the QuickPricer presence flag. Each call carries a
 *  unique `_tag` so the oracle's refcount-based dedup can't collapse multiple
 *  subscribers into a single shared upstream — the factory's "replay current
 *  state on subscribe" only runs the first time a shared key is acquired, so
 *  consumers that join after a presence change (e.g. a second ChainTable that
 *  mounts while QuickPricer is already open) would otherwise miss the
 *  current `{open: true}` and sit forever on the stale `false` default until
 *  the next change. Status events are cheap; per-subscriber upstreams are fine. */
export function quickPricerStatusStream(): AsyncGenerator<{ open: boolean }> {
  const _tag = `${++_statusCounter}-${Date.now()}`;
  return subscribeRemote('quickPricerStatus', { _tag }) as AsyncGenerator<{ open: boolean }>;
}

// ────────────────────────────────────────────────────────────────────────────
// Topic catalog — central enum so consumers don't drift on topic strings.
// ────────────────────────────────────────────────────────────────────────────

export const Topics = {
  quickPricerAddLeg: 'quickPricer.addLeg',
} as const;

export interface AddLegEvent {
  venue: 'deribit';
  instrumentName: string;
  side: 1 | -1;
  qty: 1;
}
