import { useEffect, useMemo, useRef, useState } from 'react';
import { registerWidget, type WidgetProps } from '../shell/widgetRegistry';
import {
  fetchCurveMethods, fetchHistoricTermStructure, termStructureStream,
  type CurveMethodSpec, type HistoricTermStructure, type TermStructureEnvelope,
  type TermStructureSnapshot,
} from '../worker/termstructureService';
import {
  termStructureBucketsStream, type TsBucketEntry,
} from '../worker/bucketsService';
import {
  COMPARE_PALETTE, COMPARE_CAP, CLAMP_WARN_MS, formatRelativeTime,
} from '../shared/overlayUi';
import { useCurrencyAccent, DEFAULT_BTC_ACCENT } from '../shared/currencyAccent';

// M3.8 — live term-structure plot. Method dropdown comes from the curve
// catalog; x-axis toggles cal/wkg time; y-axis toggles σ_atm | α | fwd-var.
// Frozen overlay mirrors SmileChart's pattern: as-of is session-local,
// not persisted, defaulting to (mount − 24h).

type Currency = 'BTC' | 'ETH';
type XAxis = 'cal' | 'wkg';
type YAxis = 'atm_vol' | 'alpha' | 'fwd_var' | 'total_var';

interface TermStructureChartConfig {
  venue: 'deribit';
  symbol: Currency;
  method: string;
  xAxis: XAxis;
  yAxis: YAxis;
  showCurve: boolean;
  showMarkers: boolean;
  showHistoric: boolean;
  showHistoricMarks: boolean;
  // M3.9 — overlay last N hourly-bucket TS curves behind live, color-faded
  // by age. 0 = off; bounded at 24 (HistoryStore cap).
  historyOverlayHours: number;
  // M3.9 — list of TS curve methods to render as live overlays alongside
  // the primary. Capped at 4. Cross-currency comparisons aren't supported
  // here (the widget binds to a single currency).
  compareMethods: string[];
  configVersion: number;
}

const DEFAULT_CONFIG: TermStructureChartConfig = {
  venue: 'deribit',
  symbol: 'BTC',
  method: 'ts_atm_dmr_cal',
  xAxis: 'cal',
  yAxis: 'atm_vol',
  showCurve: true,
  showMarkers: true,
  showHistoric: false,
  showHistoricMarks: true,
  historyOverlayHours: 0,
  compareMethods: [],
  configVersion: 4,
};

const DAY_MS = 24 * 60 * 60 * 1000;

const Y_LABELS: Record<YAxis, string> = {
  atm_vol: 'σ ATM',
  alpha: 'α',
  fwd_var: 'fwd variance',
  total_var: 'total variance (σ²·t)',
};

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

function pickGrid(snap: TermStructureSnapshot, xAxis: XAxis): number[] {
  return xAxis === 'wkg' ? snap.t_years_wkg_grid : snap.t_years_cal_grid;
}

function pickYGrid(snap: TermStructureSnapshot, yAxis: YAxis): number[] {
  if (yAxis === 'alpha') return snap.alpha_grid;
  if (yAxis === 'fwd_var') return snap.fwd_var_grid;
  if (yAxis === 'total_var') {
    // Total variance lives in cal-time integration space — w(t) = σ²·t — so
    // we always anchor on the cal grid (matches what the DMR fit integrates).
    return snap.atm_vol_grid.map((v, i) => v * v * snap.t_years_cal_grid[i]);
  }
  return snap.atm_vol_grid;
}

interface MarketPoints {
  xs: number[];
  ys: number[];
  labels: string[];      // expiry strings (or "midpoint i↔i+1" for fwd-var)
}

function pickMarket(
  snap: TermStructureSnapshot, xAxis: XAxis, yAxis: YAxis,
): MarketPoints {
  if (yAxis === 'fwd_var') {
    const xs = xAxis === 'wkg'
      ? snap.market_fwd_var_t_wkg : snap.market_fwd_var_t_cal;
    const labels = snap.market_expiries.map((ex, i) =>
      i === 0 ? `< ${ex}` : `${snap.market_expiries[i - 1]} → ${ex}`);
    return { xs, ys: snap.market_fwd_var, labels };
  }
  const xs = xAxis === 'wkg' ? snap.market_t_wkg : snap.market_t_cal;
  let ys: number[];
  if (yAxis === 'alpha') ys = snap.market_atm_vol;          // β=1 ⇒ α≈σ_ATM
  else if (yAxis === 'total_var') {
    ys = snap.market_atm_vol.map((v, i) => v * v * snap.market_t_cal[i]);
  } else ys = snap.market_atm_vol;
  return { xs, ys, labels: snap.market_expiries };
}

