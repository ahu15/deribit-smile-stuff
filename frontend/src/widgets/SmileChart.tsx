import { useEffect, useMemo, useRef, useState } from 'react';
import { registerWidget, type WidgetProps } from '../shell/widgetRegistry';
import { chainStream, fetchExpiries, type ChainSnapshot } from '../worker/chainService';
import {
  fetchHistoricSmile, smileStream,
  type HistoricSmile, type SmileSnapshot,
} from '../worker/smileService';
import { fetchMethodologies, type MethodologySpec } from '../worker/methodologyService';
import { fetchCurveMethods, type CurveMethodSpec } from '../worker/termstructureService';
import { pickClosestExpiry } from '../shared/expiry';

type Currency = 'BTC' | 'ETH';
type Mode = 'live' | 'staleFit';

interface SmileChartConfig {
  venue: 'deribit';
  symbol: Currency;
  expiry: string | null;
  mode: Mode;
  intervalMin?: number;
  // M3.7 — methodology engine plumbing. `methodology` is a registry id (or
  // the legacy alias `sabr-naive`); `termStructure` is the curve method id
  // for freeze-axis methodologies (M3.8). Default keeps M3.6 behavior.
  methodology: string;
  termStructure: string | null;
  // Display toggles. Curve = SABR fit line; mark/bid/ask = per-strike points.
  showCurve: boolean;
  showMark: boolean;
  showBid: boolean;
  showAsk: boolean;
  // Frozen historic SABR fit overlaid on the live curve. The as-of time is
  // intentionally NOT in this config — it lives in component state so that a
  // saved profile always loads with as-of = (mount time − 24h). Persisting
  // the as-of would replay a stale absolute timestamp that's almost always
  // outside the backend's 24h rolling buffer.
  showHistoric: boolean;
  showHistoricMarks: boolean;
  // Optional zoom on the strike axis. null = auto-fit to the data; set to
  // clip the plot to a hand-picked range. Stored in the profile.
  xMin: number | null;
  xMax: number | null;
}

const DEFAULT_CONFIG: SmileChartConfig = {
  venue: 'deribit',
  symbol: 'BTC',
  expiry: null,
  mode: 'live',
  intervalMin: 5,
  // Canonical id, not the `sabr-naive` alias — the alias resolves to this
  // anyway, but using the canonical form means the toolbar dropdown doesn't
  // render two visible entries (alias + catalog) for the same fit.
  methodology: 'sabr_none_uniform_cal',
  termStructure: null,
  showCurve: true,
  showMark: true,
  showBid: false,
  showAsk: false,
  showHistoric: false,
  showHistoricMarks: true,
  xMin: null,
  xMax: null,
};

const DAY_MS = 24 * 60 * 60 * 1000;

const ACCENT: Record<Currency, string> = {
  BTC: '#f7931a',
  ETH: '#8c8cf7',
};

// IV is decimal, displayed at ≥1 dp percent, so 0.001 = 0.1 vol point is the
// smallest visually meaningful move (mirrors ChainTable's IV epsilon).
const IV_EPSILON = 1e-3;

