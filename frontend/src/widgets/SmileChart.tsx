import { useEffect, useMemo, useRef, useState } from 'react';
import { registerWidget, type WidgetProps } from '../shell/widgetRegistry';
import { fetchExpiries } from '../worker/chainService';
import { smileStream, type SmileSnapshot } from '../worker/smileService';

type Currency = 'BTC' | 'ETH';
type Mode = 'live' | 'staleFit';

interface SmileChartConfig {
  venue: 'deribit';
  symbol: Currency;
  expiry: string | null;
  mode: Mode;
  intervalMin?: number;
}

const DEFAULT_CONFIG: SmileChartConfig = {
  venue: 'deribit',
  symbol: 'BTC',
  expiry: null,
  mode: 'live',
  intervalMin: 5,
};

const ACCENT: Record<Currency, string> = {
  BTC: '#f7931a',
  ETH: '#8c8cf7',
};

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

function parseExpiryMs(token: string): number | null {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(token);
  if (!m) return null;
  const day = Number(m[1]);
  const mon = MONTHS[m[2]];
  if (mon == null) return null;
  return Date.UTC(2000 + Number(m[3]), mon, day, 8, 0, 0);
}

// See ChainTable for the rationale — saved expiries can roll off, fall back to
// the chronologically nearest remaining token instead of leaving an empty plot.
function pickClosestExpiry(saved: string | null | undefined, list: string[]): string | null {
  if (list.length === 0) return null;
  if (!saved) return list[0];
  const savedMs = parseExpiryMs(saved);
  if (savedMs == null) return list[0];
  let best = list[0];
  let bestDiff = Infinity;
  for (const e of list) {
    const ms = parseExpiryMs(e);
    if (ms == null) continue;
    const diff = Math.abs(ms - savedMs);
    if (diff < bestDiff) { bestDiff = diff; best = e; }
  }
  return best;
}

