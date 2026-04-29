import { useEffect, useState } from 'react';
import { rateLimitStream, type RateLimitStatus } from '../worker/rateLimitService';
import { backfillProgressStream, type BackfillProgress } from '../worker/historyService';
import { onSystemMessage } from '../worker/hrtWorker';

export function StatusPill() {
  const [rl, setRl] = useState<RateLimitStatus | null>(null);
  const [bf, setBf] = useState<BackfillProgress | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    return onSystemMessage((msg) => {
      if (msg.type === 'backend_connected') setConnected(true);
      else if (msg.type === 'backend_disconnected') setConnected(false);
    });
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const s of rateLimitStream()) {
          if (ctrl.signal.aborted) break;
          setRl(s);
          setConnected(true);
        }
      } catch {
        setConnected(false);
      }
    })();
    return () => ctrl.abort();
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const p of backfillProgressStream()) {
          if (ctrl.signal.aborted) break;
          setBf(p);
        }
      } catch {
        // backfill stream unavailable — pill just omits the history segment
      }
    })();
    return () => ctrl.abort();
  }, []);

  const fill = rl?.bucket_fill_pct ?? 0;
  const qd = rl?.queue_depth ?? 0;
  const throttledAgo = rl?.last_throttled
    ? Math.round(Date.now() / 1000 - rl.last_throttled)
    : null;

  const dot = !connected ? '#555' : fill > 60 ? '#22c55e' : fill > 20 ? '#f59e0b' : '#ef4444';

  // Show "history: NN%" while running, and a brief "history ✓" once done.
  const showBackfill = bf && bf.state !== 'idle';

  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      padding: '3px 10px', borderRadius: 4,
      background: '#12122a', border: `1px solid ${dot}`,
      fontSize: 11, fontFamily: 'monospace', color: '#aaa',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: dot, flexShrink: 0 }} />
      {connected ? (
        <>
          <span>bucket {fill.toFixed(0)}%</span>
          {qd > 0 && <span style={{ color: '#f59e0b' }}>Q:{qd}</span>}
          {throttledAgo !== null && (
            <span style={{ color: '#ef4444' }}>throttled {throttledAgo}s ago</span>
          )}
          {showBackfill && (
            <span style={{ color: bf.state === 'done' ? '#22c55e' : '#94a3b8' }}>
              · history {bf.state === 'done' ? '✓' : `${bf.pct.toFixed(0)}%`}
            </span>
          )}
        </>
      ) : (
        <span>disconnected</span>
      )}
    </div>
  );
}
