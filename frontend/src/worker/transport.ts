// Wire protocol between tabs (clients) and the SharedWorker (oracle).
// Conversations are identified by a stable id; clients can cancel by sending
// `unsubscribe` with the same id.

export type ClientToOracle =
  | { conversationId: string; type: 'subscribe'; service: string; params?: unknown }
  | { conversationId: string; type: 'unsubscribe' }
  | { conversationId: string; type: 'ping'; payload?: unknown };

export type OracleToClient =
  | { conversationId: string; type: 'data'; payload: unknown }
  | { conversationId: string; type: 'error'; message: string }
  | { conversationId: string; type: 'complete' }
  | { conversationId: string; type: 'pong'; payload?: unknown }
  | { type: 'backend_connected' }
  | { type: 'backend_disconnected' };

export interface BackendEnvelope {
  type: string;
  data?: unknown;
  id?: string | number;
  error?: string;
  // Set on conversation-scoped envelopes (history/trades subscriptions).
  conversationId?: string;
}
