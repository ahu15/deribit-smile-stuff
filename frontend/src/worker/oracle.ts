/// <reference lib="webworker" />
// Oracle — runs inside a SharedWorker (or DedicatedWorker fallback).
// Connects once to the backend WS, fans out to subscribed clients with refcount dedup.

import type { BackendEnvelope, ClientToOracle, OracleToClient } from './transport';
import { acquireSharedStream } from './hrtWorker';

// Register dual-mode services so they're available to subscribeRemote calls.
import './pingService';
import './chainService';
import './rateLimitService';
import './historyService';
import './smileService';
import './busService';
import './calendarService';
import './methodologyService';
import './termstructureService';

const BACKEND_WS = 'ws://localhost:8000/ws/oracle';

// ---------- backend connection ----------

let backendWs: WebSocket | null = null;
let backendReady: Promise<void> = new Promise(() => {});
let resolveReady: (() => void) | null = null;
const backendListeners = new Set<(env: BackendEnvelope) => void>();
const pendingPings = new Map<string, (env: BackendEnvelope) => void>();
// Active backend conversations — needed so we can re-send their subscribe
// messages whenever the WS reconnects (e.g. after a backend restart). Without
// this, every open chain/smile/history stream silently hangs forever after the
// reconnect because the new socket has no record of the old subscription.
const activeConversations = new Map<string, { type: string } & Record<string, unknown>>();

function connectBackend() {
  backendWs = new WebSocket(BACKEND_WS);
  backendReady = new Promise((res) => {
    resolveReady = res;
  });

  backendWs.onopen = () => {
    resolveReady?.();
    broadcastSystem({ type: 'backend_connected' });
    // Replay every still-open conversation. Each `backendConversation` keeps
    // its conversationId stable for its lifetime, so the consumer's queue
    // and listener don't need to be rewired — just re-arm the backend side.
    for (const [conversationId, msg] of activeConversations) {
      try {
        backendWs!.send(JSON.stringify({ ...msg, conversationId }));
      } catch {
        // The next reconnect cycle will retry; nothing else to do here.
      }
    }
  };

  backendWs.onmessage = (evt: MessageEvent<string>) => {
    let env: BackendEnvelope;
    try {
      env = JSON.parse(evt.data);
    } catch {
      return;
    }
    // Resolve pending ping replies by id
    if (env.type === 'pong' && env.id != null && pendingPings.has(String(env.id))) {
      pendingPings.get(String(env.id))?.(env);
      pendingPings.delete(String(env.id));
      return;
    }
    for (const fn of backendListeners) fn(env);
  };

  backendWs.onerror = () => {};

  backendWs.onclose = () => {
    backendWs = null;
    broadcastSystem({ type: 'backend_disconnected' });
    setTimeout(connectBackend, 3000);
  };
}

export function backendStream(typeFilter: string): AsyncGenerator<unknown> {
  const queue: unknown[] = [];
  let notify: (() => void) | null = null;

  const fn = (env: BackendEnvelope) => {
    if (env.type === typeFilter) {
      queue.push(env.data);
      notify?.();
      notify = null;
    }
  };
  backendListeners.add(fn);

  // Cleanup runs when the consumer calls .return() on the generator
  // (or breaks out of a for-await). The spec interrupts the suspended
  // await so the finally block executes and the listener is removed.
  async function* gen() {
    try {
      while (true) {
        if (queue.length > 0) yield queue.shift()!;
        else await new Promise<void>((res) => { notify = res; });
      }
    } finally {
      backendListeners.delete(fn);
    }
  }
  return gen();
}

let _pingId = 0;
let _convCounter = 0;

/** Open a backend-side conversation. Sends the subscribe message tagged with a
 *  generated `conversationId`, yields every backend envelope tagged with that id,
 *  and on cancellation sends `{type:'unsubscribe', conversationId}`.
 *
 *  Used by per-instrument history/trades streams; the chain and rate-limit
 *  envelopes remain broadcast (no conversationId) and use `backendStream` instead.
 */