function TermStructureChart({ config, onConfigChange }: WidgetProps<TermStructureChartConfig>) {
  const [env, setEnv] = useState<TermStructureEnvelope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [methods, setMethods] = useState<CurveMethodSpec[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [historic, setHistoric] = useState<HistoricTermStructure | null>(null);
  const [historicLoading, setHistoricLoading] = useState(false);
  // M3.9 hourly-bucket overlay state.
  const [historyBuckets, setHistoryBuckets] = useState<TsBucketEntry[]>([]);
  // M3.9 cross-method overlays — one TS envelope per active comparison.
  const [compareEnvs, setCompareEnvs] = useState<Record<string, TermStructureEnvelope>>({});

  const mountTimeRef = useRef(Date.now());
  const defaultAsOfMs = mountTimeRef.current - DAY_MS;
  const [asOfOverride, setAsOfOverride] = useState<number | null>(null);
  const effectiveAsOfMs = asOfOverride ?? defaultAsOfMs;

  useEffect(() => {
    let cancelled = false;
    fetchCurveMethods().then(list => {
      if (!cancelled) setMethods(list);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // If the configured method isn't in the catalog (e.g. stale saved profile),
  // fall back to the first available — preserves the rest of the config.
  useEffect(() => {
    if (methods.length === 0) return;
    if (methods.some(m => m.id === config.method)) return;
    onConfigChange({ ...config, method: methods[0].id });
  }, [methods, config, onConfigChange]);

  useEffect(() => {
    if (!config.method) return;
    const ctrl = new AbortController();
    setError(null);
    (async () => {
      try {
        for await (const e of termStructureStream(config.symbol, config.method)) {
          if (ctrl.signal.aborted) break;
          setEnv(e);
        }
      } catch (err) {
        if (!ctrl.signal.aborted) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => ctrl.abort();
  }, [config.symbol, config.method]);

  // M3.9 hourly-bucket overlay subscription. Mirrors SmileChart's pattern:
  // initial snapshot replaces, append replaces head if same bucket_ts else
  // pushes a new entry. Skip the most recent on render — it's redundant
  // with the live curve.
  useEffect(() => {
    if (!config.method || config.historyOverlayHours <= 0) {
      setHistoryBuckets([]);
      return;
    }
    // Clear stale buckets synchronously on every effect run so a method /
    // currency switch doesn't leave the previous selection's curves in
    // state until the first new snapshot arrives — old wkg-axis bucket
    // data mixed with the new live curve was producing broken bounds.
    setHistoryBuckets([]);
    const ctrl = new AbortController();
    const lookbackMs = config.historyOverlayHours * 60 * 60 * 1000;
    (async () => {
      try {
        for await (const env of termStructureBucketsStream(
          config.symbol, config.method, lookbackMs,
        )) {
          if (ctrl.signal.aborted) break;
          if (env.kind === 'snapshot') {
            setHistoryBuckets(env.buckets);
          } else {
            setHistoryBuckets(prev => {
              const last = prev[prev.length - 1];
              const next = { bucket_ts: env.bucket_ts, snapshot: env.snapshot };
              if (last && last.bucket_ts === env.bucket_ts) {
                return [...prev.slice(0, -1), next];
              }
              return [...prev, next];
            });
          }
        }
      } catch {
        // Overlay is optional — failure shouldn't crash the chart.
      }
    })();
    return () => ctrl.abort();
  }, [config.symbol, config.method, config.historyOverlayHours]);

  // M3.9 — cross-method comparison subscriptions. Open one
  // termStructureStream per id; oracle dedup ensures other widgets on the
  // same key share the upstream conversation (HRT principle 1).
  useEffect(() => {
    if (config.compareMethods.length === 0) {
      setCompareEnvs({});
      return;
    }
    const ids = config.compareMethods.slice(0, COMPARE_CAP);
    const ctrls: AbortController[] = [];
    setCompareEnvs({});
    for (const id of ids) {
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      (async () => {
        try {
          for await (const e of termStructureStream(config.symbol, id)) {
            if (ctrl.signal.aborted) break;
            setCompareEnvs(prev => ({ ...prev, [id]: e }));
          }
        } catch {
          // Comparison overlays are optional.
        }
      })();
    }
    return () => { for (const c of ctrls) c.abort(); };
  }, [config.symbol, config.compareMethods]);

  useEffect(() => {
    if (!config.method || !config.showHistoric) {
      setHistoric(null);
      return;
    }
    let cancelled = false;
    setHistoricLoading(true);
    fetchHistoricTermStructure(config.symbol, config.method, effectiveAsOfMs)
      .then(j => { if (!cancelled) setHistoric(j); })
      .catch(() => { if (!cancelled) setHistoric(null); })
      .finally(() => { if (!cancelled) setHistoricLoading(false); });
    return () => { cancelled = true; };
  }, [config.symbol, config.method, config.showHistoric, effectiveAsOfMs]);

  const accent = useCurrencyAccent(config.symbol);

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg)', color: 'var(--fg)',
      fontSize: 11, fontFamily: 'var(--font-data)',
      fontVariantNumeric: 'tabular-nums',
    }}>
      <Toolbar
        config={config}
        onConfigChange={onConfigChange}
        methods={methods}
        env={env}
        historic={historic}
        historicLoading={historicLoading}
        requestedAsOfMs={effectiveAsOfMs}
        onToggleSettings={() => setShowSettings(v => !v)}
      />
      {showSettings && (
        <SettingsPanel
          config={config}
          onConfigChange={onConfigChange}
          methods={methods}
          historic={historic}
          asOfMs={effectiveAsOfMs}
          asOfOverridden={asOfOverride != null}
          onAsOfChange={setAsOfOverride}
          onClose={() => setShowSettings(false)}
        />
      )}
      {error ? (
        <div style={{ padding: 12, color: 'var(--neg)' }}>error: {error}</div>
      ) : (
        <Plot
          env={env}
          historic={historic}
          historyBuckets={historyBuckets}
          compareEnvs={compareEnvs}
          methods={methods}
          accent={accent}
          config={config}
        />
      )}
    </div>
  );
}

// ---------- toolbar ----------

interface ToolbarProps {
  config: TermStructureChartConfig;
  onConfigChange: (c: TermStructureChartConfig) => void;
  methods: CurveMethodSpec[];
  env: TermStructureEnvelope | null;
  historic: HistoricTermStructure | null;
  historicLoading: boolean;
  requestedAsOfMs: number;
  onToggleSettings: () => void;
}

function Toolbar({
  config, onConfigChange, methods, env, historic, historicLoading,
  requestedAsOfMs, onToggleSettings,
}: ToolbarProps) {
  const snap = env?.snapshot;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 8px', borderBottom: '1px solid var(--border)',
      flexShrink: 0, fontFamily: 'var(--font-chrome)', background: 'var(--bg-1)',
    }}>
      <select
        value={config.symbol}
        onChange={e => onConfigChange({ ...config, symbol: e.target.value as Currency })}
        style={selectStyle}
      >
        <option value="BTC">BTC</option>
        <option value="ETH">ETH</option>
      </select>
      <select
        value={config.method}
        onChange={e => onConfigChange({ ...config, method: e.target.value })}
        style={selectStyle}
        title="term-structure curve method"
      >
        {!methods.some(m => m.id === config.method) && (
          <option value={config.method}>{config.method}</option>
        )}
        {methods.map(m => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
      <select
        value={config.xAxis}
        onChange={e => onConfigChange({ ...config, xAxis: e.target.value as XAxis })}
        style={selectStyle}
        title="x-axis basis"
      >
        <option value="cal">x: cal</option>
        <option value="wkg">x: wkg</option>
      </select>
      <select
        value={config.yAxis}
        onChange={e => onConfigChange({ ...config, yAxis: e.target.value as YAxis })}
        style={selectStyle}
        title="y-axis quantity"
      >
        <option value="atm_vol">y: σ ATM</option>
        <option value="alpha">y: α</option>
        <option value="fwd_var">y: fwd variance</option>
        <option value="total_var">y: total variance</option>
      </select>
      <button onClick={onToggleSettings} style={btnStyle}>settings</button>
      <span style={{ color: 'var(--fg-mute)' }}>· live</span>
      {config.showHistoric && (
        <span style={{ color: 'var(--fg-mute)' }}>
          ·{' '}
          <span style={{ color: 'var(--fg-dim)' }}>frozen</span>
          {historicLoading && ' …'}
          {historic?.snapped_ms != null && (
            <span
              style={{ color: 'var(--fg-dim)', fontFamily: 'var(--font-data)' }}
              title={`snapped @ ${new Date(historic.snapped_ms).toLocaleString()}\n`
                   + `requested @ ${new Date(requestedAsOfMs).toLocaleString()}`}
            >
              {' @ '}{formatRelativeTime(historic.snapped_ms, Date.now())}
            </span>
          )}
          {historic?.snapped_ms != null
           && Math.abs(requestedAsOfMs - historic.snapped_ms) > CLAMP_WARN_MS && (
            <span
              style={{ color: 'var(--neg)', marginLeft: 4, fontFamily: 'var(--font-data)' }}
              title={`Request was outside the data buffer — clamped.\n`
                   + `Requested ${formatRelativeTime(requestedAsOfMs, Date.now())}, `
                   + `actual ${formatRelativeTime(historic.snapped_ms, Date.now())}.\n`
                   + `Buffer fills as the backend runs (24h cap).`}
            >(clamped)</span>
          )}
          {historic && historic.snapped_ms == null && !historicLoading && (
            <span style={{ color: 'var(--bid)' }}>{' '}(no data)</span>
          )}
        </span>
      )}
      <div style={{ flex: 1 }} />
      {snap && (
        <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--font-data)' }}>
          {Object.entries(snap.params).map(([k, v]) => (
            <span key={k} style={{ marginLeft: 6 }}>{k}={Number(v).toFixed(3)}</span>
          ))}
          {' · '}rms={(snap.rmse * 100).toFixed(2)}%
        </span>
      )}
      {env && !snap && (
        <span style={{ color: 'var(--bid)' }}>insufficient expiries for fit</span>
      )}
      {env && (
        <span style={{ color: 'var(--fg-mute)', fontFamily: 'var(--font-data)' }}>
          {new Date(env.timestamp_ms).toLocaleTimeString()}
        </span>
      )}
    </div>
  );
}

// ---------- settings panel ----------

interface SettingsPanelProps {
  config: TermStructureChartConfig;
  onConfigChange: (c: TermStructureChartConfig) => void;
  methods: CurveMethodSpec[];
  historic: HistoricTermStructure | null;
  asOfMs: number;
  asOfOverridden: boolean;
  onAsOfChange: (ms: number | null) => void;
  onClose: () => void;
}

function msToLocalInputValue(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function localInputValueToMs(v: string): number | null {
  if (!v) return null;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function SettingsPanel({
  config, onConfigChange, methods, historic, asOfMs, asOfOverridden, onAsOfChange, onClose,
}: SettingsPanelProps) {
  const compareIds = config.compareMethods;
  const toggleCompare = (id: string) => {
    if (id === config.method) return;
    const has = compareIds.includes(id);
    let next = has ? compareIds.filter(x => x !== id) : [...compareIds, id];
    next = next.slice(-COMPARE_CAP);
    onConfigChange({ ...config, compareMethods: next });
  };
  const Toggle = (
    key: 'showCurve' | 'showMarkers' | 'showHistoric' | 'showHistoricMarks',
    label: string,
  ) => (
    <label key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' }}>
      <input
        type="checkbox"
        checked={config[key]}
        onChange={() => onConfigChange({ ...config, [key]: !config[key] })}
      />
      <span style={{ color: config[key] ? 'var(--fg)' : 'var(--fg-mute)' }}>{label}</span>
    </label>
  );
  return (
    <div style={{
      padding: '6px 10px', borderBottom: '1px solid var(--bg-2)',
      background: 'var(--bg-1)', display: 'flex', flexWrap: 'wrap', gap: 10,
      alignItems: 'center', fontFamily: 'var(--font-chrome)',
    }}>
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>SHOW</span>
      {Toggle('showCurve', 'curve')}
      {Toggle('showMarkers', 'market dots')}
      <span style={{ width: 1, height: 14, background: 'var(--bg-2)', margin: '0 4px' }} />
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>HISTORIC</span>
      {Toggle('showHistoric', 'overlay')}
      {Toggle('showHistoricMarks', 'marks')}
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>AS OF</span>
        <input
          type="datetime-local"
          value={msToLocalInputValue(asOfMs)}
          onChange={e => {
            const ms = localInputValueToMs(e.target.value);
            if (ms != null) onAsOfChange(ms);
          }}
          disabled={!config.showHistoric}
          style={{
            background: 'var(--bg)', color: 'var(--fg-dim)',
            border: '1px solid var(--border)', borderRadius: 3,
            padding: '2px 4px', fontSize: 11, fontFamily: 'var(--font-chrome)',
          }}
        />
      </label>
      <button
        onClick={() => onAsOfChange(null)}
        title="Reset as-of to (mount time − 24h). The as-of is never persisted in the saved profile."
        style={btnStyle}
        disabled={!asOfOverridden}
      >reset</button>
      {historic?.earliest_ms != null && historic?.latest_ms != null && (
        <span style={{ color: 'var(--fg-mute)', fontSize: 10 }}>
          window: {new Date(historic.earliest_ms).toLocaleTimeString()}
          {' – '}{new Date(historic.latest_ms).toLocaleTimeString()}
        </span>
      )}
      <span style={{ width: 1, height: 14, background: 'var(--bg-2)', margin: '0 4px' }} />
      <span
        style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}
        title="Show last N hourly-bucket TS curves behind the live one, faded by age"
      >HISTORY</span>
      <select
        value={config.historyOverlayHours}
        onChange={e => onConfigChange({
          ...config,
          historyOverlayHours: Number(e.target.value),
        })}
        style={selectStyle}
      >
        <option value={0}>off</option>
        <option value={3}>last 3h</option>
        <option value={6}>last 6h</option>
        <option value={12}>last 12h</option>
        <option value={24}>last 24h</option>
      </select>
      <span style={{ width: 1, height: 14, background: 'var(--bg-2)', margin: '0 4px' }} />
      <span
        style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}
        title={`Cross-method overlays (max ${COMPARE_CAP}). Primary method always plots; toggle other methods to overlay them.`}
      >COMPARE</span>
      {methods.length === 0 ? (
        <span style={{ color: 'var(--fg-mute)' }}>(loading…)</span>
      ) : (
        <details style={{ position: 'relative' }}>
          <summary style={{ ...btnStyle, listStyle: 'none', cursor: 'pointer', display: 'inline-block' }}>
            {compareIds.length === 0 ? 'pick…' : `${compareIds.length} selected`}
          </summary>
          <div style={{
            position: 'absolute', top: '100%', left: 0,
            background: 'var(--bg-1)', border: '1px solid var(--border)',
            borderRadius: 3, padding: 6, zIndex: 10, minWidth: 220,
            maxHeight: 220, overflowY: 'auto',
          }}>
            {methods.map(m => {
              const checked = compareIds.includes(m.id);
              const isPrimary = m.id === config.method;
              const colorIdx = compareIds.indexOf(m.id);
              const swatch = colorIdx >= 0 ? COMPARE_PALETTE[colorIdx % COMPARE_PALETTE.length] : null;
              return (
                <label
                  key={m.id}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    padding: '2px 0', cursor: isPrimary ? 'default' : 'pointer',
                    opacity: isPrimary ? 0.4 : 1,
                  }}
                  title={isPrimary ? 'this is the primary method' : m.id}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isPrimary || (!checked && compareIds.length >= COMPARE_CAP)}
                    onChange={() => toggleCompare(m.id)}
                  />
                  {swatch && <span style={{ width: 10, height: 2, background: swatch, display: 'inline-block' }} />}
                  <span style={{ color: 'var(--fg)', fontSize: 11 }}>{m.label}</span>
                  {isPrimary && <span style={{ color: 'var(--fg-mute)', fontSize: 10 }}> (primary)</span>}
                </label>
              );
            })}
          </div>
        </details>
      )}
      <button
        onClick={() => onConfigChange({ ...config, compareMethods: [] })}
        style={btnStyle}
        disabled={compareIds.length === 0}
        title="Clear comparison overlays"
      >clear</button>
      <div style={{ flex: 1 }} />
      <button onClick={onClose} style={btnStyle}>done</button>
    </div>
  );
}