function SmileChart({ config, onConfigChange }: WidgetProps<SmileChartConfig>) {
  const [snap, setSnap] = useState<SmileSnapshot | null>(null);
  const [chainSnap, setChainSnap] = useState<ChainSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expiriesFromHttp, setExpiriesFromHttp] = useState<string[]>([]);
  const [showSettings, setShowSettings] = useState(false);
  const [historic, setHistoric] = useState<HistoricSmile | null>(null);
  const [historicLoading, setHistoricLoading] = useState(false);
  const [methodologies, setMethodologies] = useState<MethodologySpec[]>([]);
  const [curveMethods, setCurveMethods] = useState<CurveMethodSpec[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchMethodologies().then(list => {
      if (!cancelled) setMethodologies(list);
    }).catch(() => {});
    fetchCurveMethods().then(list => {
      if (!cancelled) setCurveMethods(list);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Selected methodology — null until catalog loads. The TS curve is
  // auto-linked to the calibrator's basis: when freeze=alpha-from-ts, the
  // prior comes from `ts_atm_dmr_${basis}`. Keeping curve+calibrator on
  // the same basis is the only well-defined pairing (the prior is sampled
  // in the curve's basis, so a mismatched lookup pairs values with the
  // wrong x-grid). Done as a config sync rather than a derived value so
  // the rest of the pipeline (smileService, historic) stays unchanged.
  const selectedMethodology = methodologies.find(m => m.id === config.methodology) ?? null;
  useEffect(() => {
    if (!selectedMethodology) return;
    if (!selectedMethodology.requires_ts) {
      if (config.termStructure != null) {
        onConfigChange({ ...config, termStructure: null });
      }
      return;
    }
    const expectedTs = `ts_atm_dmr_${selectedMethodology.time_basis}`;
    if (config.termStructure !== expectedTs) {
      onConfigChange({ ...config, termStructure: expectedTs });
    }
  }, [selectedMethodology, config, onConfigChange]);

  // The default as-of is "24h before this widget mounted" — captured once so
  // re-renders don't drift the default forward. The user can override via the
  // settings picker, but that override is intentionally session-local: a
  // persisted absolute timestamp would be stale on the next session anyway
  // (the backend's history buffer is only 24h deep).
  const mountTimeRef = useRef(Date.now());
  const defaultAsOfMs = mountTimeRef.current - DAY_MS;
  const [historicAsOfOverride, setHistoricAsOfOverride] = useState<number | null>(null);
  const effectiveAsOfMs = historicAsOfOverride ?? defaultAsOfMs;

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
        for await (const s of smileStream(
          config.symbol, config.expiry!,
          config.methodology, config.termStructure,
        )) {
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
  }, [config.symbol, config.expiry, config.mode, config.methodology, config.termStructure]);

  // Chain subscription — only when we actually need bid/ask IV. The SABR fit
  // already carries the per-strike mark IV used to seed it, so we don't pay
  // for a second stream just to draw the mark dots. Oracle dedups so this
  // shares one backend conversation with any open ChainTable on the same slice.
  const needChain = config.showBid || config.showAsk;
  useEffect(() => {
    if (!config.expiry || !needChain) {
      setChainSnap(null);
      return;
    }
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const s of chainStream(config.symbol, config.expiry!)) {
          if (ctrl.signal.aborted) break;
          setChainSnap(s);
        }
      } catch {
        // Swallow — bid/ask overlay is optional, smile fit keeps rendering.
      }
    })();
    return () => ctrl.abort();
  }, [config.symbol, config.expiry, needChain]);

  // Historic SABR fit — one-shot, oracle-routed (HRT principle 1: tabs never
  // hit FastAPI directly). Fires whenever as-of moves or the user toggles
  // historic on; the curve is intentionally static between fires.
  useEffect(() => {
    if (!config.expiry || !config.showHistoric) {
      setHistoric(null);
      return;
    }
    let cancelled = false;
    setHistoricLoading(true);
    fetchHistoricSmile(
      config.symbol, config.expiry, effectiveAsOfMs,
      config.methodology, config.termStructure,
    )
      .then(j => { if (!cancelled) setHistoric(j); })
      .catch(() => { if (!cancelled) setHistoric(null); })
      .finally(() => { if (!cancelled) setHistoricLoading(false); });
    return () => { cancelled = true; };
  }, [config.symbol, config.expiry, config.showHistoric, effectiveAsOfMs, config.methodology, config.termStructure]);

  const accent = ACCENT[config.symbol];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg)', color: 'var(--fg)', fontSize: 11, fontFamily: 'var(--font-data)', fontVariantNumeric: 'tabular-nums' }}>
      <Toolbar
        config={config}
        onConfigChange={onConfigChange}
        expiries={expiriesFromHttp}
        methodologies={methodologies}
        curveMethods={curveMethods}
        selectedMethodology={selectedMethodology}
        snap={snap}
        historic={historic}
        historicLoading={historicLoading}
        onToggleSettings={() => setShowSettings(v => !v)}
      />
      {showSettings && (
        <SettingsPanel
          config={config}
          onConfigChange={onConfigChange}
          historic={historic}
          historicAsOfMs={effectiveAsOfMs}
          historicAsOfOverridden={historicAsOfOverride != null}
          onHistoricAsOfChange={setHistoricAsOfOverride}
          onClose={() => setShowSettings(false)}
        />
      )}
      {error ? (
        <div style={{ padding: 12, color: 'var(--neg)' }}>error: {error}</div>
      ) : (
        <SmilePlot
          snap={snap}
          historic={historic}
          chainSnap={
            chainSnap && chainSnap.expiry === config.expiry ? chainSnap : null
          }
          accent={accent}
          config={config}
        />
      )}
    </div>
  );
}

