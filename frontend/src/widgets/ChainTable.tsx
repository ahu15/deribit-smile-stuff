import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { registerWidget, type WidgetProps } from '../shell/widgetRegistry';
import { chainStream, fetchExpiries, type ChainRow, type ChainSnapshot } from '../worker/chainService';
import { smileStream, type SmileFit } from '../worker/smileService';
import { fetchMethodologies, type MethodologySpec } from '../worker/methodologyService';
import { evaluate as evaluateSmile } from '../calibration';
import { pickClosestExpiry, sortExpiries } from '../shared/expiry';
import { findMethodology, termStructureFor } from '../shared/methodology';
import { busPublish, Topics, type AddLegEvent } from '../worker/busService';
import { useQuickPricerOpen } from '../hooks/useQuickPricer';
import { useEffectiveModel } from '../hooks/useDefaultModel';
import { OverrideModelPicker } from '../components/ModelPicker';
import { priceBlack76 } from '../shared/black76';
import { useCurrencyAccent, DEFAULT_BTC_ACCENT } from '../shared/currencyAccent';
import { useTheme } from '../hooks/useTheme';

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
  | 'oi' | 'vol_24h'
  // Mark-to-model: model IV at this strike, signed IV residual (mark − model)
  // in vol points, signed USD premium residual (mark − model premium), and
  // signed bps-of-forward premium residual.
  | 'model_iv' | 'iv_resid' | 'usd_resid' | 'bps_resid';

// Built-in column presets — bid/ask/mark/iv with a unit toggle. Coin-priced
// columns (`bid`/`ask`/`mark`) already read as bps of underlying since
// Deribit quotes options as a fraction of spot, so the "bps" preset just
// reuses them rather than adding a duplicated bp-prefixed column. Both
// presets default to compact density to fit four numeric columns per side
// without horizontal scroll on a typical dock.
const PRESETS: Record<'dollar' | 'bps', { metrics: MetricId[]; density: RowDensity }> = {
  dollar: { metrics: ['usd_bid', 'usd_mark', 'usd_ask', 'iv'], density: 'compact' },
  bps:    { metrics: ['bid', 'mark', 'ask', 'iv'],             density: 'compact' },
};

type RowDensity = 'compact' | 'default' | 'comfortable';

interface ChainTableConfig {
  venue: 'deribit';
  symbol: Currency;
  expiry: string | null;
  // Ordered closest-to-spine first; mirrored on the calls side.
  metrics: MetricId[];
  density: RowDensity;
  // null = follow the app-wide default model; string = pin this chain to
  // a specific methodology id (persists across changes to the default).
  fairCurveOverride: string | null;
  // Shade the strike spine cell by mark-to-model IV residual sign + magnitude
  // — cool means the chain is bid above model fair (rich vs model on the
  // mark price), warm means cheap. Off by default.
  strikeShadeByModel: boolean;
}

// Default puts-side order, spine-out: BID, MARK, ASK, IV, $BID, $MARK, $ASK, Δ24h, OI.
// On the calls side, this is mirrored *and* bid/ask are swapped (see
// `callMetricsOrder`) so reading globally left-to-right always shows
// BID < MARK < ASK on each side — the standard option-chain convention.
const DEFAULT_METRICS: MetricId[] = [
  'bid', 'mark', 'ask', 'iv', 'usd_bid', 'usd_mark', 'usd_ask', 'change_24h', 'oi',
];