// ---------- plot ----------

interface PlotProps {
  env: TermStructureEnvelope | null;
  historic: HistoricTermStructure | null;
  historyBuckets: TsBucketEntry[];
  compareEnvs: Record<string, TermStructureEnvelope>;
  methods: CurveMethodSpec[];
  accent: string;
  config: TermStructureChartConfig;
}

const PAD = { top: 12, right: 16, bottom: 28, left: 56 };

// Long-end of the curve (≥ ~1.25y) is essentially DMR's parametric tail with
// no market anchors at typical Deribit chains — clip the visible window so
// the front, where the action lives, isn't squeezed into a third of the plot.
// Applied uniformly across cal/wkg axes; the stored snapshot still contains
// the full grid so methodology consumers see the full tenor range.
const X_CAP_YEARS = 1.25;

function Plot({ env, historic, historyBuckets, compareEnvs, methods, accent, config }: PlotProps) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [cursorX, setCursorX] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const snap = env?.snapshot ?? null;
  const histSnap = config.showHistoric ? historic?.snapshot ?? null : null;
  const snapTsMs = env?.timestamp_ms ?? null;

  const innerW = Math.max(0, size.w - PAD.left - PAD.right);
  const innerH = Math.max(0, size.h - PAD.top - PAD.bottom);

  const market = useMemo(
    () => (snap ? pickMarket(snap, config.xAxis, config.yAxis) : null),
    [snap, config.xAxis, config.yAxis],
  );
  const histMarket = useMemo(
    () => (histSnap ? pickMarket(histSnap, config.xAxis, config.yAxis) : null),
    [histSnap, config.xAxis, config.yAxis],
  );

  const bounds = useMemo(() => {
    if (!snap) return null;
    // Y-range is derived from points within the visible x window so the y-axis
    // tightens to what's actually drawn — same trick as SmileChart's xMin/xMax.
    const inX = (x: number) => x <= X_CAP_YEARS;
    const xs: number[] = [];
    const ys: number[] = [];
    const pushSeries = (xSeries: number[], ySeries: number[]) => {
      for (let i = 0; i < xSeries.length; i++) {
        if (!inX(xSeries[i])) continue;
        xs.push(xSeries[i]);
        ys.push(ySeries[i]);
      }
    };
    pushSeries(pickGrid(snap, config.xAxis), pickYGrid(snap, config.yAxis));
    if (config.showMarkers && market) pushSeries(market.xs, market.ys);
    if (histSnap) {
      pushSeries(pickGrid(histSnap, config.xAxis), pickYGrid(histSnap, config.yAxis));
      if (config.showHistoricMarks && histMarket) pushSeries(histMarket.xs, histMarket.ys);
    }
    if (config.historyOverlayHours > 0) {
      // Skip head — already covered by the live curve.
      for (let h = 0; h < historyBuckets.length - 1; h++) {
        const s = historyBuckets[h].snapshot;
        if (!s) continue;
        pushSeries(pickGrid(s, config.xAxis), pickYGrid(s, config.yAxis));
      }
    }
    for (const id of config.compareMethods) {
      const ce = compareEnvs[id];
      if (!ce?.snapshot) continue;
      pushSeries(pickGrid(ce.snapshot, config.xAxis), pickYGrid(ce.snapshot, config.yAxis));
    }
    if (xs.length === 0 || ys.length === 0) return null;
    const xmin = Math.min(...xs);
    const xmax = Math.min(Math.max(...xs), X_CAP_YEARS);
    const ymin = Math.min(...ys);
    const ymax = Math.max(...ys);
    if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || xmin >= xmax) return null;
    const yPad = (ymax - ymin) * 0.1 || 0.01;
    return { xmin, xmax, ymin: Math.max(0, ymin - yPad), ymax: ymax + yPad };
  }, [snap, histSnap, historyBuckets, compareEnvs, market, histMarket, config.xAxis, config.yAxis, config.showMarkers, config.showHistoricMarks, config.historyOverlayHours, config.compareMethods]);

  const sx = (x: number) => bounds == null
    ? 0
    : PAD.left + ((x - bounds.xmin) / (bounds.xmax - bounds.xmin || 1)) * innerW;
  const sy = (y: number) => bounds == null
    ? 0
    : PAD.top + (1 - (y - bounds.ymin) / (bounds.ymax - bounds.ymin || 1)) * innerH;

  // All path generators clip to bounds.xmax (the visible cap) so the cropped
  // long-end doesn't paint outside the axis. Grid is monotone in x so a
  // simple early-break is sufficient — no need to break + restart subpaths.
  const buildPath = (xs: number[], ys: number[]): string => {
    if (!bounds) return '';
    let d = '';
    let started = false;
    for (let i = 0; i < xs.length; i++) {
      if (xs[i] > bounds.xmax) break;
      d += `${started ? 'L' : 'M'}${sx(xs[i]).toFixed(2)},${sy(ys[i]).toFixed(2)} `;
      started = true;
    }
    return d;
  };

  const path = useMemo(() => {
    if (!snap || !bounds) return '';
    return buildPath(pickGrid(snap, config.xAxis), pickYGrid(snap, config.yAxis));
  }, [snap, bounds, config.xAxis, config.yAxis]); // eslint-disable-line react-hooks/exhaustive-deps

  const histPath = useMemo(() => {
    if (!histSnap || !bounds) return '';
    return buildPath(pickGrid(histSnap, config.xAxis), pickYGrid(histSnap, config.yAxis));
  }, [histSnap, bounds, config.xAxis, config.yAxis]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hourly-bucket overlay paths — drop the head (visually identical to the
  // live curve) and any null-snapshot entries (cold history at session
  // start). Age-based alpha so the most recent overlay reads strongest.
  const overlayCurves = useMemo(() => {
    if (!bounds || config.historyOverlayHours <= 0) return [];
    const trimmed = historyBuckets.slice(0, -1).filter(b => b.snapshot != null);
    if (trimmed.length === 0) return [];
    return trimmed.map((b, i, arr) => {
      const s = b.snapshot as TermStructureSnapshot;
      const d = buildPath(pickGrid(s, config.xAxis), pickYGrid(s, config.yAxis));
      const t = arr.length === 1 ? 0.5 : i / (arr.length - 1);
      const opacity = 0.15 + 0.50 * t;
      return { d, opacity, bucket_ts: b.bucket_ts };
    });
  }, [historyBuckets, bounds, config.xAxis, config.yAxis, config.historyOverlayHours]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cross-method comparison curves — solid 1px lines in palette colors.
  // Filter out the primary so a stale saved profile that listed it
  // doesn't render the same curve twice.
  const compareCurves = useMemo(() => {
    if (!bounds || config.compareMethods.length === 0) return [];
    const ids = config.compareMethods
      .filter(id => id !== config.method)
      .slice(0, COMPARE_CAP);
    return ids.map((id, i) => {
      const ce = compareEnvs[id];
      const s = ce?.snapshot;
      if (!s) return null;
      const d = buildPath(pickGrid(s, config.xAxis), pickYGrid(s, config.yAxis));
      const label = methods.find(m => m.id === id)?.label ?? id;
      return { id, d, color: COMPARE_PALETTE[i % COMPARE_PALETTE.length], label };
    }).filter((x): x is { id: string; d: string; color: string; label: string } => x !== null);
  }, [compareEnvs, methods, bounds, config.method, config.compareMethods, config.xAxis, config.yAxis]); // eslint-disable-line react-hooks/exhaustive-deps

  const xTicks = useMemo(() => makeTicks(bounds?.xmin, bounds?.xmax, 6), [bounds]);
  const yTicks = useMemo(() => makeTicks(bounds?.ymin, bounds?.ymax, 5), [bounds]);

  return (
    <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      {!snap ? (
        <div style={{ padding: 12, color: 'var(--fg-mute)' }}>
          {env ? 'no fit (insufficient expiries)' : 'waiting for chain…'}
        </div>
      ) : !bounds ? (
        <div style={{ padding: 12, color: 'var(--fg-mute)' }}>empty axis range</div>
      ) : size.w > 0 && size.h > 0 ? (
        <svg
          ref={svgRef}
          width={size.w} height={size.h}
          style={{ display: 'block' }}
          onMouseMove={e => {
            const rect = svgRef.current?.getBoundingClientRect();
            if (!rect) return;
            const x = e.clientX - rect.left;
            if (x >= PAD.left && x <= size.w - PAD.right) setCursorX(x);
            else setCursorX(null);
          }}
          onMouseLeave={() => setCursorX(null)}
        >
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
              {t.toFixed(2)}y
            </text>
          ))}
          {yTicks.map(t => (
            <text key={`yl-${t}`} x={PAD.left - 6} y={sy(t) + 3}
              fontSize={10} fill="var(--fg-mute)" textAnchor="end">
              {formatY(t, config.yAxis)}
            </text>
          ))}
          <text x={PAD.left + 4} y={PAD.top + 12}
            fontSize={10} fill="var(--fg-mute)">{Y_LABELS[config.yAxis]}</text>
          {histPath && (
            <path
              d={histPath} fill="none"
              stroke="var(--fg-dim)" strokeWidth={1.25}
              strokeDasharray="4 3"
            />
          )}
          {/* Hourly-bucket overlays — theme-adaptive `--fg` (black on
              light, white on dark) drawn dotted so they read as
              "historic reference" against the colored live curve. */}
          {overlayCurves.map(c => (
            <path
              key={`b-${c.bucket_ts}`}
              d={c.d} fill="none"
              stroke="var(--fg)" strokeOpacity={c.opacity}
              strokeWidth={1} strokeDasharray="1 3"
            />
          ))}
          {/* Cross-method comparison curves — palette-colored solid lines. */}
          {compareCurves.map(c => (
            <path
              key={`c-${c.id}`}
              d={c.d} fill="none"
              stroke={c.color} strokeWidth={1}
              strokeOpacity={0.85}
            />
          ))}
          {config.showCurve && (
            <path d={path} fill="none" stroke={accent} strokeWidth={1.5} />
          )}
          {compareCurves.length > 0 && (
            <g pointerEvents="none">
              {[
                {
                  color: accent,
                  label: methods.find(m => m.id === config.method)?.label ?? config.method,
                },
                ...compareCurves.map(c => ({ color: c.color, label: c.label })),
              ].map((row, idx) => (
                <g
                  key={`leg-${idx}`}
                  transform={`translate(${size.w - PAD.right - 200}, ${PAD.top + 4 + idx * 12})`}
                >
                  <line x1={0} y1={5} x2={14} y2={5} stroke={row.color} strokeWidth={2} />
                  <text x={18} y={8} fontSize={10} fill="var(--fg-dim)">{row.label}</text>
                </g>
              ))}
            </g>
          )}
          {config.showMarkers && market && market.xs.map((x, i) => {
            if (x > bounds.xmax) return null;
            const expiryMs = snapTsMs != null
              ? snapTsMs + snap.market_t_cal[i] * YEAR_MS
              : null;
            const ex = market.labels[i] ?? '';
            const dateLabel = expiryMs != null
              ? new Date(expiryMs).toLocaleDateString(undefined, {
                  year: 'numeric', month: 'short', day: '2-digit',
                })
              : '';
            return (
              <circle
                key={`m-${i}`}
                cx={sx(x)} cy={sy(market.ys[i])}
                r={2.5} fill="var(--fg)" fillOpacity={0.85}
              >
                <title>{`${ex}${dateLabel ? ` · ${dateLabel}` : ''}\n` +
                  `t_cal=${snap.market_t_cal[i].toFixed(4)}y  ` +
                  `t_wkg=${snap.market_t_wkg[i].toFixed(4)}y\n` +
                  `${Y_LABELS[config.yAxis]}=${formatY(market.ys[i], config.yAxis)}`}</title>
              </circle>
            );
          })}
          {/* Historic market dots — dimmer hollow rings to read as
              "frozen reference" against the live solid markers. */}
          {config.showHistoric && config.showHistoricMarks && histSnap && histMarket
            && histMarket.xs.map((x, i) => {
              if (x > bounds.xmax) return null;
              const ex = histMarket.labels[i] ?? '';
              return (
                <circle
                  key={`hm-${i}`}
                  cx={sx(x)} cy={sy(histMarket.ys[i])}
                  r={2.5} fill="none"
                  stroke="var(--fg-dim)" strokeWidth={1}
                >
                  <title>{`${ex} · historic\n` +
                    `t_cal=${histSnap.market_t_cal[i].toFixed(4)}y  ` +
                    `t_wkg=${histSnap.market_t_wkg[i].toFixed(4)}y\n` +
                    `${Y_LABELS[config.yAxis]}=${formatY(histMarket.ys[i], config.yAxis)}`}</title>
                </circle>
              );
            })}
          <HoverOverlay
            cursorX={cursorX}
            snap={snap}
            snapTsMs={snapTsMs}
            config={config}
            sx={sx} sy={sy}
            dataXMax={bounds.xmax}
            xMax={size.w - PAD.right}
            yTop={PAD.top}
            yBot={size.h - PAD.bottom}
            accent={accent}
          />
        </svg>
      ) : null}
    </div>
  );
}

