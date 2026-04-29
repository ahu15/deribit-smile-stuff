import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { registerWidget, type WidgetProps } from '../shell/widgetRegistry';
import { chainStream, fetchExpiries, type ChainRow, type ChainSnapshot } from '../worker/chainService';

// ─────────────────────────────────────────────────────────────────────────────
// Visual spec — Option Chain Visual Spec.md
//
//   [ Calls cols, reversed ]  [ STRIKE ]  [ Puts cols ]
//
// Same metric = same horizontal distance from the spine on both sides.
// Decimal point is the visual anchor of every numeric column. Tabular figures
// + dim decimals + dim trailing zeros + dim suffixes so magnitude reads first.
// ITM rows shade the per-side cell background (calls below F, puts above F).
// Tick flashes are 700 ms background fades on price change — never text.
// ─────────────────────────────────────────────────────────────────────────────

type Currency = 'BTC' | 'ETH';

type MetricId =
  | 'bid' | 'ask' | 'mark' | 'mid' | 'iv'
  | 'usd_bid' | 'usd_ask' | 'usd_mark'
  | 'spread' | 'spread_bps'
  | 'change_1h' | 'change_24h' | 'change_iv_1h'
  | 'oi' | 'vol_24h';

// Built-in column presets — bid/ask/mark/iv with a unit toggle. Coin-priced
// columns (`bid`/`ask`/`mark`) already read as bps of underlying since
// Deribit quotes options as a fraction of spot, so the "bps" preset just
// reuses them rather than adding a duplicated bp-prefixed column. Both
// presets default to compact density to fit four numeric columns per side
// without horizontal scroll on a typical dock.
const PRESETS: Record<'dollar' | 'bps', { metrics: MetricId[]; density: RowDensity }> = {
  dollar: { metrics: ['usd_bid', 'usd_ask', 'usd_mark', 'iv'], density: 'compact' },
  bps:    { metrics: ['bid', 'ask', 'mark', 'iv'],             density: 'compact' },
};

type RowDensity = 'compact' | 'default' | 'comfortable';

interface ChainTableConfig {
  venue: 'deribit';
  symbol: Currency;
  expiry: string | null;
  // Ordered closest-to-spine first; mirrored on the calls side.
  metrics: MetricId[];
  density: RowDensity;
}

const ACCENT: Record<Currency, string> = { BTC: '#f7931a', ETH: '#8c8cf7' };

// Default order: closest-to-spine = BID, ASK, MARK, IV, $BID, $ASK, Δ24h, OI.
const DEFAULT_METRICS: MetricId[] = [
  'bid', 'ask', 'mark', 'iv', 'usd_bid', 'usd_ask', 'change_24h', 'oi',
];

const DEFAULT_CONFIG: ChainTableConfig = {
  venue: 'deribit',
  symbol: 'BTC',
  expiry: null,
  metrics: DEFAULT_METRICS,
  density: 'default',
};

const ROW_HEIGHT: Record<RowDensity, number> = { compact: 18, default: 22, comfortable: 28 };
const HEADER_HEIGHT = 22;
const STRIKE_WIDTH = 78;

// ─────────────────────────────────────────────────────────────────────────────
// Number formatting components — split a number into integer / decimal / suffix
// so the secondary parts can live at lower foreground levels without breaking
// tabular alignment.
// ─────────────────────────────────────────────────────────────────────────────

interface NumProps {
  value: number | null | undefined;
  decimals: number;
  percent?: boolean;
  signed?: boolean;
  color?: string;
}