function SmileChart({ config, onConfigChange }: WidgetProps<SmileChartConfig>) {
  const [snap, setSnap] = useState<SmileSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expiriesFromHttp, setExpiriesFromHttp] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchExpiries(config.symbol).then(list => {
      if (!cancelled) setExpiriesFromHttp(list);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [config.symbol]);

  // Resolve `config.expiry` against the currently-listed expiries:
  //   • null → front-month
  //   • not in list (rolled off in a saved profile) → closest-in-time match,
  //     so we recover gracefully without trampling the rest of the config
  //   • valid → leave alone
  useEffect(() => {
    if (expiriesFromHttp.length === 0) return;
    if (config.expiry && expiriesFromHttp.includes(config.expiry)) return;
    const next = pickClosestExpiry(config.expiry, expiriesFromHttp);
    if (next && next !== config.expiry) onConfigChange({ ...config, expiry: next });
  }, [config, expiriesFromHttp, onConfigChange]);

  useEffect(() => {
    if (!config.expiry) return;
    if (config.mode !== 'live') return;       // M3.5 will add staleFit
    const ctrl = new AbortController();
    setError(null);
    (async () => {
      try {
        for await (const s of smileStream(config.symbol, config.expiry!)) {
          if (ctrl.signal.aborted) break;
          setSnap(s);
        }
      } catch (err) {
        if (!ctrl.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => ctrl.abort();
  }, [config.symbol, config.expiry, config.mode]);

  const accent = ACCENT[config.symbol];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)', color: 'var(--fg)', fontSize: 11, fontFamily: 'var(--font-data)', fontVariantNumeric: 'tabular-nums' }}>
      <Toolbar
        config={config}
        onConfigChange={onConfigChange}
        expiries={expiriesFromHttp}
        snap={snap}
      />
      {error ? (
        <div style={{ padding: 12, color: 'var(--neg)' }}>error: {error}</div>
      ) : (
        <SmilePlot snap={snap} accent={accent} />
      )}
    </div>
  );
}

interface ToolbarProps {
  config: SmileChartConfig;
  onConfigChange: (c: SmileChartConfig) => void;
  expiries: string[];
  snap: SmileSnapshot | null;
}

function Toolbar({ config, onConfigChange, expiries, snap }: ToolbarProps) {
  const fit = snap?.fit;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 8px', borderBottom: '1px solid var(--border)',
      flexShrink: 0, fontFamily: 'var(--font-chrome)', background: 'var(--bg-1)',
    }}>
      <select
        value={config.symbol}
        onChange={e => onConfigChange({ ...config, symbol: e.target.value as Currency, expiry: null })}
        style={selectStyle}
      >
        <option value="BTC">BTC</option>
        <option value="ETH">ETH</option>
      </select>
      <select
        value={config.expiry ?? ''}
        onChange={e => onConfigChange({ ...config, expiry: e.target.value || null })}
        style={selectStyle}
      >
        {expiries.length === 0 && <option value="">(loading…)</option>}
        {expiries.map(e => <option key={e} value={e}>{e}</option>)}
      </select>
      <span style={{ color: 'var(--fg-mute)' }}>· live</span>
      <div style={{ flex: 1 }} />
      {fit && (
        <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--font-data)' }}>
          α={fit.alpha.toFixed(3)} ρ={fit.rho.toFixed(3)} ν={fit.volvol.toFixed(3)}
          {' · '}F={fit.forward.toFixed(2)}{' · '}T={fit.t_years.toFixed(3)}y
          {' · '}rms={(fit.residual_rms * 100).toFixed(2)}%
        </span>
      )}
      {snap && !fit && (
        <span style={{ color: 'var(--bid)' }}>insufficient quotes for fit</span>
      )}
      {snap && (
        <span style={{ color: 'var(--fg-mute)', fontFamily: 'var(--font-data)' }}>
          {new Date(snap.timestamp_ms).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}

interface PlotProps {
  snap: SmileSnapshot | null;
  accent: string;
}

const PAD = { top: 12, right: 16, bottom: 28, left: 48 };

function SmilePlot({ snap, accent }: PlotProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const { fit } = snap ?? {};
  const innerW = Math.max(0, size.w - PAD.left - PAD.right);
  const innerH = Math.max(0, size.h - PAD.top - PAD.bottom);

  const bounds = useMemo(() => {
    if (!fit) return null;
    const xs = [...fit.strikes, ...fit.market_strikes];
    const ys = [...fit.fitted_iv, ...fit.market_iv];
    if (xs.length === 0 || ys.length === 0) return null;
    const xmin = Math.min(...xs), xmax = Math.max(...xs);
    const ymin = Math.min(...ys), ymax = Math.max(...ys);
    const yPad = (ymax - ymin) * 0.1 || 0.01;
    return { xmin, xmax, ymin: Math.max(0, ymin - yPad), ymax: ymax + yPad };
  }, [fit]);

  const sx = (x: number) => bounds == null
    ? 0
    : PAD.left + ((x - bounds.xmin) / (bounds.xmax - bounds.xmin || 1)) * innerW;
  const sy = (y: number) => bounds == null
    ? 0
    : PAD.top + (1 - (y - bounds.ymin) / (bounds.ymax - bounds.ymin || 1)) * innerH;

  const fittedPath = useMemo(() => {
    if (!fit || !bounds) return '';
    return fit.strikes.map((k, i) => {
      const x = sx(k), y = sy(fit.fitted_iv[i]);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ');
  }, [fit, bounds, innerW, innerH]); // eslint-disable-line react-hooks/exhaustive-deps

  const xTicks = useMemo(() => makeTicks(bounds?.xmin, bounds?.xmax, 6), [bounds]);
  const yTicks = useMemo(() => makeTicks(bounds?.ymin, bounds?.ymax, 5), [bounds]);

  return (
    <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      {!fit ? (
        <div style={{ padding: 12, color: 'var(--fg-mute)' }}>
          {snap ? 'no fit (insufficient quotes)' : 'waiting for chain…'}
        </div>
      ) : size.w > 0 && size.h > 0 ? (
        <svg width={size.w} height={size.h} style={{ display: 'block' }}>
          {yTicks.map(t => (
            <line key={`yg-${t}`}
              x1={PAD.left} y1={sy(t)} x2={size.w - PAD.right} y2={sy(t)}
              stroke="var(--bg-2)" strokeWidth={1}
            />
          ))}
          <line x1={PAD.left} y1={size.h - PAD.bottom} x2={size.w - PAD.right} y2={size.h - PAD.bottom} stroke="var(--border)" />
          <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={size.h - PAD.bottom} stroke="var(--border)" />
          {xTicks.map(t => (
            <text key={`xl-${t}`} x={sx(t)} y={size.h - PAD.bottom + 14}
              fontSize={10} fill="var(--fg-mute)" textAnchor="middle">
              {abbreviate(t)}
            </text>
          ))}
          {yTicks.map(t => (
            <text key={`yl-${t}`} x={PAD.left - 6} y={sy(t) + 3}
              fontSize={10} fill="var(--fg-mute)" textAnchor="end">
              {(t * 100).toFixed(0)}%
            </text>
          ))}
          <line
            x1={sx(fit.forward)} y1={PAD.top}
            x2={sx(fit.forward)} y2={size.h - PAD.bottom}
            stroke={`${accent}66`} strokeDasharray="3 3"
          />
          <path d={fittedPath} fill="none" stroke={accent} strokeWidth={1.5} />
          {fit.market_strikes.map((k, i) => (
            <circle
              key={k}
              cx={sx(k)} cy={sy(fit.market_iv[i])}
              r={2.5}
              fill="var(--fg)" fillOpacity={0.85}
            />
          ))}
        </svg>
      ) : null}
    </div>
  );
}

function makeTicks(lo: number | undefined, hi: number | undefined, n: number): number[] {
  if (lo == null || hi == null || !Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [];
  const step = (hi - lo) / n;
  return Array.from({ length: n + 1 }, (_, i) => lo + i * step);
}

function abbreviate(n: number): string {
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(0)}K`;
  return n.toFixed(0);
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg-dim)', border: '1px solid var(--border)',
  borderRadius: 3, padding: '2px 6px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'var(--font-chrome)',
};

registerWidget<SmileChartConfig>({
  id: 'smileChart',
  title: 'Smile',
  component: SmileChart,
  defaultConfig: DEFAULT_CONFIG,
  configVersion: 1,
  accentColor: ACCENT.BTC,
});
