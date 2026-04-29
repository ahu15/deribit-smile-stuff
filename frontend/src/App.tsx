import { useEffect, useState } from 'react';
import { StatusPill } from './components/StatusPill';
import { chainStream, type ChainSnapshot } from './worker/chainService';
import { pingStream, type Ping } from './worker/pingService';

function ChainView() {
  const [snap, setSnap] = useState<ChainSnapshot | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      for await (const s of chainStream()) {
        if (ctrl.signal.aborted) break;
        setSnap(s);
      }
    })();
    return () => ctrl.abort();
  }, []);

  if (!snap) return <p style={{ color: '#555', fontSize: 13 }}>waiting for chain snapshot…</p>;

  const firstMark = Object.values(snap.marks)[0];
  return (
    <div style={{ fontSize: 13 }}>
      <span style={{ color: '#f97316', fontWeight: 600 }}>{snap.currency}</span>
      {' — '}
      {snap.mark_count} instruments
      {' · '}
      {new Date(snap.timestamp_ms).toLocaleTimeString()}
      {firstMark && (
        <span style={{ color: '#888', marginLeft: 12 }}>
          spot {firstMark.underlying_price.toLocaleString(undefined, { maximumFractionDigits: 0 })}
        </span>
      )}
    </div>
  );
}

function PingView() {
  const [ping, setPing] = useState<Ping | null>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const p of pingStream()) {
          if (ctrl.signal.aborted) break;
          setPing(p);
        }
      } catch {
        // backend disconnected — leave last value showing
      }
    })();
    return () => ctrl.abort();
  }, []);

  if (!ping) return <p style={{ color: '#555', fontSize: 11 }}>ping: pending…</p>;

  const skewMs = ping.deribit_ts_ms - ping.client_ts_ms;
  return (
    <div style={{ fontSize: 11, color: '#888', fontFamily: 'monospace' }}>
      ping ✓ rtt={ping.rtt_ms}ms · skew={skewMs > 0 ? '+' : ''}{skewMs}ms
      <span style={{ color: '#555', marginLeft: 8 }}>
        Deribit→backend→oracle→tab @ {new Date(ping.oracle_ts_ms).toLocaleTimeString()}
      </span>
    </div>
  );
}

export default function App() {
  return (
    <div style={{
      minHeight: '100vh', background: '#0f0f1a', color: '#e0e0e0',
      fontFamily: 'ui-monospace, monospace', padding: 24,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
        <span style={{ fontSize: 15, fontWeight: 600 }}>deribit smile</span>
        <StatusPill />
      </div>
      <ChainView />
      <div style={{ marginTop: 12 }}>
        <PingView />
      </div>
    </div>
  );
}