interface ToolbarProps {
  config: SmileChartConfig;
  onConfigChange: (c: SmileChartConfig) => void;
  expiries: string[];
  methodologies: MethodologySpec[];
  curveMethods: CurveMethodSpec[];
  selectedMethodology: MethodologySpec | null;
  snap: SmileSnapshot | null;
  historic: HistoricSmile | null;
  historicLoading: boolean;
  onToggleSettings: () => void;
}

// Axis decomposition: replace one opaque methodology dropdown with three
// orthogonal axis pickers (freeze · weights · basis). The methodology id
// stays the source of truth in the saved config — the toolbar resolves
// (freeze, weights, basis) → id via the catalog.
const FREEZE_LABELS: Record<string, string> = {
  'none': 'free',
  'alpha-from-ts': 'α from TS',
};
const WEIGHTS_LABELS: Record<string, string> = {
  'uniform': 'uniform',
  'atm-manual': 'ATM-manual',
  'bidask-spread': 'bid/ask',
  'bidask-spread-sma': 'bid/ask (SMA)',
};
const BASIS_LABELS: Record<'cal' | 'wkg', string> = { cal: 'cal', wkg: 'wkg' };

function findMethodology(
  methodologies: MethodologySpec[], freeze: string, weights: string, basis: 'cal' | 'wkg',
): MethodologySpec | null {
  return methodologies.find(m =>
    m.freeze === freeze && m.weights === weights && m.time_basis === basis,
  ) ?? null;
}