interface HoverOverlayProps {
  cursorX: number | null;
  snap: TermStructureSnapshot;
  snapTsMs: number | null;
  config: TermStructureChartConfig;
  sx: (x: number) => number;
  sy: (y: number) => number;
  dataXMax: number;
  xMax: number;
  yTop: number;
  yBot: number;
  accent: string;
}

function HoverOverlay({
  cursorX, snap, snapTsMs, config, sx, sy, dataXMax, xMax, yTop, yBot, accent,
}: HoverOverlayProps) {
  if (cursorX == null) return null;
  const xs = pickGrid(snap, config.xAxis);
  const ys = pickYGrid(snap, config.yAxis);
  if (xs.length === 0) return null;
  // Nearest grid index by screen x — restrict to the visible window so a
  // clipped long-end point can't win when hovering near the right edge.
  let bestI = -1;
  let bestDx = Infinity;
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] > dataXMax) break;
    const dx = Math.abs(sx(xs[i]) - cursorX);
    if (dx < bestDx) { bestDx = dx; bestI = i; }
  }
  if (bestI < 0) return null;
  const tCal = snap.t_years_cal_grid[bestI];
  const tWkg = snap.t_years_wkg_grid[bestI];
  const xPx = sx(xs[bestI]);
  const yPx = sy(ys[bestI]);
  const date = snapTsMs != null
    ? new Date(snapTsMs + tCal * YEAR_MS).toLocaleDateString(undefined, {
        year: 'numeric', month: 'short', day: '2-digit',
      })
    : '';
  // Tooltip box flips left of cursor when too close to right edge.
  const boxW = 170;
  const boxH = 60;
  const flip = xPx + boxW + 12 > xMax;
  const boxX = flip ? xPx - boxW - 8 : xPx + 8;
  const boxY = Math.max(yTop + 2, Math.min(yPx - boxH - 8, yBot - boxH - 4));
  return (
    <g pointerEvents="none">
      <line
        x1={xPx} x2={xPx} y1={yTop} y2={yBot}
        stroke="var(--fg-dim)" strokeWidth={0.75} strokeDasharray="3 3"
      />
      <circle cx={xPx} cy={yPx} r={3.5} fill={accent} stroke="var(--bg)" strokeWidth={1} />
      <rect
        x={boxX} y={boxY} width={boxW} height={boxH} rx={3}
        fill="var(--bg-1)" stroke="var(--border)" strokeWidth={1}
        opacity={0.96}
      />
      <text x={boxX + 6} y={boxY + 14} fontSize={10} fill="var(--fg)">
        {date || `t_cal=${tCal.toFixed(4)}y`}
      </text>
      <text x={boxX + 6} y={boxY + 28} fontSize={10} fill="var(--fg-dim)">
        cal {tCal.toFixed(4)}y · wkg {tWkg.toFixed(4)}y
      </text>
      <text x={boxX + 6} y={boxY + 44} fontSize={10} fill="var(--fg-dim)">
        {Y_LABELS[config.yAxis]} = {formatY(ys[bestI], config.yAxis)}
      </text>
    </g>
  );
}

