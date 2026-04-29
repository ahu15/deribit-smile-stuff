/// <reference lib="webworker" />
// HRTWorker base — dual-mode service framework.
//
// One module imported in two contexts:
//   * Oracle context  (inside the SharedWorker): services run; registerService wires
//     a name -> AsyncGenerator factory. The transport layer hands subscribe requests
//     to the matching factory and pipes results to the requesting port.
//   * Client context  (inside a tab): same import, but `subscribeRemote` proxies
//     calls to the oracle via MessagePort and exposes them as AsyncGenerators.
//
// Mode detection is automatic. Graceful fallback: if SharedWorker is unavailable,
// we instantiate a DedicatedWorker per tab — same protocol, no cross-tab dedup.
//
// Refcounted dynamic subscriptions: oracle tracks (service, paramsKey) -> count.
// A duplicate subscribe reuses the upstream stream; the last unsubscribe tears it down.

import type { ClientToOracle, OracleToClient } from './transport';

// ---------- mode detection ----------

export const isOracleContext: boolean =
  typeof (globalThis as Record<string, unknown>).WorkerGlobalScope !== 'undefined' ||
  typeof (globalThis as Record<string, unknown>).SharedWorkerGlobalScope !== 'undefined' ||
  typeof (globalThis as Record<string, unknown>).DedicatedWorkerGlobalScope !== 'undefined';

// ---------- oracle-side service registry ----------

export type ServiceFactory = (params: unknown) => AsyncGenerator<unknown>;

const _services = new Map<string, ServiceFactory>();

export function registerService(name: string, factory: ServiceFactory): void {
  _services.set(name, factory);
}

export function getService(name: string): ServiceFactory | undefined {
  return _services.get(name);
}

// ---------- oracle-side refcount (multi-tab dedup) ----------
//
// When two tabs subscribe to the same (service, paramsKey), we reuse one
// upstream AsyncGenerator and fan out to both subscribers. Drops when the
// last subscriber goes away.

export interface StreamHandlers {
  onPayload: (payload: unknown) => void;
  onError?: (message: string) => void;
  onComplete?: () => void;
}

interface SharedStream {
  refcount: number;
  subscribers: Set<StreamHandlers>;
  abort: AbortController;
}

const _shared = new Map<string, SharedStream>();

function paramsKey(service: string, params: unknown): string {
  return `${service}|${JSON.stringify(params ?? null)}`;
}

export function acquireSharedStream(
  service: string,
  params: unknown,
  factory: ServiceFactory,
  handlers: StreamHandlers,
): () => void {
  const key = paramsKey(service, params);
  let entry = _shared.get(key);
  if (!entry) {
    const abort = new AbortController();
    const subscribers = new Set<StreamHandlers>();
    entry = { refcount: 0, subscribers, abort };
    _shared.set(key, entry);

    (async () => {
      try {
        for await (const item of factory(params)) {
          if (abort.signal.aborted) break;
          for (const sub of subscribers) sub.onPayload(item);
        }
        for (const sub of subscribers) sub.onComplete?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        for (const sub of subscribers) sub.onError?.(message);
      } finally {
        _shared.delete(key);
      }
    })();
  }
  entry.refcount++;
  entry.subscribers.add(handlers);

  return () => {
    const e = _shared.get(key);
    if (!e) return;
    e.subscribers.delete(handlers);
    e.refcount--;
    if (e.refcount <= 0) {
      e.abort.abort();
      _shared.delete(key);
    }
  };
}

// ---------- client-side proxy ----------

let _port: MessagePort | null = null;
let _convCounter = 0;
const _listeners = new Map<string, (msg: OracleToClient) => void>();
const _broadcastListeners = new Set<(msg: OracleToClient) => void>();

function getPort(): MessagePort {
  if (_port) return _port;

  let port: MessagePort | null = null;

  if (typeof SharedWorker !== 'undefined') {
    try {
      const worker = new SharedWorker(new URL('./oracle.ts', import.meta.url), { type: 'module' });
      port = worker.port;
      console.info('[hrtWorker] using SharedWorker');
    } catch (err) {
      console.warn('[hrtWorker] SharedWorker construction failed:', err);
    }
  }

  if (!port) {
    if (typeof Worker === 'undefined') {
      throw new Error('No Worker support in this environment');
    }
    // DedicatedWorker fallback — one worker per tab, no cross-tab dedup.
    const worker = new Worker(new URL('./oracle.ts', import.meta.url), { type: 'module' });
    port = worker as unknown as MessagePort;
    console.warn('[hrtWorker] SharedWorker unavailable — falling back to DedicatedWorker');
  }

  port.onmessage = (evt: MessageEvent) => {
    const msg = evt.data as OracleToClient;
    if ('conversationId' in msg) {
      _listeners.get(msg.conversationId)?.(msg);
    } else {
      for (const fn of _broadcastListeners) fn(msg);
    }
  };
  port.start?.();

  _port = port;
  return port;
}

function nextConversationId(): string {
  return `conv-${++_convCounter}-${Date.now()}`;
}

export async function* subscribeRemote(
  service: string,
  params?: unknown,
): AsyncGenerator<unknown> {
  const port = getPort();
  const conversationId = nextConversationId();

  const queue: unknown[] = [];
  let notify: (() => void) | null = null;
  let done = false;
  let errorMsg: string | null = null;

  _listeners.set(conversationId, (msg) => {
    if (msg.type === 'data') queue.push(msg.payload);
    else if (msg.type === 'complete') done = true;
    else if (msg.type === 'error') {
      errorMsg = msg.message;
      done = true;
    }
    notify?.();
    notify = null;
  });

  port.postMessage({
    conversationId,
    type: 'subscribe',
    service,
    params,
  } satisfies ClientToOracle);

  try {
    while (!done) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        await new Promise<void>((res) => {
          notify = res;
        });
      }
    }
    while (queue.length > 0) yield queue.shift()!;
    if (errorMsg) throw new Error(errorMsg);
  } finally {
    port.postMessage({ conversationId, type: 'unsubscribe' } satisfies ClientToOracle);
    _listeners.delete(conversationId);
  }
}

// Subscribe to system-wide port messages (backend_connected/disconnected).
// Used by status-style components that want to react to oracle state changes.
export function onSystemMessage(fn: (msg: OracleToClient) => void): () => void {
  getPort();   // ensure port is initialised so broadcasts get delivered
  _broadcastListeners.add(fn);
  return () => _broadcastListeners.delete(fn);
}

export async function pingRemote(payload?: unknown): Promise<unknown> {
  const port = getPort();
  const conversationId = nextConversationId();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      _listeners.delete(conversationId);
      reject(new Error('ping timeout'));
    }, 10_000);

    _listeners.set(conversationId, (msg) => {
      if (msg.type === 'pong') {
        clearTimeout(timeout);
        _listeners.delete(conversationId);
        resolve(msg.payload);
      }
    });

    port.postMessage({
      conversationId,
      type: 'ping',
      payload,
    } satisfies ClientToOracle);
  });
}