export async function* backendConversation(
  subscribeMsg: { type: string } & Record<string, unknown>,
): AsyncGenerator<BackendEnvelope> {
  await backendReady;
  if (!backendWs) throw new Error('backend not connected');

  const conversationId = `bk-${++_convCounter}-${Date.now()}`;
  const queue: BackendEnvelope[] = [];
  let notify: (() => void) | null = null;

  const fn = (env: BackendEnvelope) => {
    if (env.conversationId === conversationId) {
      queue.push(env);
      notify?.();
      notify = null;
    }
  };
  backendListeners.add(fn);

  // Record before sending so a reconnect that fires between send + receipt
  // will replay this conversation rather than skip it.
  activeConversations.set(conversationId, subscribeMsg);
  backendWs.send(JSON.stringify({ ...subscribeMsg, conversationId }));

  try {
    while (true) {
      if (queue.length > 0) yield queue.shift()!;
      else await new Promise<void>((res) => { notify = res; });
    }
  } finally {
    backendListeners.delete(fn);
    activeConversations.delete(conversationId);
    if (backendWs?.readyState === WebSocket.OPEN) {
      backendWs.send(JSON.stringify({ type: 'unsubscribe', conversationId }));
    }
  }
}

export async function backendPing(payload?: unknown): Promise<BackendEnvelope> {
  await backendReady;
  if (!backendWs) throw new Error('backend not connected');
  const id = `o-${++_pingId}`;
  const replyP = new Promise<BackendEnvelope>((resolve, reject) => {
    pendingPings.set(id, resolve);
    setTimeout(() => {
      if (pendingPings.has(id)) {
        pendingPings.delete(id);
        reject(new Error('backend ping timeout'));
      }
    }, 10_000);
  });
  backendWs.send(JSON.stringify({ type: 'ping', id, payload }));
  return replyP;
}

// ---------- client port handling ----------

interface ClientSub {
  port: MessagePort;
  conversationId: string;
  release?: () => void;
}

const subs = new Map<string, ClientSub>(); // conversationId -> sub
const ports = new Set<MessagePort>();

function broadcastSystem(msg: OracleToClient) {
  for (const port of ports) port.postMessage(msg);
}

function send(port: MessagePort, msg: OracleToClient) {
  port.postMessage(msg);
}

async function handleSubscribe(port: MessagePort, msg: ClientToOracle & { type: 'subscribe' }) {
  const factory = (await import('./hrtWorker')).getService(msg.service);
  if (!factory) {
    send(port, { conversationId: msg.conversationId, type: 'error', message: `unknown service: ${msg.service}` });
    return;
  }

  const release = acquireSharedStream(msg.service, msg.params, factory, {
    onPayload: (payload) => send(port, { conversationId: msg.conversationId, type: 'data', payload }),
    onError: (message) => send(port, { conversationId: msg.conversationId, type: 'error', message }),
    onComplete: () => send(port, { conversationId: msg.conversationId, type: 'complete' }),
  });

  subs.set(msg.conversationId, { port, conversationId: msg.conversationId, release });
}

async function handlePing(port: MessagePort, msg: ClientToOracle & { type: 'ping' }) {
  try {
    const env = await backendPing(msg.payload);
    send(port, { conversationId: msg.conversationId, type: 'pong', payload: env.data });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    send(port, { conversationId: msg.conversationId, type: 'error', message });
  }
}

function handleUnsubscribe(msg: ClientToOracle & { type: 'unsubscribe' }) {
  const sub = subs.get(msg.conversationId);
  sub?.release?.();
  subs.delete(msg.conversationId);
}

function setupPort(port: MessagePort) {
  ports.add(port);
  port.onmessage = async (e: MessageEvent) => {
    const msg = e.data as ClientToOracle;
    if (msg.type === 'subscribe') await handleSubscribe(port, msg);
    else if (msg.type === 'unsubscribe') handleUnsubscribe(msg);
    else if (msg.type === 'ping') await handlePing(port, msg);
  };
  port.start?.();
}

// ---------- mode-specific bootstrap ----------

const isShared = typeof (self as unknown as { onconnect?: unknown }).onconnect !== 'undefined'
  || typeof (globalThis as Record<string, unknown>).SharedWorkerGlobalScope !== 'undefined';

if (isShared) {
  (self as unknown as SharedWorkerGlobalScope).onconnect = (evt: MessageEvent) => {
    setupPort(evt.ports[0]);
  };
} else {
  // DedicatedWorker — self IS the message channel.
  setupPort(self as unknown as MessagePort);
}

connectBackend();