function makeTicks(lo: number | undefined, hi: number | undefined, n: number): number[] {
  if (lo == null || hi == null || !Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) return [];
  const step = (hi - lo) / n;
  return Array.from({ length: n + 1 }, (_, i) => lo + i * step);
}

function formatY(v: number, yAxis: YAxis): string {
  if (yAxis === 'fwd_var') return v.toFixed(4);
  if (yAxis === 'total_var') return v.toFixed(4);
  return `${(v * 100).toFixed(1)}%`;
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg-dim)', border: '1px solid var(--border)',
  borderRadius: 3, padding: '2px 6px', fontSize: 11, cursor: 'pointer',
  fontFamily: 'var(--font-chrome)',
};

const btnStyle: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg-mute)', border: '1px solid var(--border)',
  borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11,
  fontFamily: 'var(--font-chrome)',
};

// v1 → original. v2 → curve method renames (ts_alpha_dmr_*/ts_atm_linear_dmr_*
// → ts_atm_dmr_*) and drop volvol_grid/atm-curve picker noise; also adds
// `historyOverlayHours` (M3.9, default off — backwards compatible).
// v3 → adds `compareMethods` (M3.9, default empty).
// v4 → adds `showHistoricMarks` (default true) so historic-overlay dots
// match SmileChart's behavior; previous saved profiles get the toggle on.
const CURVE_METHOD_RENAMES: Record<string, string> = {
  'ts_alpha_dmr_cal': 'ts_atm_dmr_cal',
  'ts_alpha_dmr_wkg': 'ts_atm_dmr_wkg',
  'ts_atm_linear_dmr_cal': 'ts_atm_dmr_cal',
  'ts_atm_linear_dmr_wkg': 'ts_atm_dmr_wkg',
};

registerWidget<TermStructureChartConfig>({
  id: 'termStructureChart',
  title: 'Term Structure',
  formatTitle: c => c?.symbol ? `Term Structure ${c.symbol}` : 'Term Structure',
  component: TermStructureChart,
  defaultConfig: DEFAULT_CONFIG,
  configVersion: 4,
  migrate: (_fromVersion, oldConfig) => {
    if (!oldConfig || typeof oldConfig !== 'object') return DEFAULT_CONFIG;
    const o = oldConfig as Partial<TermStructureChartConfig>;
    const m = o.method;
    const method = m && CURVE_METHOD_RENAMES[m]
      ? CURVE_METHOD_RENAMES[m]
      : m ?? DEFAULT_CONFIG.method;
    const compareMethods = Array.isArray(o.compareMethods)
      ? o.compareMethods.filter(x => typeof x === 'string').slice(0, COMPARE_CAP)
      : [];
    const showHistoricMarks = typeof o.showHistoricMarks === 'boolean'
      ? o.showHistoricMarks
      : DEFAULT_CONFIG.showHistoricMarks;
    return { ...DEFAULT_CONFIG, ...o, method, compareMethods, showHistoricMarks };
  },
  accentColor: DEFAULT_BTC_ACCENT,
});