function Num({ value, decimals, percent, signed, color }: NumProps): JSX.Element {
  if (value == null || !Number.isFinite(value)) {
    return <span style={{ color: 'var(--fg-mute)' }}>—</span>;
  }
  const v = percent ? value * 100 : value;
  const sign = v < 0 ? '-' : (signed && v > 0 ? '+' : '');
  const abs = Math.abs(v).toFixed(decimals);
  const dotIdx = abs.indexOf('.');
  const intPart = dotIdx >= 0 ? abs.slice(0, dotIdx) : abs;
  const frac = dotIdx >= 0 ? abs.slice(dotIdx + 1) : '';
  const trailingZeros = frac.match(/0+$/)?.[0] ?? '';
  const fracKept = frac.slice(0, frac.length - trailingZeros.length);

  const primary = color ?? 'var(--fg)';
  const dim = 'var(--fg-dim)';
  const mute = 'var(--fg-mute)';

  // Magnitude < 1 (e.g. 0.0035 BTC option marks): the leading "0." is just
  // scaffolding — dim it. Bright the first non-zero digit through the last
  // non-zero digit so the eye lands on the significant figures, not the "0".
  if (intPart === '0' && (fracKept.length > 0 || trailingZeros.length > 0)) {
    const leading = fracKept.match(/^0+/)?.[0] ?? '';
    const significant = fracKept.slice(leading.length);
    return (
      <span style={{ fontVariantNumeric: 'tabular-nums', color: primary }}>
        {sign}
        <span style={{ color: mute }}>0.{leading}</span>
        {significant && <span style={{ color: primary }}>{significant}</span>}
        {trailingZeros && <span style={{ color: mute }}>{trailingZeros}</span>}
        {percent && <span style={{ color: mute }}>%</span>}
      </span>
    );
  }

  // Magnitude ≥ 1: integer carries the magnitude (bright), decimals are
  // precision (dim), trailing zeros are noise (mute).
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums', color: primary }}>
      {sign}{intPart}
      {(fracKept.length > 0 || trailingZeros.length > 0) && (
        <>
          <span style={{ color: dim }}>.</span>
          {fracKept.length > 0 && <span style={{ color: dim }}>{fracKept}</span>}
          {trailingZeros.length > 0 && <span style={{ color: mute }}>{trailingZeros}</span>}
        </>
      )}
      {percent && <span style={{ color: mute }}>%</span>}
    </span>
  );
}

function NumBig({ value, color = 'var(--fg-mute)' }: { value: number | null | undefined; color?: string }): JSX.Element {
  if (value == null || !Number.isFinite(value)) {
    return <span style={{ color: 'var(--fg-mute)' }}>—</span>;
  }
  const a = Math.abs(value);
  if (a < 1000) {
    return <Num value={Math.round(value)} decimals={0} color={color} />;
  }
  if (a < 1e6) {
    return (
      <span style={{ fontVariantNumeric: 'tabular-nums', color }}>
        <Num value={value / 1e3} decimals={1} color={color} />
        <span style={{ color: 'var(--fg-mute)' }}>k</span>
      </span>
    );
  }
  return (
    <span style={{ fontVariantNumeric: 'tabular-nums', color }}>
      <Num value={value / 1e6} decimals={2} color={color} />
      <span style={{ color: 'var(--fg-mute)' }}>M</span>
    </span>
  );
}