const DEFAULT_CONFIG: ChainTableConfig = {
  venue: 'deribit',
  symbol: 'BTC',
  expiry: null,
  metrics: DEFAULT_METRICS,
  density: 'default',
  fairCurveOverride: null,
  strikeShadeByModel: false,
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

  // Magnitude < 1 (e.g. 0.0035 BTC option marks): the leading "0." plus any
  // leading zeros are just magnitude scaffolding — dim them. Everything from
  // the first non-zero digit onward (including trailing zeros) is real
  // precision and must read brightly: in bps mode "0.0030" is "30 bps", and
  // muting the trailing zero like we do for ≥1 values would visually shrink
  // it to "3 bps". Only fully-zero values (0.0000) keep the muted trailing
  // since there's no significant digit to anchor.
  if (intPart === '0' && (fracKept.length > 0 || trailingZeros.length > 0)) {
    const leading = fracKept.match(/^0+/)?.[0] ?? '';
    const significant = fracKept.slice(leading.length);
    const trailingColor = significant.length > 0 ? primary : mute;
    return (
      <span style={{ fontVariantNumeric: 'tabular-nums', color: primary }}>
        {sign}
        <span style={{ color: mute }}>0.{leading}</span>
        {significant && <span style={{ color: primary }}>{significant}</span>}
        {trailingZeros && <span style={{ color: trailingColor }}>{trailingZeros}</span>}
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
  flashValue: (r: AugmentedChainRow | null) => number | null;
  // Smallest delta worth flashing on. Defaults to 1e-9 (any change). Set to
  // the displayed precision so flashes signal *visible* moves — e.g. 1e-4
  // for 4-decimal coin prices (1 bp), 0.01 for 2-decimal $ prices (1 cent).
  flashEpsilon?: number;
  render: (r: AugmentedChainRow | null) => React.ReactNode;
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
  // Coin-priced bid/ask/mark/mid render at 4 dp ("0.0035") which is ~40 px in
  // 12-px tabular-nums. Widths must be ≥ 4 dp + decimal point + sign + the
  // 18 px reserved for the leg-action chevron + 6 px right padding, so 72 px
  // gives a comfortable margin without making the chain feel sparse.
  bid: {
    id: 'bid', label: 'BID', width: 72, level: 'primary',
    flashValue: r => r?.bid_price ?? null,
    flashEpsilon: COIN_PRICE_EPSILON,
    render: r => <Num value={r?.bid_price} decimals={4} color="var(--bid)" />,
  },
  ask: {
    id: 'ask', label: 'ASK', width: 72, level: 'primary',
    flashValue: r => r?.ask_price ?? null,
    flashEpsilon: COIN_PRICE_EPSILON,
    render: r => <Num value={r?.ask_price} decimals={4} color="var(--ask)" />,
  },
  mark: {
    id: 'mark', label: 'MARK', width: 72, level: 'primary',
    flashValue: r => r?.mark_price ?? null,
    flashEpsilon: COIN_PRICE_EPSILON,
    render: r => <Num value={r?.mark_price} decimals={4} />,
  },
  mid: {
    id: 'mid', label: 'MID', width: 72, level: 'primary',
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
  // ─── mark-to-model metrics (M3.99) ───
  // model_iv: the fair-curve's vol at this strike, rescaled to calendar-T so
  // it lives in the same basis as Deribit's mark_iv. Renders dim so it
  // visually anchors as "derived, not a market quote" — `var(--fg-dim)` is
  // used (rather than `--accent`) because ChainTable overrides `--accent` to
  // the currency colour, which would visually conflate model with market.
  model_iv: {
    id: 'model_iv', label: 'mIV', width: 60, level: 'secondary',
    flashValue: r => r?.model_iv ?? null,
    flashEpsilon: IV_EPSILON,
    render: r => <Num value={r?.model_iv} percent decimals={1} color="var(--fg-dim)" />,
  },
  // iv_resid: signed mark_iv − model_iv in vol points. > 0 = mark above model
  // (rich vs model, easy to short), < 0 = mark below model (cheap vs model).
  iv_resid: {
    id: 'iv_resid', label: 'ΔIV', width: 64, level: 'secondary',
    flashValue: r => r?.iv_resid ?? null,
    flashEpsilon: IV_EPSILON,
    render: r => <SignedNum value={r?.iv_resid} percent decimals={2} />,
  },
  // usd_resid: signed market − model premium, in USD per contract. > 0 = the
  // mark is above model fair value in dollar terms.
  usd_resid: {
    id: 'usd_resid', label: '$EV', width: 70, level: 'secondary',
    flashValue: r => r?.usd_resid ?? null,
    flashEpsilon: USD_PRICE_EPSILON,
    render: r => <SignedNum value={r?.usd_resid} decimals={2} />,
  },
  // bps_resid: signed (mark − model) as bps of forward. Same sign convention
  // as usd_resid, but unitless across forwards.
  bps_resid: {
    id: 'bps_resid', label: 'EVbps', width: 64, level: 'secondary',
    flashValue: r => r?.bps_resid ?? null,
    flashEpsilon: 1,
    render: r => <SignedNum value={r?.bps_resid} decimals={1} />,
  },
};

const METRIC_ORDER_FOR_PICKER: MetricId[] = [
  'bid', 'ask', 'mark', 'mid', 'iv',
  'usd_bid', 'usd_ask', 'usd_mark',
  'spread', 'spread_bps',
  'change_1h', 'change_24h', 'change_iv_1h',
  'oi', 'vol_24h',
  // Model-derived columns — segregated at the end of the picker so the
  // existing market-quote section reads first.
  'model_iv', 'iv_resid', 'usd_resid', 'bps_resid',
];

// Set of metric ids that depend on the smile fit. Used to gate the smile
// subscription so chains that don't show a model column or strike shading
// don't open an unnecessary backend conversation.
const MODEL_DEPENDENT_METRICS: Set<MetricId> = new Set([
  'model_iv', 'iv_resid', 'usd_resid', 'bps_resid',
]);

const FONT_SIZE: Record<'primary' | 'secondary' | 'tertiary', number> = {
  primary: 12, secondary: 11, tertiary: 10,
};

function bps(r: AugmentedChainRow | null): number | null {
  if (!r || r.spread == null || r.mid_price == null || r.mid_price <= 0) return null;
  return (r.spread / r.mid_price) * 10000;
}

function swapByIdInPlace(arr: MetricDef[], a: MetricId, b: MetricId): void {
  const i = arr.findIndex(m => m.id === a);
  const j = arr.findIndex(m => m.id === b);
  if (i >= 0 && j >= 0) [arr[i], arr[j]] = [arr[j], arr[i]];
}

// ─────────────────────────────────────────────────────────────────────────────
// Mark-to-model augmentation. The fair-curve fit feeds per-row model_iv +
// premium residuals at each strike. Computed once per (chain snapshot, fit
// snapshot) and merged onto every row regardless of whether the user has the
// model columns / shading turned on — the cost is tiny (one Hagan eval per
// strike + one Black-76 eval per option) and keeps strike shading reactive.
//
// Basis convention: Deribit posts mark_iv / mark_price under calendar-T, so
// every model-vs-market quantity surfaced to the user is computed in cal
// basis. When the methodology was fit under wkg basis the params encode a
// curve in wkg-σ; total-variance preservation gives σ_cal = σ_wkg · √(T_wkg
// / T_cal), which leaves Black-76 premium invariant (σ²·T and σ·√T both
// match). For cal-basis methodologies the rescale collapses to ×1.
// ─────────────────────────────────────────────────────────────────────────────

type AugmentedChainRow = ChainRow & {
  model_iv: number | null;       // calendar-T basis, regardless of fit basis
  iv_resid: number | null;       // mark_iv − model_iv (decimal vol points, signed)
  usd_resid: number | null;      // mark premium $ − model premium $
  bps_resid: number | null;      // (mark − model)/F · 1e4
};

function augmentRowsWithModel(rows: ChainRow[], fit: SmileFit | null): AugmentedChainRow[] {
  if (!fit || rows.length === 0) {
    return rows.map(r => ({ ...r, model_iv: null, iv_resid: null, usd_resid: null, bps_resid: null }));
  }
  // Single evaluator call per chain — strikes flow through as an array so
  // SVI / SABR / future kinds share the loop. The eval runs at the fit's own
  // basis (params were calibrated under fit.t_years); we then rescale to cal
  // before exposing anything to the user (see header comment).
  const strikes = rows.map(r => r.strike);
  const modelIvsBasis = evaluateSmile(fit.kind, fit.params, strikes, fit.forward, fit.t_years);
  const tCal = fit.t_years_cal;
  const basisToCal = tCal > 0 && fit.t_years > 0 ? Math.sqrt(fit.t_years / tCal) : NaN;
  return rows.map((r, i) => {
    const ivBasis = modelIvsBasis[i];
    const modelIv = Number.isFinite(ivBasis) && Number.isFinite(basisToCal)
      ? ivBasis * basisToCal
      : null;
    if (modelIv == null || modelIv <= 0 || r.mark_iv == null || !Number.isFinite(r.mark_iv)) {
      return { ...r, model_iv: modelIv, iv_resid: null, usd_resid: null, bps_resid: null };
    }
    const ivResid = r.mark_iv - modelIv;
    // Premium residual: market mark_price was implied by Deribit under cal-T,
    // so we price the model leg with cal-T as well. Forward rate = 0 matches
    // the fitter's convention and keeps mark_price · F = USD premium clean.
    const cp: 1 | -1 = r.option_type === 'C' ? 1 : -1;
    const priced = priceBlack76(cp, fit.forward, r.strike, tCal, modelIv, 0);
    let usdResid: number | null = null;
    let bpsResid: number | null = null;
    if (priced && r.mark_price != null && Number.isFinite(r.mark_price) && r.underlying_price > 0) {
      const markUsd = r.mark_price * r.underlying_price;
      usdResid = markUsd - priced.premium_fwd;
      bpsResid = (r.mark_price - priced.premium_fwd / r.underlying_price) * 10000;
    }
    return { ...r, model_iv: modelIv, iv_resid: ivResid, usd_resid: usdResid, bps_resid: bpsResid };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pair calls + puts at each strike. Output is sorted by strike ascending.
// ─────────────────────────────────────────────────────────────────────────────

interface PairedRow {
  strike: number;
  call: AugmentedChainRow | null;
  put: AugmentedChainRow | null;
}

function pairRows(rows: AugmentedChainRow[]): PairedRow[] {
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
  const [smileFit, setSmileFit] = useState<SmileFit | null>(null);
  const [methodologyCatalog, setMethodologyCatalog] = useState<MethodologySpec[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [expiriesFromHttp, setExpiriesFromHttp] = useState<string[]>([]);
  const [showColumns, setShowColumns] = useState(false);

  // Effective methodology = override ?? app-wide default. The catalog is
  // looked up once per widget mount so we can resolve `requires_ts` without
  // a re-fetch per render. Auto-link the curve method to the calibrator's
  // basis (same rule SmileChart uses).
  const effectiveMethodology = useEffectiveModel(config.fairCurveOverride);
  useEffect(() => {
    let cancelled = false;
    fetchMethodologies().then(list => {
      if (!cancelled) setMethodologyCatalog(list);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  const effectiveTs = termStructureFor(findMethodology(methodologyCatalog, effectiveMethodology));

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

  // Smile fit subscription — only when the user has the strike-shading toggle
  // on or has at least one model-dependent column visible. Gated on catalog
  // load so we don't subscribe with `ts=null` and then re-subscribe with the
  // real ts a tick later (alpha-from-ts methodologies need the curve id at
  // first call, otherwise the backend gets a malformed request). The oracle's
  // refcount-shared key means the live sub is shared with any open SmileChart
  // on the same (currency, expiry, methodology, ts).
  const needSmile = useMemo(
    () => config.strikeShadeByModel || config.metrics.some(m => MODEL_DEPENDENT_METRICS.has(m)),
    [config.strikeShadeByModel, config.metrics],
  );
  const catalogReady = methodologyCatalog.length > 0;
  useEffect(() => {
    if (!config.expiry || !needSmile || !catalogReady) {
      setSmileFit(null);
      return;
    }
    // Drop the previous fit synchronously on every (methodology, ts, expiry)
    // change so the model column / shading don't render against stale params
    // until the first new envelope lands.
    setSmileFit(null);
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const s of smileStream(
          config.symbol, config.expiry!, effectiveMethodology, effectiveTs,
        )) {
          if (ctrl.signal.aborted) break;
          setSmileFit(s.fit);
        }
      } catch {
        // Model layer is optional — failure shouldn't crash the chain table.
      }
    })();
    return () => ctrl.abort();
  }, [config.symbol, config.expiry, needSmile, catalogReady, effectiveMethodology, effectiveTs]);

  const expiries = useMemo(
    () => sortExpiries(new Set<string>([...(snap?.expiries ?? []), ...expiriesFromHttp])),
    [snap?.expiries, expiriesFromHttp],
  );

  const visibleMetrics = useMemo(
    () => config.metrics.map(id => METRIC_DEFS[id]).filter(Boolean),
    [config.metrics],
  );

  // Use the latest snapshot only if its expiry matches the requested one.
  // Otherwise the user has just switched expiries and the previous slice is
  // stale — gating here avoids a single-frame flash of the wrong chain
  // (and prevents the Mirror's auto-center latch from firing on stale data).
  const data = snap && snap.expiry === config.expiry ? snap : null;
  const augmentedRows = useMemo(
    () => augmentRowsWithModel(data?.rows ?? [], smileFit),
    [data?.rows, smileFit],
  );
  const paired = useMemo(() => pairRows(augmentedRows), [augmentedRows]);
  const forward = paired[0]?.call?.underlying_price ?? paired[0]?.put?.underlying_price ?? null;

  const accent = useCurrencyAccent(config.symbol);
  const rowH = ROW_HEIGHT[config.density];
  const pricerOpen = useQuickPricerOpen();
  // Light mode pales `--bg-2`, so the diverging shade needs a softer ceiling
  // to keep it from overwhelming the strike text — mirrors the alpha ratio
  // between `--flash-up`/`--flash-down` in dark vs light themes.
  const shadeMaxAlpha = useTheme().theme === 'dark' ? 0.55 : 0.40;

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
        smileFitReady={smileFit != null}
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
          pricerOpen={pricerOpen}
          strikeShadeByModel={config.strikeShadeByModel}
          shadeMaxAlpha={shadeMaxAlpha}
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
  smileFitReady: boolean;
}

function Toolbar({ config, onConfigChange, expiries, forward, ts, onToggleColumns, smileFitReady }: ToolbarProps) {
  // Strike-shading is only meaningful with a fit in hand. We don't disable
  // the checkbox — the user might toggle it before the fit lands — but show
  // a hint in the tooltip when there's no fit yet.
  const shadeTitle = config.strikeShadeByModel && !smileFitReady
    ? 'Strike shading: waiting for first fit…'
    : 'Shade strike spine by ΔIV (mark − model). Cool = mark below model (cheap), warm = above (rich).';
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
      <OverrideModelPicker
        value={config.fairCurveOverride}
        onChange={id => onConfigChange({ ...config, fairCurveOverride: id })}
        title="Fair-value model for this chain. Default follows the app-wide model in the header."
      />
      <label
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer', userSelect: 'none', color: 'var(--fg-dim)' }}
        title={shadeTitle}
      >
        <input
          type="checkbox"
          checked={config.strikeShadeByModel}
          onChange={e => onConfigChange({ ...config, strikeShadeByModel: e.target.checked })}
        />
        <span style={{ fontSize: 11 }}>shade K</span>
      </label>
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
  pricerOpen: boolean;
  strikeShadeByModel: boolean;
  shadeMaxAlpha: number;
}

function Mirror({ rows, metrics, forward, spotIdx, rowH, accent, pricerOpen, strikeShadeByModel, shadeMaxAlpha }: MirrorProps) {
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

  // Calls side mirrors puts side, but bid/ask are swapped so the global
  // left-to-right read shows BID < MARK < ASK on both sides (standard
  // option-chain convention — bid is always to the left of ask). Without
  // the swap, mirroring would put BID closest to spine on calls *and*
  // closest on puts, which means calls reads ASK < MARK < BID — wrong.
  const callMetrics = useMemo(() => {
    const reversed = metrics.slice().reverse();
    swapByIdInPlace(reversed, 'bid', 'ask');
    swapByIdInPlace(reversed, 'usd_bid', 'usd_ask');
    return reversed;
  }, [metrics]);

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
                  pricerOpen={pricerOpen}
                  strikeShadeByModel={strikeShadeByModel}
                  shadeMaxAlpha={shadeMaxAlpha}
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
  pricerOpen: boolean;
  strikeShadeByModel: boolean;
  shadeMaxAlpha: number;
}

function Row({ pair, callMetrics, putMetrics, forward, rowH, isAtm, pricerOpen, strikeShadeByModel, shadeMaxAlpha }: RowProps) {
  const callItm = forward != null && pair.strike < forward;
  const putItm = forward != null && pair.strike > forward;

  // Pick whichever side has a finite IV residual — they should agree (the
  // model is a function of strike only) but in practice the call leg might
  // be missing while the put has data, or vice versa. Average when both are
  // present so a noisy single quote doesn't dominate.
  const ivResid = strikeShadeByModel ? pickIvResid(pair) : null;

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
          side="call" pricerOpen={pricerOpen}
        />
      ))}
      <StrikeCell strike={pair.strike} isAtm={isAtm} ivResid={ivResid} shadeMaxAlpha={shadeMaxAlpha} />
      {putMetrics.map(m => (
        <Cell
          key={`p-${m.id}`} m={m} row={pair.put} itm={putItm}
          side="put" pricerOpen={pricerOpen}
        />
      ))}
    </div>
  );
}

function pickIvResid(pair: PairedRow): number | null {
  const c = pair.call?.iv_resid;
  const p = pair.put?.iv_resid;
  if (c != null && p != null) return (c + p) / 2;
  return c ?? p ?? null;
}

// Diverging strike-shading. |resid| clamps at 2 vol points (0.02) for the
// alpha ramp; rich → red, cheap → green; same OKLCH triples as the
// `--flash-up` / `--flash-down` price-flash colors. `maxAlpha` is theme-
// supplied so light mode (where `--bg-2` is pale) gets a softer ceiling
// than dark mode, mirroring the flash-color alpha ratio.
function strikeShadeFor(ivResid: number | null, maxAlpha: number): string | null {
  if (ivResid == null || !Number.isFinite(ivResid)) return null;
  const SAT_AT = 0.02;
  const a = Math.min(1, Math.abs(ivResid) / SAT_AT);
  if (a < 0.05) return null;          // dead zone — don't tint near-fair strikes
  return ivResid > 0
    ? `oklch(0.66 0.21 25 / ${(a * maxAlpha).toFixed(3)})`
    : `oklch(0.74 0.18 145 / ${(a * maxAlpha).toFixed(3)})`;
}

function StrikeCell({
  strike, isAtm, ivResid, shadeMaxAlpha,
}: {
  strike: number; isAtm: boolean; ivResid: number | null; shadeMaxAlpha: number;
}) {
  const shade = strikeShadeFor(ivResid, shadeMaxAlpha);
  // Composite the model-shade on top of the ATM/base bg so the user can still
  // see which strike is closest to F when shading is on. Three layers from
  // bottom: base bg-2, optional --atm tint when ATM, then the diverging
  // shade. CSS background can't accept multiple solid colors — wrap as a
  // gradient stack instead.
  const layers: string[] = [];
  if (shade) layers.push(`linear-gradient(${shade}, ${shade})`);
  layers.push(isAtm ? 'var(--atm)' : 'var(--bg-2)');
  const tooltip = ivResid != null
    ? `ΔIV ${(ivResid * 100).toFixed(2)}%  (${ivResid > 0 ? 'mark above model' : 'mark below model'})`
    : 'mark vs model — no fit';
  return (
    <div
      title={ivResid != null ? tooltip : undefined}
      style={{
        width: STRIKE_WIDTH, padding: '0 6px',
        color: 'var(--accent)',
        textAlign: 'center',
        borderLeft: '1px solid var(--bg-2)',
        borderRight: '1px solid var(--bg-2)',
        background: layers.join(', '),
        fontVariantNumeric: 'tabular-nums', fontSize: 12, fontWeight: 500,
      }}
    >{formatStrike(strike)}</div>
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
// Cell — the only place where tick flashes are wired, and where the leg-action
// chevron is anchored. Cell padding flips per action direction so the chevron
// always sits on the cell edge that abuts the MARK column (see LegButton).
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
  row: AugmentedChainRow | null;
  itm: boolean;
  side: 'call' | 'put';
  pricerOpen: boolean;
}

// Map metric ids to leg action verbs. Both coin- and USD-denominated bid/ask
// carry the +/− buttons so the pair always brackets the mark column regardless
// of which preset (bps or dollar) the user picked. If both pairs are visible
// at once the user gets two buttons per side — that's redundant but not buggy:
// each click dispatches the same add-leg action.
function legAction(metricId: MetricId): 1 | -1 | null {
  if (metricId === 'bid' || metricId === 'usd_bid') return -1;   // hit the bid → sell 1
  if (metricId === 'ask' || metricId === 'usd_ask') return +1;   // lift the ask → buy 1
  return null;
}

function Cell({ m, row, itm, side, pricerOpen }: CellProps) {
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

  const action = row ? legAction(m.id) : null;

  // Pin the chevron to the edge of the cell that faces the MARK column so the
  // visual reads `bid − mark + ask` regardless of which side of the spine the
  // cell is on. Sell (−) sits on the bid's right edge (which abuts mark); buy
  // (+) sits on the ask's left edge (which also abuts mark). Reserve extra
  // padding on that same edge so the right-aligned number never collides with
  // the chevron.
  const buttonOnLeft = action === +1;
  const buttonOnRight = action === -1;

  return (
    <div
      ref={ref}
      style={{
        width: m.width,
        paddingLeft: buttonOnLeft ? 18 : 6,
        paddingRight: buttonOnRight ? 18 : 6,
        textAlign: 'right',
        fontSize: FONT_SIZE[m.level],
        background: itm ? 'var(--itm)' : undefined,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
        position: 'relative',
      }}
    >
      {action !== null && row && (
        <LegButton row={row} side={action} enabled={pricerOpen} />
      )}
      {m.render(row)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LegButton — chain row's leg-add control. Pinned to the cell edge facing the
// MARK column so every row reads `bid − mark + ask` regardless of side: − on
// the bid's mark-facing edge, + on the ask's mark-facing edge. The Cell
// wrapper reserves matching padding on the same edge so the right-aligned
// price never sits underneath the glyph.
// ─────────────────────────────────────────────────────────────────────────────

function LegButton({
  row, side, enabled,
}: { row: ChainRow; side: 1 | -1; enabled: boolean }) {
  const edge = side === +1 ? { left: 1 } : { right: 1 };
  const glyph = side === 1 ? '+' : '−';
  const title = enabled
    ? (side === 1 ? `Buy 1 ${row.instrument_name}` : `Sell 1 ${row.instrument_name}`)
    : 'Open Quick Pricer to add legs';

  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!enabled) return;
    busPublish(Topics.quickPricerAddLeg, {
      venue: 'deribit', instrumentName: row.instrument_name, side, qty: 1,
    } satisfies AddLegEvent).catch(() => { /* best-effort */ });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!enabled}
      title={title}
      style={{
        position: 'absolute', top: '50%', transform: 'translateY(-50%)',
        ...edge,
        width: 13, height: 13, padding: 0, lineHeight: '11px',
        border: '1px solid transparent',
        background: 'transparent',
        color: enabled ? 'var(--fg-mute)' : 'var(--bg-2)',
        fontSize: 12, fontFamily: 'var(--font-data)', fontWeight: 600,
        cursor: enabled ? 'pointer' : 'not-allowed',
        borderRadius: 2,
        opacity: enabled ? 0.85 : 0.5,
      }}
      onMouseEnter={e => {
        if (!enabled) return;
        const t = e.currentTarget;
        t.style.background = 'var(--bg-2)';
        t.style.color = side === 1 ? 'var(--ask)' : 'var(--bid)';
        t.style.opacity = '1';
      }}
      onMouseLeave={e => {
        const t = e.currentTarget;
        t.style.background = 'transparent';
        t.style.color = enabled ? 'var(--fg-mute)' : 'var(--bg-2)';
        t.style.opacity = enabled ? '0.85' : '0.5';
      }}
    >{glyph}</button>
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
  configVersion: 4,
  // v1 → flat per-strike-rows-of-C/P columns; v2 → mirrored geometry; v3 → adds
  // $-denominated bid/ask/mark metrics (and a chronological dropdown sort, but
  // that's not a config concern); v4 → per-widget `fairCurveOverride` (null =
  // follow the app-wide model) + `strikeShadeByModel` toggle + 4 new mark-to-
  // model metric columns (`model_iv`, `iv_resid`, `usd_resid`, `bps_resid`).
  // Migrations preserve the user's existing metric choices and density, only
  // injecting the v3 USD trio if absent.
  migrate: (fromVersion, oldConfig) => {
    if (!oldConfig || typeof oldConfig !== 'object') return DEFAULT_CONFIG;
    const o = oldConfig as Partial<ChainTableConfig> & { columns?: string[] };
    const knownV2: Set<MetricId> = new Set([
      'bid', 'ask', 'mark', 'mid', 'iv', 'spread', 'spread_bps',
      'change_1h', 'change_24h', 'change_iv_1h', 'oi', 'vol_24h',
    ]);
    const knownV4Extras: Set<MetricId> = new Set([
      'usd_bid', 'usd_ask', 'usd_mark',
      'model_iv', 'iv_resid', 'usd_resid', 'bps_resid',
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
        knownV2.has(id as MetricId) || knownV4Extras.has(id as MetricId));
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
      fairCurveOverride: typeof o.fairCurveOverride === 'string' ? o.fairCurveOverride : null,
      strikeShadeByModel: !!o.strikeShadeByModel,
    };
  },
  accentColor: DEFAULT_BTC_ACCENT,
});