function Toolbar({
  config, onConfigChange, expiries, methodologies, curveMethods,
  selectedMethodology, snap, historic, historicLoading, onToggleSettings,
}: ToolbarProps) {
  const fit = snap?.fit;

  // Catalog-driven option lists — only show axes the backend actually exposes.
  const freezes = useMemo(
    () => Array.from(new Set(methodologies.map(m => m.freeze))),
    [methodologies],
  );
  const weightsList = useMemo(
    () => Array.from(new Set(methodologies.map(m => m.weights))),
    [methodologies],
  );
  const bases = useMemo(
    () => Array.from(new Set(methodologies.map(m => m.time_basis))) as ('cal' | 'wkg')[],
    [methodologies],
  );

  const setAxis = (
    next: { freeze?: string; weights?: string; basis?: 'cal' | 'wkg' },
  ) => {
    if (!selectedMethodology) return;
    const f = next.freeze ?? selectedMethodology.freeze;
    const w = next.weights ?? selectedMethodology.weights;
    const b = next.basis ?? selectedMethodology.time_basis;
    const found = findMethodology(methodologies, f, w, b);
    if (found) onConfigChange({ ...config, methodology: found.id });
  };

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
      {/* Three orthogonal axis dropdowns. The methodology id is computed
          from (freeze, weights, basis) — single source of truth still
          lives in `config.methodology`, this is purely the picker UI. */}
      <select
        value={selectedMethodology?.freeze ?? ''}
        onChange={e => setAxis({ freeze: e.target.value })}
        style={selectStyle}
        title="freeze axis — what's pinned by the term-structure prior"
        disabled={!selectedMethodology}
      >
        {freezes.map(f => (
          <option key={f} value={f}>{FREEZE_LABELS[f] ?? f}</option>
        ))}
      </select>
      <select
        value={selectedMethodology?.weights ?? ''}
        onChange={e => setAxis({ weights: e.target.value })}
        style={selectStyle}
        title="weights — per-strike weights in the smile fit"
        disabled={!selectedMethodology}
      >
        {weightsList.map(w => (
          <option key={w} value={w}>{WEIGHTS_LABELS[w] ?? w}</option>
        ))}
      </select>
      <select
        value={selectedMethodology?.time_basis ?? ''}
        onChange={e => setAxis({ basis: e.target.value as 'cal' | 'wkg' })}
        style={selectStyle}
        title="time basis — calendar or working-day vol-time"
        disabled={!selectedMethodology}
      >
        {bases.map(b => (
          <option key={b} value={b}>{BASIS_LABELS[b]}</option>
        ))}
      </select>
      {/* TS curve is auto-linked to calibrator basis (single basis decision
          flips both the SABR `t` and the prior). The label is informational
          — switching the basis dropdown flips this automatically. */}
      {selectedMethodology?.requires_ts && config.termStructure && (
        <span
          style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.05em' }}
          title="α prior — auto-linked to calibrator basis"
        >
          prior: {curveMethods.find(m => m.id === config.termStructure)?.label
            ?? config.termStructure}
        </span>
      )}
      <button onClick={onToggleSettings} style={btnStyle}>settings</button>
      <span style={{ color: 'var(--fg-mute)' }}>· live</span>
      {config.showHistoric && (
        <span style={{ color: 'var(--fg-mute)' }}>
          ·{' '}
          <span style={{ color: 'var(--fg-dim)' }}>frozen</span>
          {historicLoading && ' …'}
          {historic?.snapped_ms != null && (
            <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--font-data)' }}>
              {' @ '}{new Date(historic.snapped_ms).toLocaleString()}
            </span>
          )}
          {historic && historic.snapped_ms == null && !historicLoading && (
            <span style={{ color: 'var(--bid)' }}>{' '}(no data)</span>
          )}
        </span>
      )}
      <div style={{ flex: 1 }} />
      {fit && (
        <span style={{ color: 'var(--fg-dim)', fontFamily: 'var(--font-data)' }}>
          α={(fit.params.alpha ?? 0).toFixed(3)} ρ={(fit.params.rho ?? 0).toFixed(3)} ν={(fit.params.volvol ?? 0).toFixed(3)}
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

interface SettingsPanelProps {
  config: SmileChartConfig;
  onConfigChange: (c: SmileChartConfig) => void;
  historic: HistoricSmile | null;
  // As-of state is owned by SmileChart, not the persisted config — it always
  // resets to (mount − 24h) on widget mount, with an in-session override.
  historicAsOfMs: number;
  historicAsOfOverridden: boolean;
  onHistoricAsOfChange: (ms: number | null) => void;
  onClose: () => void;
}

// `<input type="datetime-local">` round-trips through "YYYY-MM-DDTHH:mm" in
// the user's local timezone. Convert ms ↔ that format so React stays the
// owner of the value (no uncontrolled-input drift).
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

function SettingsPanel({ config, onConfigChange, historic, historicAsOfMs, historicAsOfOverridden, onHistoricAsOfChange, onClose }: SettingsPanelProps) {
  const Toggle = (
    key: 'showCurve' | 'showMark' | 'showBid' | 'showAsk' | 'showHistoric' | 'showHistoricMarks',
    label: string, color?: string,
  ) => (
    <label key={key} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' }}>
      <input
        type="checkbox"
        checked={config[key]}
        onChange={() => onConfigChange({ ...config, [key]: !config[key] })}
      />
      <span style={{ color: config[key] ? (color ?? 'var(--fg)') : 'var(--fg-mute)' }}>{label}</span>
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
      {Toggle('showMark', 'mark', 'var(--fg)')}
      {Toggle('showBid', 'bid IV', 'var(--bid)')}
      {Toggle('showAsk', 'ask IV', 'var(--ask)')}
      <span style={{ width: 1, height: 14, background: 'var(--bg-2)', margin: '0 4px' }} />
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>HISTORIC</span>
      {Toggle('showHistoric', 'curve', 'var(--accent)')}
      {Toggle('showHistoricMarks', 'marks', 'var(--fg-dim)')}
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>AS OF</span>
        <input
          type="datetime-local"
          value={msToLocalInputValue(historicAsOfMs)}
          onChange={e => {
            const ms = localInputValueToMs(e.target.value);
            if (ms != null) onHistoricAsOfChange(ms);
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
        onClick={() => onHistoricAsOfChange(null)}
        title="Reset as-of to (mount time − 24h). The as-of is never persisted in the saved profile."
        style={btnStyle}
        disabled={!historicAsOfOverridden}
      >reset</button>
      {historic?.earliest_ms != null && historic?.latest_ms != null && (
        <span style={{ color: 'var(--fg-mute)', fontSize: 10 }}>
          window: {new Date(historic.earliest_ms).toLocaleTimeString()}
          {' – '}{new Date(historic.latest_ms).toLocaleTimeString()}
        </span>
      )}
      <span style={{ width: 1, height: 14, background: 'var(--bg-2)', margin: '0 4px' }} />
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>X RANGE</span>
      <input
        type="number"
        value={config.xMin ?? ''}
        placeholder="min"
        onChange={e => {
          const v = e.target.value;
          const n = v === '' ? null : Number(v);
          if (n != null && !Number.isFinite(n)) return;
          onConfigChange({ ...config, xMin: n });
        }}
        style={numInputStyle}
      />
      <span style={{ color: 'var(--fg-mute)' }}>–</span>
      <input
        type="number"
        value={config.xMax ?? ''}
        placeholder="max"
        onChange={e => {
          const v = e.target.value;
          const n = v === '' ? null : Number(v);
          if (n != null && !Number.isFinite(n)) return;
          onConfigChange({ ...config, xMax: n });
        }}
        style={numInputStyle}
      />
      <button
        onClick={() => onConfigChange({ ...config, xMin: null, xMax: null })}
        title="Clear x-axis range (auto-fit to data)"
        style={btnStyle}
        disabled={config.xMin == null && config.xMax == null}
      >clear</button>
      <div style={{ flex: 1 }} />
      <button onClick={onClose} style={btnStyle}>done</button>
    </div>
  );
}

const numInputStyle: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg-dim)',
  border: '1px solid var(--border)', borderRadius: 3,
  padding: '2px 4px', fontSize: 11, width: 72,
  fontFamily: 'var(--font-data)', fontVariantNumeric: 'tabular-nums',
};

interface PlotProps {
  snap: SmileSnapshot | null;
  chainSnap: ChainSnapshot | null;
  historic: HistoricSmile | null;
  accent: string;
  config: SmileChartConfig;
}

const PAD = { top: 12, right: 16, bottom: 28, left: 48 };

interface PerStrikeQuotes {
  bid: number | null;
  ask: number | null;
}

function buildBidAskMap(chainSnap: ChainSnapshot | null): Map<number, PerStrikeQuotes> {
  const out = new Map<number, PerStrikeQuotes>();
  if (!chainSnap) return out;
  // Same per-strike collapsing rule the backend's smile_fit uses for marks:
  // average across the call/put pair, ignoring missing/zero quotes.
  const acc = new Map<number, { bidVals: number[]; askVals: number[] }>();
  for (const r of chainSnap.rows) {
    const slot = acc.get(r.strike) ?? { bidVals: [], askVals: [] };
    if (r.bid_iv != null && Number.isFinite(r.bid_iv) && r.bid_iv > 0) slot.bidVals.push(r.bid_iv);
    if (r.ask_iv != null && Number.isFinite(r.ask_iv) && r.ask_iv > 0) slot.askVals.push(r.ask_iv);
    acc.set(r.strike, slot);
  }
  for (const [k, v] of acc) {
    const bid = v.bidVals.length ? v.bidVals.reduce((s, x) => s + x, 0) / v.bidVals.length : null;
    const ask = v.askVals.length ? v.askVals.reduce((s, x) => s + x, 0) / v.askVals.length : null;
    out.set(k, { bid, ask });
  }
  return out;
}

function SmilePlot({ snap, chainSnap, historic, accent, config }: PlotProps) {
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
  const histFit = config.showHistoric ? historic?.fit ?? null : null;
  const histPoints = config.showHistoric && config.showHistoricMarks
    ? historic?.market_points ?? []
    : [];
  const innerW = Math.max(0, size.w - PAD.left - PAD.right);
  const innerH = Math.max(0, size.h - PAD.top - PAD.bottom);

  const bidAsk = useMemo(() => buildBidAskMap(chainSnap), [chainSnap]);

  const bounds = useMemo(() => {
    if (!fit) return null;
    // x-range: hand-picked override wins, else auto-fit to the data. We
    // re-derive y from points *within* the x-range so a zoomed view
    // tightens the y-axis to match what's visible (instead of the IV at
    // far OTM strikes squashing the at-the-money region).
    const xs: number[] = [...fit.strikes, ...fit.market_strikes];
    if (histFit) xs.push(...histFit.strikes, ...histFit.market_strikes);
    const autoXmin = xs.length > 0 ? Math.min(...xs) : 0;
    const autoXmax = xs.length > 0 ? Math.max(...xs) : 0;
    const xmin = config.xMin ?? autoXmin;
    const xmax = config.xMax ?? autoXmax;
    if (!Number.isFinite(xmin) || !Number.isFinite(xmax) || xmin >= xmax) {
      return null;
    }
    const inX = (k: number) => k >= xmin && k <= xmax;

    const ys: number[] = [];
    if (config.showCurve) {
      for (let i = 0; i < fit.strikes.length; i++) {
        if (inX(fit.strikes[i])) ys.push(fit.fitted_iv[i]);
      }
    }
    if (config.showMark) {
      for (let i = 0; i < fit.market_strikes.length; i++) {
        if (inX(fit.market_strikes[i])) ys.push(fit.market_iv[i]);
      }
    }
    if (config.showBid || config.showAsk) {
      for (const [k, q] of bidAsk) {
        if (!inX(k)) continue;
        if (config.showBid && q.bid != null) ys.push(q.bid);
        if (config.showAsk && q.ask != null) ys.push(q.ask);
      }
    }
    if (histFit) {
      for (let i = 0; i < histFit.strikes.length; i++) {
        if (inX(histFit.strikes[i])) ys.push(histFit.fitted_iv[i]);
      }
      if (config.showHistoricMarks) {
        for (let i = 0; i < histFit.market_strikes.length; i++) {
          if (inX(histFit.market_strikes[i])) ys.push(histFit.market_iv[i]);
        }
      }
    }
    // Fallback if every layer is toggled off in the picked window — fit's
    // full y range so the plot still draws axes.
    if (ys.length === 0) ys.push(...fit.fitted_iv, ...fit.market_iv);
    if (ys.length === 0) return null;
    const ymin = Math.min(...ys), ymax = Math.max(...ys);
    const yPad = (ymax - ymin) * 0.1 || 0.01;
    return { xmin, xmax, ymin: Math.max(0, ymin - yPad), ymax: ymax + yPad };
  }, [fit, histFit, bidAsk, config.showCurve, config.showMark, config.showBid, config.showAsk, config.showHistoricMarks, config.xMin, config.xMax]);

  const sx = (x: number) => bounds == null
    ? 0
    : PAD.left + ((x - bounds.xmin) / (bounds.xmax - bounds.xmin || 1)) * innerW;
  const sy = (y: number) => bounds == null
    ? 0
    : PAD.top + (1 - (y - bounds.ymin) / (bounds.ymax - bounds.ymin || 1)) * innerH;

  // Path generators clip to bounds.x[min,max] so a zoomed view doesn't bleed
  // the curve outside the axis. Filtering data is enough since the SABR
  // sample grid is dense; we don't need explicit interpolation at the edge.
  const fittedPath = useMemo(() => {
    if (!fit || !bounds) return '';
    let started = false;
    let d = '';
    for (let i = 0; i < fit.strikes.length; i++) {
      const k = fit.strikes[i];
      if (k < bounds.xmin || k > bounds.xmax) { started = false; continue; }
      const x = sx(k), y = sy(fit.fitted_iv[i]);
      d += `${started ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
      started = true;
    }
    return d;
  }, [fit, bounds, innerW, innerH]); // eslint-disable-line react-hooks/exhaustive-deps

  const historicPath = useMemo(() => {
    if (!histFit || !bounds) return '';
    let started = false;
    let d = '';
    for (let i = 0; i < histFit.strikes.length; i++) {
      const k = histFit.strikes[i];
      if (k < bounds.xmin || k > bounds.xmax) { started = false; continue; }
      const x = sx(k), y = sy(histFit.fitted_iv[i]);
      d += `${started ? 'L' : 'M'}${x.toFixed(2)},${y.toFixed(2)} `;
      started = true;
    }
    return d;
  }, [histFit, bounds, innerW, innerH]); // eslint-disable-line react-hooks/exhaustive-deps

  const xTicks = useMemo(() => makeTicks(bounds?.xmin, bounds?.xmax, 6), [bounds]);
  const yTicks = useMemo(() => makeTicks(bounds?.ymin, bounds?.ymax, 5), [bounds]);

  return (
    <div ref={wrapRef} style={{ flex: 1, minHeight: 0, position: 'relative' }}>
      {!fit ? (
        <div style={{ padding: 12, color: 'var(--fg-mute)' }}>
          {snap ? 'no fit (insufficient quotes)' : 'waiting for chain…'}
        </div>
      ) : !bounds ? (
        <div style={{ padding: 12, color: 'var(--fg-mute)' }}>
          x-range is empty (min ≥ max)
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
          {fit.forward >= bounds.xmin && fit.forward <= bounds.xmax && (
            <line
              x1={sx(fit.forward)} y1={PAD.top}
              x2={sx(fit.forward)} y2={size.h - PAD.bottom}
              stroke={`${accent}66`} strokeDasharray="3 3"
            />
          )}
          {/* Historic frozen curve sits behind the live curve so the live
              one always wins visual priority. Dashed in fg-dim to read as
              "reference, not live". */}
          {historicPath && (
            <path
              d={historicPath} fill="none"
              stroke="var(--fg-dim)" strokeWidth={1.25}
              strokeDasharray="4 3"
            />
          )}
          {histPoints.map(p => {
            if (p.strike < bounds.xmin || p.strike > bounds.xmax) return null;
            return (
              <circle
                key={`h-${p.strike}`}
                cx={sx(p.strike)} cy={sy(p.iv)}
                r={2}
                fill="none" stroke="var(--fg-dim)" strokeWidth={1}
              />
            );
          })}
          {config.showCurve && (
            <path d={fittedPath} fill="none" stroke={accent} strokeWidth={1.5} />
          )}
          {config.showMark && fit.market_strikes.map((k, i) => {
            if (k < bounds.xmin || k > bounds.xmax) return null;
            return (
              <FlashCircle
                key={`m-${k}`}
                cx={sx(k)} cy={sy(fit.market_iv[i])}
                value={fit.market_iv[i]}
                baseFill="var(--fg)"
                fillOpacity={0.85}
                r={2.5}
              />
            );
          })}
          {config.showBid && fit.market_strikes.map(k => {
            if (k < bounds.xmin || k > bounds.xmax) return null;
            const v = bidAsk.get(k)?.bid;
            if (v == null) return null;
            return (
              <FlashCircle
                key={`b-${k}`}
                cx={sx(k)} cy={sy(v)}
                value={v}
                baseFill="var(--bid)"
                fillOpacity={0.9}
                r={2.5}
              />
            );
          })}
          {config.showAsk && fit.market_strikes.map(k => {
            if (k < bounds.xmin || k > bounds.xmax) return null;
            const v = bidAsk.get(k)?.ask;
            if (v == null) return null;
            return (
              <FlashCircle
                key={`a-${k}`}
                cx={sx(k)} cy={sy(v)}
                value={v}
                baseFill="var(--ask)"
                fillOpacity={0.9}
                r={2.5}
              />
            );
          })}
        </svg>
      ) : null}
    </div>
  );
}

// Per-strike point with a tick flash on IV moves ≥ IV_EPSILON. Mirrors the
// chain's Cell logic: ref keeps the previous value, first mount sets a
// baseline (no flash), subsequent updates fire a 700 ms WAAPI animation on
// the SVG fill. Same flash tokens (`--flash-up` / `--flash-down`) so colour
// adapts when the user toggles light/dark.
interface FlashCircleProps {
  cx: number;
  cy: number;
  value: number | null | undefined;
  baseFill: string;
  fillOpacity?: number;
  r?: number;
}

function FlashCircle({ cx, cy, value, baseFill, fillOpacity = 1, r = 2.5 }: FlashCircleProps) {
  const ref = useRef<SVGCircleElement>(null);
  const prev = useRef<number | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const p = prev.current;
    if (
      p != null && value != null
      && Number.isFinite(p) && Number.isFinite(value)
      && Math.abs(value - p) >= IV_EPSILON
    ) {
      const cs = getComputedStyle(el);
      const flash = value > p
        ? cs.getPropertyValue('--flash-up').trim()
        : cs.getPropertyValue('--flash-down').trim();
      el.animate(
        [{ fill: flash }, { fill: baseFill }],
        { duration: 700, easing: 'ease-out' },
      );
    }
    prev.current = value ?? null;
  }, [value, baseFill]);

  return (
    <circle
      ref={ref}
      cx={cx} cy={cy} r={r}
      fill={baseFill} fillOpacity={fillOpacity}
    />
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

const btnStyle: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg-mute)', border: '1px solid var(--border)',
  borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11,
  fontFamily: 'var(--font-chrome)',
};

registerWidget<SmileChartConfig>({
  id: 'smileChart',
  title: 'Smile',
  component: SmileChart,
  defaultConfig: DEFAULT_CONFIG,
  configVersion: 7,
  // v1 → no display toggles. v2 → curve/mark/bid/ask toggles. v3 → adds
  // historic-fit toggles. v4 → adds xMin/xMax strike-axis zoom. v5 → drops
  // historicAsOfMs from the saved config (session-only state). v6 → adds
  // methodology + termStructure (M3.7). v7 → drops volvol-and-alpha-from-ts
  // freeze axis (collapses to alpha-from-ts) and renames the curve method
  // family from ts_alpha_dmr_*/ts_atm_linear_dmr_* to ts_atm_dmr_*.
  migrate: (_fromVersion, oldConfig) => {
    if (!oldConfig || typeof oldConfig !== 'object') return DEFAULT_CONFIG;
    const o = oldConfig as Partial<SmileChartConfig>;
    let methodology = o.methodology ?? DEFAULT_CONFIG.methodology;
    if (methodology === 'sabr-naive') methodology = DEFAULT_CONFIG.methodology;
    // Retired freeze axis: collapse to alpha-from-ts, keeping weights+basis.
    methodology = methodology.replace(
      'sabr_volvol-and-alpha-from-ts_', 'sabr_alpha-from-ts_',
    );
    // Curve method renames.
    const tsRenames: Record<string, string> = {
      'ts_alpha_dmr_cal': 'ts_atm_dmr_cal',
      'ts_alpha_dmr_wkg': 'ts_atm_dmr_wkg',
      'ts_atm_linear_dmr_cal': 'ts_atm_dmr_cal',
      'ts_atm_linear_dmr_wkg': 'ts_atm_dmr_wkg',
    };
    const ts = o.termStructure;
    const termStructure = ts && tsRenames[ts] ? tsRenames[ts] : ts ?? null;
    return {
      venue: 'deribit',
      symbol: (o.symbol as Currency) ?? DEFAULT_CONFIG.symbol,
      expiry: o.expiry ?? null,
      mode: o.mode ?? DEFAULT_CONFIG.mode,
      intervalMin: o.intervalMin ?? DEFAULT_CONFIG.intervalMin,
      methodology,
      termStructure,
      showCurve: o.showCurve ?? true,
      showMark: o.showMark ?? true,
      showBid: o.showBid ?? false,
      showAsk: o.showAsk ?? false,
      showHistoric: o.showHistoric ?? false,
      showHistoricMarks: o.showHistoricMarks ?? true,
      xMin: o.xMin ?? null,
      xMax: o.xMax ?? null,
    };
  },
  accentColor: ACCENT.BTC,
});