function SignedNum({ value, decimals, percent }: { value: number | null | undefined; decimals: number; percent?: boolean }): JSX.Element {
  if (value == null || !Number.isFinite(value)) {
    return <span style={{ color: 'var(--fg-mute)' }}>—</span>;
  }
  const color = value > 0 ? 'var(--pos)' : value < 0 ? 'var(--neg)' : 'var(--fg-dim)';
  return <Num value={value} decimals={decimals} percent={percent} signed color={color} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric definitions — `level` drives font size + colour intensity per spec §1.
// `flashValue` is the value diffed across snapshots to trigger tick flashes.
// ─────────────────────────────────────────────────────────────────────────────

interface MetricDef {
  id: MetricId;
  label: string;     // header label, will render uppercase
  width: number;
  level: 'primary' | 'secondary' | 'tertiary';
  flashValue: (r: ChainRow | null) => number | null;
  // Smallest delta worth flashing on. Defaults to 1e-9 (any change). Set to
  // the displayed precision so flashes signal *visible* moves — e.g. 1e-4
  // for 4-decimal coin prices (1 bp), 0.01 for 2-decimal $ prices (1 cent).
  flashEpsilon?: number;
  render: (r: ChainRow | null) => React.ReactNode;
}

function usdValue(coinPrice: number | null | undefined, fwd: number | null | undefined): number | null {
  if (coinPrice == null || fwd == null) return null;
  if (!Number.isFinite(coinPrice) || !Number.isFinite(fwd)) return null;
  return coinPrice * fwd;
}

// Coin prices render at 4 dp → 1 bp = 1e-4 is the smallest visible move.
const COIN_PRICE_EPSILON = 1e-4;
// USD prices render at 2 dp → 1 cent = 1e-2 is the smallest visible move.
const USD_PRICE_EPSILON = 1e-2;
// IV in decimal, displayed at 1 dp percent → 0.1% = 1e-3 in decimal.
const IV_EPSILON = 1e-3;

const METRIC_DEFS: Record<MetricId, MetricDef> = {
  bid: {
    id: 'bid', label: 'BID', width: 60, level: 'primary',
    flashValue: r => r?.bid_price ?? null,
    flashEpsilon: COIN_PRICE_EPSILON,
    render: r => <Num value={r?.bid_price} decimals={4} color="var(--bid)" />,
  },
  ask: {
    id: 'ask', label: 'ASK', width: 60, level: 'primary',
    flashValue: r => r?.ask_price ?? null,
    flashEpsilon: COIN_PRICE_EPSILON,
    render: r => <Num value={r?.ask_price} decimals={4} color="var(--ask)" />,
  },
  mark: {
    id: 'mark', label: 'MARK', width: 62, level: 'primary',
    flashValue: r => r?.mark_price ?? null,
    flashEpsilon: COIN_PRICE_EPSILON,
    render: r => <Num value={r?.mark_price} decimals={4} />,
  },
  mid: {
    id: 'mid', label: 'MID', width: 62, level: 'primary',
    flashValue: r => r?.mid_price ?? null,
    flashEpsilon: COIN_PRICE_EPSILON,
    render: r => <Num value={r?.mid_price} decimals={4} />,
  },
  // USD-denominated columns — coin price × per-expiry forward (sourced from
  // each row's own `underlying_price`, so it's always paired with the right
  // expiry's forward, not the front-month).
  usd_bid: {
    id: 'usd_bid', label: '$BID', width: 80, level: 'primary',
    flashValue: r => usdValue(r?.bid_price, r?.underlying_price),
    flashEpsilon: USD_PRICE_EPSILON,
    render: r => <Num value={usdValue(r?.bid_price, r?.underlying_price)} decimals={2} color="var(--bid)" />,
  },
  usd_ask: {
    id: 'usd_ask', label: '$ASK', width: 80, level: 'primary',
    flashValue: r => usdValue(r?.ask_price, r?.underlying_price),
    flashEpsilon: USD_PRICE_EPSILON,
    render: r => <Num value={usdValue(r?.ask_price, r?.underlying_price)} decimals={2} color="var(--ask)" />,
  },
  usd_mark: {
    id: 'usd_mark', label: '$MARK', width: 80, level: 'primary',
    flashValue: r => usdValue(r?.mark_price, r?.underlying_price),
    flashEpsilon: USD_PRICE_EPSILON,
    render: r => <Num value={usdValue(r?.mark_price, r?.underlying_price)} decimals={2} />,
  },
  iv: {
    id: 'iv', label: 'IV', width: 56, level: 'secondary',
    flashValue: r => r?.mark_iv ?? null,
    flashEpsilon: IV_EPSILON,
    render: r => <Num value={r?.mark_iv} percent decimals={1} color="var(--fg-dim)" />,
  },
  spread: {
    id: 'spread', label: 'SPR', width: 60, level: 'secondary',
    flashValue: r => r?.spread ?? null,
    flashEpsilon: COIN_PRICE_EPSILON,
    render: r => <Num value={r?.spread} decimals={4} color="var(--fg-dim)" />,
  },
  spread_bps: {
    id: 'spread_bps', label: 'SPR bps', width: 60, level: 'secondary',
    flashValue: r => bps(r),
    flashEpsilon: 1,
    render: r => <Num value={bps(r)} decimals={0} color="var(--fg-dim)" />,
  },
  change_1h: {
    id: 'change_1h', label: 'Δ1h', width: 70, level: 'secondary',
    flashValue: r => r?.change_1h ?? null,
    flashEpsilon: COIN_PRICE_EPSILON,
    render: r => <SignedNum value={r?.change_1h} decimals={4} />,
  },
  change_24h: {
    id: 'change_24h', label: 'Δ24h', width: 70, level: 'secondary',
    flashValue: r => r?.change_24h ?? null,
    flashEpsilon: COIN_PRICE_EPSILON,
    render: r => <SignedNum value={r?.change_24h} decimals={4} />,
  },
  change_iv_1h: {
    id: 'change_iv_1h', label: 'ΔIV 1h', width: 72, level: 'secondary',
    flashValue: r => r?.change_iv_1h ?? null,
    flashEpsilon: IV_EPSILON,
    render: r => <SignedNum value={r?.change_iv_1h} percent decimals={2} />,
  },
  oi: {
    id: 'oi', label: 'OI', width: 56, level: 'tertiary',
    flashValue: r => r?.open_interest ?? null,
    flashEpsilon: 1,
    render: r => <NumBig value={r?.open_interest} />,
  },
  vol_24h: {
    id: 'vol_24h', label: 'VOL', width: 56, level: 'tertiary',
    flashValue: r => r?.volume_24h ?? null,
    flashEpsilon: 1,
    render: r => <NumBig value={r?.volume_24h} />,
  },
};

const METRIC_ORDER_FOR_PICKER: MetricId[] = [
  'bid', 'ask', 'mark', 'mid', 'iv',
  'usd_bid', 'usd_ask', 'usd_mark',
  'spread', 'spread_bps',
  'change_1h', 'change_24h', 'change_iv_1h',
  'oi', 'vol_24h',
];

const FONT_SIZE: Record<'primary' | 'secondary' | 'tertiary', number> = {
  primary: 12, secondary: 11, tertiary: 10,
};

function bps(r: ChainRow | null): number | null {
  if (!r || r.spread == null || r.mid_price == null || r.mid_price <= 0) return null;
  return (r.spread / r.mid_price) * 10000;
}

const MONTHS: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

// Parse a Deribit expiry token ("26APR26", "8MAY26") to a UTC ms timestamp at
// 08:00 UTC (Deribit's options settlement time). Used purely for ordering the
// expiry dropdown — backend treats the token as opaque elsewhere.
function parseExpiryMs(token: string): number | null {
  const m = /^(\d{1,2})([A-Z]{3})(\d{2})$/.exec(token);
  if (!m) return null;
  const day = Number(m[1]);
  const mon = MONTHS[m[2]];
  if (mon == null) return null;
  const year = 2000 + Number(m[3]);
  return Date.UTC(year, mon, day, 8, 0, 0);
}

// Resolve a saved expiry against the currently-listed expiries. If the token
// is null or no longer in the list (rolled off since the profile was saved),
// return the chronologically nearest remaining expiry — keeps the rest of the
// widget settings untouched while still giving the user *some* chain to read.
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

// ─────────────────────────────────────────────────────────────────────────────
// Pair calls + puts at each strike. Output is sorted by strike ascending.
// ─────────────────────────────────────────────────────────────────────────────

interface PairedRow {
  strike: number;
  call: ChainRow | null;
  put: ChainRow | null;
}

function pairRows(rows: ChainRow[]): PairedRow[] {
  const byStrike = new Map<number, PairedRow>();
  for (const r of rows) {
    const slot = byStrike.get(r.strike) ?? { strike: r.strike, call: null, put: null };
    if (r.option_type === 'C') slot.call = r;
    else slot.put = r;
    byStrike.set(r.strike, slot);
  }
  return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
}

// ─────────────────────────────────────────────────────────────────────────────
// Widget
// ─────────────────────────────────────────────────────────────────────────────

function ChainTable({ config, onConfigChange }: WidgetProps<ChainTableConfig>) {
  const [snap, setSnap] = useState<ChainSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expiriesFromHttp, setExpiriesFromHttp] = useState<string[]>([]);
  const [showColumns, setShowColumns] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchExpiries(config.symbol).then(list => {
      if (!cancelled) setExpiriesFromHttp(list);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [config.symbol]);

  // Resolve `config.expiry` against the available list:
  //   • null → pick front-month
  //   • not in list (rolled off in a saved profile) → pick the closest-in-time
  //     expiry, preserving every other column / density / symbol setting
  //   • already valid → leave alone
  useEffect(() => {
    const list = snap?.expiries.length ? snap.expiries : expiriesFromHttp;
    if (list.length === 0) return;
    if (config.expiry && list.includes(config.expiry)) return;
    const next = pickClosestExpiry(config.expiry, list);
    if (next && next !== config.expiry) onConfigChange({ ...config, expiry: next });
  }, [config, snap?.expiries, expiriesFromHttp, onConfigChange]);

  useEffect(() => {
    if (!config.expiry) return;
    const ctrl = new AbortController();
    setError(null);
    (async () => {
      try {
        for await (const s of chainStream(config.symbol, config.expiry)) {
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
  }, [config.symbol, config.expiry]);

  const expiries = useMemo(() => {
    const set = new Set<string>([...(snap?.expiries ?? []), ...expiriesFromHttp]);
    // Sort by actual expiry date (nearest first), not lexicographic, so the
    // dropdown reads chronologically. Unparseable tokens fall to the end.
    return [...set].sort((a, b) => (parseExpiryMs(a) ?? Infinity) - (parseExpiryMs(b) ?? Infinity));
  }, [snap?.expiries, expiriesFromHttp]);

  const visibleMetrics = useMemo(
    () => config.metrics.map(id => METRIC_DEFS[id]).filter(Boolean),
    [config.metrics],
  );

  // Use the latest snapshot only if its expiry matches the requested one.
  // Otherwise the user has just switched expiries and the previous slice is
  // stale — gating here avoids a single-frame flash of the wrong chain
  // (and prevents the Mirror's auto-center latch from firing on stale data).
  const data = snap && snap.expiry === config.expiry ? snap : null;
  const paired = useMemo(() => pairRows(data?.rows ?? []), [data?.rows]);
  const forward = paired[0]?.call?.underlying_price ?? paired[0]?.put?.underlying_price ?? null;

  const accent = ACCENT[config.symbol];
  const rowH = ROW_HEIGHT[config.density];

  // Index of the first row with strike >= F. Spot line draws between i-1 and i.
  const spotIdx = useMemo(() => {
    if (forward == null) return -1;
    return paired.findIndex(r => r.strike >= forward);
  }, [paired, forward]);

  // Per-widget overrides — the only tokens the chain redefines locally are the
  // currency-identity accent (BTC orange / ETH purple) and the user-chosen
  // density. Everything else inherits from the global theme.
  const cssVars: React.CSSProperties = {
    ['--accent' as never]: accent,
    ['--row-h' as never]: `${rowH}px`,
  };

  return (
    <div
      style={{
        ...cssVars,
        display: 'flex', flexDirection: 'column', height: '100%',
        background: 'var(--bg)', color: 'var(--fg)',
        fontFamily: 'var(--font-data)',
        fontSize: 11, fontVariantNumeric: 'tabular-nums',
      }}
    >
      <Toolbar
        config={config}
        onConfigChange={onConfigChange}
        expiries={expiries}
        forward={forward}
        ts={data?.timestamp_ms ?? null}
        onToggleColumns={() => setShowColumns(v => !v)}
      />
      {showColumns && (
        <ColumnPicker
          selected={config.metrics}
          density={config.density}
          onChange={metrics => onConfigChange({ ...config, metrics })}
          onDensityChange={d => onConfigChange({ ...config, density: d })}
          // Presets must apply metrics + density in one update — splitting
          // them into two onConfigChange calls would race on the stale
          // `config` closure and clobber the metrics update.
          onApplyPreset={(metrics, density) => onConfigChange({ ...config, metrics, density })}
          onClose={() => setShowColumns(false)}
        />
      )}
      {error ? (
        <div style={{ padding: 12, color: 'var(--neg)' }}>error: {error}</div>
      ) : (
        // Remount on (currency, expiry) change so internal scroll state and
        // the auto-center latch reset cleanly without an effect-based reset.
        <Mirror
          key={`${config.symbol}|${config.expiry ?? ''}`}
          rows={paired}
          metrics={visibleMetrics}
          forward={forward}
          spotIdx={spotIdx}
          rowH={rowH}
          accent={accent}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Toolbar + column picker
// ─────────────────────────────────────────────────────────────────────────────

interface ToolbarProps {
  config: ChainTableConfig;
  onConfigChange: (c: ChainTableConfig) => void;
  expiries: string[];
  forward: number | null;
  ts: number | null;
  onToggleColumns: () => void;
}

function Toolbar({ config, onConfigChange, expiries, forward, ts, onToggleColumns }: ToolbarProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 8px', borderBottom: '1px solid var(--bg-2)',
      flexShrink: 0, height: 26, background: 'var(--bg-1)',
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
      <button onClick={onToggleColumns} style={btnStyle}>columns</button>
      <div style={{ flex: 1 }} />
      {forward != null && (
        <span style={{ color: 'var(--fg-dim)' }}>
          F = <span style={{ color: 'var(--accent)', fontVariantNumeric: 'tabular-nums' }}>{forward.toFixed(2)}</span>
        </span>
      )}
      {ts != null && (
        <span style={{ color: 'var(--fg-mute)' }}>{new Date(ts).toLocaleTimeString()}</span>
      )}
    </div>
  );
}

interface ColumnPickerProps {
  selected: MetricId[];
  density: RowDensity;
  onChange: (m: MetricId[]) => void;
  onDensityChange: (d: RowDensity) => void;
  onApplyPreset: (m: MetricId[], d: RowDensity) => void;
  onClose: () => void;
}

function ColumnPicker({ selected, density, onChange, onDensityChange, onApplyPreset, onClose }: ColumnPickerProps) {
  const set = new Set(selected);
  // A preset is "active" only when *both* its metrics and density match — so
  // tweaking density alone after applying a preset drops the highlight, which
  // is the honest UX signal that the layout is no longer canonical.
  const matchesPreset = (preset: { metrics: MetricId[]; density: RowDensity }) =>
    preset.density === density
    && preset.metrics.length === selected.length
    && preset.metrics.every((id, i) => id === selected[i]);
  return (
    <div style={{
      padding: '6px 10px', borderBottom: '1px solid var(--bg-2)',
      background: 'var(--bg-1)', display: 'flex', flexWrap: 'wrap', gap: 8,
      alignItems: 'center',
    }}>
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>PRESET</span>
      {(['dollar', 'bps'] as const).map(name => {
        const p = PRESETS[name];
        const active = matchesPreset(p);
        return (
          <button
            key={name}
            onClick={() => onApplyPreset([...p.metrics], p.density)}
            title={`Set columns to ${p.metrics.join(', ')} (${p.density})`}
            style={{
              ...btnStyle,
              color: active ? 'var(--bg)' : 'var(--fg-mute)',
              background: active ? 'var(--accent)' : 'var(--bg-1)',
              borderColor: active ? 'var(--accent)' : 'var(--bg-2)',
            }}
          >{name}</button>
        );
      })}
      <span style={{ width: 1, height: 14, background: 'var(--bg-2)', margin: '0 4px' }} />
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>METRICS</span>
      {METRIC_ORDER_FOR_PICKER.map(id => {
        const def = METRIC_DEFS[id];
        return (
          <label key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none' }}>
            <input
              type="checkbox"
              checked={set.has(id)}
              onChange={() => {
                const next = set.has(id)
                  ? selected.filter(s => s !== id)
                  : [...selected, id];
                onChange(next);
              }}
            />
            <span style={{ color: set.has(id) ? 'var(--fg)' : 'var(--fg-mute)' }}>{def.label}</span>
          </label>
        );
      })}
      <span style={{ width: 1, height: 14, background: 'var(--bg-2)', margin: '0 4px' }} />
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>DENSITY</span>
      {(['compact', 'default', 'comfortable'] as const).map(d => (
        <button
          key={d}
          onClick={() => onDensityChange(d)}
          style={{
            ...btnStyle,
            color: density === d ? 'var(--bg)' : 'var(--fg-mute)',
            background: density === d ? 'var(--accent)' : 'var(--bg-1)',
            borderColor: density === d ? 'var(--accent)' : 'var(--bg-2)',
          }}
        >{d}</button>
      ))}
      <div style={{ flex: 1 }} />
      <button onClick={onClose} style={btnStyle}>done</button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Mirror layout — header + virtualized body
// ─────────────────────────────────────────────────────────────────────────────

interface MirrorProps {
  rows: PairedRow[];
  metrics: MetricDef[];
  forward: number | null;
  spotIdx: number;
  rowH: number;
  accent: string;
}

function Mirror({ rows, metrics, forward, spotIdx, rowH, accent }: MirrorProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onResize = () => setViewportH(el.clientHeight);
    onResize();
    const ro = new ResizeObserver(onResize);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-scroll to ATM on first paint when forward is known. The parent
  // remounts Mirror on (currency, expiry) change so this latch is naturally
  // reset for new chains.
  const didCenter = useRef(false);
  useLayoutEffect(() => {
    if (didCenter.current || !scrollRef.current || spotIdx < 0 || viewportH === 0) return;
    scrollRef.current.scrollTop = Math.max(0, spotIdx * rowH - viewportH / 2);
    didCenter.current = true;
  }, [spotIdx, viewportH, rowH]);

  const total = rows.length;
  const overscan = 8;
  const start = Math.max(0, Math.floor(scrollTop / rowH) - overscan);
  const end = Math.min(total, Math.ceil((scrollTop + viewportH) / rowH) + overscan);
  const padTop = start * rowH;
  const padBottom = (total - end) * rowH;
  const visible = rows.slice(start, end);

  // Calls side mirrors puts side: same metrics, far-from-spine first.
  const callMetrics = [...metrics].reverse();

  const sideWidth = metrics.reduce((s, m) => s + m.width, 0);
  const totalWidth = sideWidth * 2 + STRIKE_WIDTH;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <Header callMetrics={callMetrics} putMetrics={metrics} accent={accent} />
      <div
        ref={scrollRef}
        onScroll={e => setScrollTop(e.currentTarget.scrollTop)}
        style={{ flex: 1, minHeight: 0, overflowY: 'auto', overflowX: 'auto', position: 'relative' }}
      >
        {total === 0 ? (
          <div style={{ padding: 12, color: 'var(--fg-mute)' }}>no chain data yet…</div>
        ) : (
          <div style={{ width: totalWidth, position: 'relative' }}>
            <div style={{ height: padTop }} />
            {visible.map((pair, i) => {
              const idx = start + i;
              return (
                <Row
                  key={pair.strike}
                  pair={pair}
                  callMetrics={callMetrics}
                  putMetrics={metrics}
                  forward={forward}
                  rowH={rowH}
                  isAtm={spotIdx >= 0 && (idx === spotIdx - 1 || idx === spotIdx)}
                />
              );
            })}
            <div style={{ height: padBottom }} />
            {/* Spot line — sits between row[spotIdx-1] and row[spotIdx]. */}
            {forward != null && spotIdx > 0 && spotIdx < total && (
              <SpotLine top={spotIdx * rowH} forward={forward} totalWidth={totalWidth} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Header({ callMetrics, putMetrics, accent }: { callMetrics: MetricDef[]; putMetrics: MetricDef[]; accent: string }) {
  return (
    <div style={{
      display: 'flex', height: HEADER_HEIGHT, alignItems: 'center',
      background: 'var(--bg-1)',
      borderBottom: `1px solid ${accent}33`,
      boxShadow: `inset 0 -2px 0 0 ${accent}22`,
      flexShrink: 0,
      position: 'sticky', top: 0, zIndex: 1,
    }}>
      {callMetrics.map(m => <HeaderCell key={`c-${m.id}`} m={m} />)}
      <StrikeHeaderCell />
      {putMetrics.map(m => <HeaderCell key={`p-${m.id}`} m={m} />)}
    </div>
  );
}

function HeaderCell({ m }: { m: MetricDef }) {
  return (
    <div style={{
      width: m.width, padding: '0 6px',
      color: 'var(--fg-mute)', fontSize: 9, fontWeight: 500,
      letterSpacing: '0.10em',
      textAlign: 'right',
    }}>{m.label}</div>
  );
}

function StrikeHeaderCell() {
  return (
    <div style={{
      width: STRIKE_WIDTH, padding: '0 6px',
      color: 'var(--accent)', fontSize: 9, fontWeight: 500,
      letterSpacing: '0.10em',
      textAlign: 'center',
      borderLeft: '1px solid var(--bg-2)',
      borderRight: '1px solid var(--bg-2)',
      background: 'var(--bg-2)',
    }}>K</div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Row — one strike, calls cells (reversed) + spine + puts cells.
// ITM shading: call cells get --itm if strike < F; put cells get --itm if strike > F.
// ─────────────────────────────────────────────────────────────────────────────

interface RowProps {
  pair: PairedRow;
  callMetrics: MetricDef[];
  putMetrics: MetricDef[];
  forward: number | null;
  rowH: number;
  isAtm: boolean;
}

function Row({ pair, callMetrics, putMetrics, forward, rowH, isAtm }: RowProps) {
  const callItm = forward != null && pair.strike < forward;
  const putItm = forward != null && pair.strike > forward;

  // Row no longer carries an ATM tint — that visual conflated "near spot"
  // with "ITM-shaded" (a 78K row with F=76K had its OTM cells appearing
  // shaded too). The strike spine accent + the spot line between rows are
  // enough to anchor the eye on F. ITM stays a per-cell, side-specific tint.
  return (
    <div style={{
      display: 'flex', height: rowH, alignItems: 'center',
      borderBottom: '1px solid var(--border)',
    }}>
      {callMetrics.map(m => (
        <Cell
          key={`c-${m.id}`} m={m} row={pair.call} itm={callItm}
        />
      ))}
      <StrikeCell strike={pair.strike} isAtm={isAtm} />
      {putMetrics.map(m => (
        <Cell
          key={`p-${m.id}`} m={m} row={pair.put} itm={putItm}
        />
      ))}
    </div>
  );
}

function StrikeCell({ strike, isAtm }: { strike: number; isAtm: boolean }) {
  return (
    <div style={{
      width: STRIKE_WIDTH, padding: '0 6px',
      color: 'var(--accent)',
      textAlign: 'center',
      borderLeft: '1px solid var(--bg-2)',
      borderRight: '1px solid var(--bg-2)',
      background: isAtm ? 'var(--atm)' : 'var(--bg-2)',
      fontVariantNumeric: 'tabular-nums', fontSize: 12, fontWeight: 500,
    }}>{formatStrike(strike)}</div>
  );
}

function formatStrike(s: number): string {
  if (s >= 1000) {
    if (s % 1000 === 0) return `${s / 1000}K`;
    return `${(s / 1000).toFixed(1)}K`;
  }
  return s.toFixed(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Cell — the only place where tick flashes are wired.
// On every render where flashValue() differs from the previous mounted value,
// fire a 700 ms background fade. First mount sets the baseline; no flash then.
//
// Why per-cell refs and not in the oracle:
//   The oracle's job (HRT principle 1, 4) is to be the single subscriber to
//   upstream data and ship canonical structured-clone snapshots. Diffing the
//   *previous* snapshot to drive a *visual* effect is a presentation concern
//   that different tabs can legitimately disagree on (the spec lets users
//   slow or disable flashes). Doing it client-side keeps the oracle's payload
//   pure snapshots, lets each tab maintain its own flash baseline, and means
//   the previous-value ref dies naturally with the unmounted component (HRT
//   principle 6). It's intentional that scrolling a row out of the windowed
//   viewport unmounts its Cells and resets their baselines.
// ─────────────────────────────────────────────────────────────────────────────

interface CellProps {
  m: MetricDef;
  row: ChainRow | null;
  itm: boolean;
}

function Cell({ m, row, itm }: CellProps) {
  const ref = useRef<HTMLDivElement>(null);
  const prev = useRef<number | null>(null);
  const value = m.flashValue(row);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const p = prev.current;
    // Update the baseline regardless, but only flash when the cell is OTM
    // *and* the move is at or above the metric's epsilon (= one unit at
    // displayed precision, i.e. 1 bp for coin prices). The OTM gate kills
    // distracting flashes on deep-ITM rows that bounce around with the
    // forward — those legs aren't where price discovery lives.
    const eps = m.flashEpsilon ?? 1e-9;
    if (
      !itm
      && p != null && value != null
      && Number.isFinite(p) && Number.isFinite(value)
      && Math.abs(value - p) >= eps
    ) {
      // Read the live token from the active theme so the flash colour adapts
      // when the user toggles light/dark.
      const cs = getComputedStyle(el);
      const color = value > p
        ? cs.getPropertyValue('--flash-up').trim()
        : cs.getPropertyValue('--flash-down').trim();
      el.animate(
        [{ background: color }, { background: 'transparent' }],
        { duration: 700, easing: 'ease-out' },
      );
    }
    prev.current = value;
  }, [value, m.flashEpsilon, itm]);

  return (
    <div
      ref={ref}
      style={{
        width: m.width, padding: '0 6px',
        textAlign: 'right',
        fontSize: FONT_SIZE[m.level],
        background: itm ? 'var(--itm)' : undefined,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}
    >
      {m.render(row)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Spot line — drawn between the two rows flanking F.
// ─────────────────────────────────────────────────────────────────────────────

function SpotLine({ top, forward, totalWidth }: { top: number; forward: number; totalWidth: number }) {
  return (
    <div style={{
      position: 'absolute', left: 0, top: top - 1,
      width: totalWidth, height: 0,
      borderTop: '1px dashed var(--accent)',
      pointerEvents: 'none',
    }}>
      <span style={{
        position: 'absolute', right: 8, top: -7,
        background: 'var(--bg)', padding: '0 4px',
        color: 'var(--accent)', fontSize: 9, letterSpacing: '0.10em',
        fontVariantNumeric: 'tabular-nums',
      }}>
        F {forward.toFixed(2)}
      </span>
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg-dim)', border: '1px solid var(--bg-2)',
  borderRadius: 0, padding: '2px 6px', fontSize: 11, cursor: 'pointer',
  fontVariantNumeric: 'tabular-nums',
};
const btnStyle: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg-mute)', border: '1px solid var(--bg-2)',
  borderRadius: 0, padding: '2px 8px', cursor: 'pointer', fontSize: 11,
};

registerWidget<ChainTableConfig>({
  id: 'chainTable',
  title: 'Chain',
  component: ChainTable,
  defaultConfig: DEFAULT_CONFIG,
  configVersion: 3,
  // v1 → flat per-strike-rows-of-C/P columns; v2 → mirrored geometry; v3 → adds
  // $-denominated bid/ask/mark metrics (and a chronological dropdown sort, but
  // that's not a config concern). Migrations preserve the user's existing
  // metric choices and density, only injecting the USD trio if absent.
  migrate: (fromVersion, oldConfig) => {
    if (!oldConfig || typeof oldConfig !== 'object') return DEFAULT_CONFIG;
    const o = oldConfig as Partial<ChainTableConfig> & { columns?: string[] };
    const knownV2: Set<MetricId> = new Set([
      'bid', 'ask', 'mark', 'mid', 'iv', 'spread', 'spread_bps',
      'change_1h', 'change_24h', 'change_iv_1h', 'oi', 'vol_24h',
    ]);

    // Recover v2 metric list either from the existing v2 config or from the
    // legacy v1 columns array.
    let metrics: MetricId[];
    if (fromVersion === 1) {
      const preserve: MetricId[] = [];
      for (const c of o.columns ?? []) {
        if (knownV2.has(c as MetricId)) preserve.push(c as MetricId);
      }
      metrics = preserve.length > 0 ? preserve : DEFAULT_METRICS;
    } else {
      metrics = (o.metrics ?? DEFAULT_METRICS).filter((id): id is MetricId =>
        knownV2.has(id as MetricId) || id === 'usd_bid' || id === 'usd_ask' || id === 'usd_mark');
    }

    // Inject the v3 USD pair if the layout doesn't already include them.
    for (const id of ['usd_bid', 'usd_ask'] as MetricId[]) {
      if (!metrics.includes(id)) metrics.push(id);
    }

    return {
      venue: 'deribit',
      symbol: (o.symbol as Currency) ?? 'BTC',
      expiry: o.expiry ?? null,
      metrics,
      density: o.density ?? 'default',
    };
  },
  accentColor: ACCENT.BTC,
});
