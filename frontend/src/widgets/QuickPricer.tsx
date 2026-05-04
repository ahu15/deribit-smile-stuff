// QuickPricer — multi-leg package pricer (M3.5).
//
// Singleton widget. Receives leg events from `ChainTable`'s +/− buttons via
// `busService` (topic `quickPricer.addLeg`); each click signed-adds 1 to the
// matched leg's quantity, or creates the leg fresh. Reaching qty 0 drops the
// leg.
//
// Math runs entirely on the frontend (Black-76 + SABR Hagan-2002, ported in
// `shared/black76.ts`). All upstream feeds — chain snapshots and SABR fits —
// flow through the existing oracle services, so multiple legs at the same
// (currency, expiry) share one backend subscription via `acquireSharedStream`.

import { useEffect, useMemo, useRef, useState } from 'react';
import { registerWidget, type WidgetProps } from '../shell/widgetRegistry';
import {
  busSubscribe, registerQuickPricer, Topics, type AddLegEvent,
} from '../worker/busService';
import { chainStream, type ChainRow, type ChainSnapshot } from '../worker/chainService';
import { smileStream, type SmileFit, type SmileSnapshot } from '../worker/smileService';
import { parseExpiryMs, parseInstrument } from '../shared/expiry';
import { priceBlack76, sabrLognormalVol, type PricedLeg } from '../shared/black76';

const ACCENT = '#9aa6ba';   // neutral; legs may span multiple currencies
const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

interface OverrideSlot {
  value: number;
  active: boolean;
  // Wall-clock ms when the value/active state last changed. Used by the
  // two-of-three rule on (spot, fwd, fwdRate): activating the third
  // auto-deactivates the *least recently touched* of the others.
  touchedAt: number;
}

interface LegOverrides {
  vol?: OverrideSlot;
  spot?: OverrideSlot;
  fwd?: OverrideSlot;
  fwdRate?: OverrideSlot;
}

interface Leg {
  venue: 'deribit';
  instrumentName: string;
  qty: number;            // signed; sign = side
  overrides: LegOverrides;
}

// Greek column identity. "base" is the model's natural-units output (delta as
// a dimensionless ratio, gamma as 1/$, vega and theta in coin-space per
// vol-point and per-day respectively); "dollar" rescales each greek to a USD
// readout via the leg's forward (Δ·F, Γ·F², ν/100, Θ/365). Both are surfaced
// so a desk can mix conventions — e.g. "I quote delta in coin terms but I
// hedge with dollar gamma" is a single-row mental shift, not a tab toggle.
export type GreekColId =
  | 'delta_base' | 'delta_dollar'
  | 'gamma_base' | 'gamma_dollar'
  | 'vega_base' | 'vega_dollar'
  | 'theta_base' | 'theta_dollar';

interface QuickPricerConfig {
  legs: Leg[];
  mode: 'screen' | 'interpolated';
  perUnit: boolean;
  // Taker mode swaps the LIVE price source from Black-76(mark_iv) to the
  // screen bid/ask: a buy leg fills at the displayed ask, a sell leg fills at
  // the displayed bid. Greeks remain model-driven — taker is a P&L and
  // mid-vs-fill display tweak, not a re-derivation of the surface.
  taker: boolean;
  // Which greek columns to render. Order in the table follows
  // `GREEK_COL_ORDER` regardless of the array's order — the user's order is
  // not preserved across toggles, which keeps Δ/Γ/ν/Θ visually grouped even
  // after the user picks an oddball subset like just `['gamma_dollar']`.
  greekColumns: GreekColId[];
}

const GREEK_COL_ORDER: GreekColId[] = [
  'delta_base', 'delta_dollar',
  'gamma_base', 'gamma_dollar',
  'vega_base',  'vega_dollar',
  'theta_base', 'theta_dollar',
];

// Default greek panel: base delta (the trader's coin-delta intuition is the
// quickest read), dollar gamma + vega + theta (these are the P&L-impact
// quantities that desks risk-manage off — base versions of γ/ν/θ are mostly
// useful for cross-leg interpretability so we hide them by default).
const DEFAULT_GREEK_COLS: GreekColId[] = [
  'delta_base', 'gamma_dollar', 'vega_dollar', 'theta_dollar',
];

const DEFAULT_CONFIG: QuickPricerConfig = {
  legs: [],
  mode: 'screen',
  perUnit: false,
  taker: false,
  greekColumns: DEFAULT_GREEK_COLS,
};

interface GreekColDef {
  id: GreekColId;
  label: string;        // table header
  pickerLabel: string;  // shown in the toolbar's greeks picker
  title: string;        // tooltip on header & picker label
  decimals: number;
  // Compute the displayed value for one leg from its (already qty-scaled or
  // unscaled, depending on caller) greeks bundle and the matching forward.
  // Returns null when inputs aren't ready or are degenerate.
  legValue: (greeks: PricedLeg | null, fwd: number | null) => number | null;
}

const GREEK_COL_DEFS: Record<GreekColId, GreekColDef> = {
  delta_base: {
    id: 'delta_base', label: 'Δ', pickerLabel: 'Δ',
    title: 'Base delta = ∂P/∂F  (dimensionless ≈ coin-equivalent per 1 contract)',
    decimals: 3,
    legValue: (g) => g?.delta ?? null,
  },
  delta_dollar: {
    id: 'delta_dollar', label: 'Δ$', pickerLabel: 'Δ$',
    title: 'Dollar delta = Δ · F  ($ exposure per 100% spot move)',
    decimals: 0,
    legValue: (g, fwd) => (g != null && fwd != null && fwd > 0) ? g.delta * fwd : null,
  },
  gamma_base: {
    id: 'gamma_base', label: 'Γ', pickerLabel: 'Γ',
    title: 'Base gamma = ∂²P/∂F²  (1/$ — change in Δ per $1 forward move)',
    decimals: 6,
    legValue: (g) => g?.gamma ?? null,
  },
  gamma_dollar: {
    id: 'gamma_dollar', label: 'Γ$', pickerLabel: 'Γ$',
    title: 'Dollar gamma = Γ · F²  ($ change in $Δ per 100% spot move; ½·Γ$·m² is the convex pnl from a fractional move m)',
    decimals: 0,
    legValue: (g, fwd) => (g != null && fwd != null && fwd > 0) ? g.gamma * fwd * fwd : null,
  },
  vega_base: {
    id: 'vega_base', label: 'ν', pickerLabel: 'ν',
    title: 'Base vega = (ν/100)/F per vol point  (coin-equivalent per 1.0% absolute vol)',
    decimals: 5,
    legValue: (g, fwd) => (g != null && fwd != null && fwd > 0) ? (g.vega / 100) / fwd : null,
  },
  vega_dollar: {
    id: 'vega_dollar', label: 'ν$', pickerLabel: 'ν$',
    title: 'Dollar vega = ν/100  ($ per 1.0% absolute vol)',
    decimals: 2,
    legValue: (g) => g != null ? g.vega / 100 : null,
  },
  theta_base: {
    id: 'theta_base', label: 'Θ/d', pickerLabel: 'Θ/d',
    title: 'Base theta = (Θ/365)/F  (coin-equivalent per calendar day)',
    decimals: 6,
    legValue: (g, fwd) => (g != null && fwd != null && fwd > 0) ? (g.theta / 365) / fwd : null,
  },
  theta_dollar: {
    id: 'theta_dollar', label: 'Θ$/d', pickerLabel: 'Θ$/d',
    title: 'Dollar theta = Θ/365  ($ per calendar day)',
    decimals: 2,
    legValue: (g) => g != null ? g.theta / 365 : null,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Leg list mutation — pure helpers so the bus handler and the manual qty
// edits go through the same code path.
// ─────────────────────────────────────────────────────────────────────────────

function applyAddLeg(legs: Leg[], evt: AddLegEvent): Leg[] {
  const delta = evt.side * evt.qty;
  const idx = legs.findIndex(l => l.instrumentName === evt.instrumentName);
  if (idx < 0) {
    return [...legs, {
      venue: evt.venue, instrumentName: evt.instrumentName,
      qty: delta, overrides: {},
    }];
  }
  const newQty = legs[idx].qty + delta;
  if (newQty === 0) return legs.filter((_, i) => i !== idx);
  const next = [...legs];
  next[idx] = { ...next[idx], qty: newQty };
  return next;
}

function setLegQty(legs: Leg[], instrumentName: string, qty: number): Leg[] {
  if (qty === 0) return legs.filter(l => l.instrumentName !== instrumentName);
  return legs.map(l => l.instrumentName === instrumentName ? { ...l, qty } : l);
}

function removeLeg(legs: Leg[], instrumentName: string): Leg[] {
  return legs.filter(l => l.instrumentName !== instrumentName);
}

function setOverride(
  legs: Leg[], instrumentName: string,
  field: keyof LegOverrides,
  patch: Partial<OverrideSlot>,
): Leg[] {
  return legs.map(l => {
    if (l.instrumentName !== instrumentName) return l;
    const current = l.overrides[field] ?? { value: 0, active: false, touchedAt: 0 };
    const merged: OverrideSlot = {
      value: patch.value ?? current.value,
      active: patch.active ?? current.active,
      touchedAt: Date.now(),
    };
    let overrides: LegOverrides = { ...l.overrides, [field]: merged };

    // Two-of-three coupling: at most two of {spot, fwd, fwdRate} can be
    // active. Activating a third auto-deactivates the least-recently-touched
    // of the other two.
    if (merged.active && (field === 'spot' || field === 'fwd' || field === 'fwdRate')) {
      const triple: ('spot' | 'fwd' | 'fwdRate')[] = ['spot', 'fwd', 'fwdRate'];
      const others = triple.filter(k => k !== field);
      const activeOthers = others.filter(k => overrides[k]?.active);
      if (activeOthers.length === 2) {
        // Deactivate the older of the two.
        const [a, b] = activeOthers;
        const stale = (overrides[a]!.touchedAt < overrides[b]!.touchedAt) ? a : b;
        overrides = {
          ...overrides,
          [stale]: { ...overrides[stale]!, active: false, touchedAt: Date.now() },
        };
      }
    }
    return { ...l, overrides };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-leg pricing — combines live feeds + overrides, runs Black-76.
// ─────────────────────────────────────────────────────────────────────────────

interface LegRowData {
  leg: Leg;
  parsed: ReturnType<typeof parseInstrument>;
  // Live inputs (unmodified by overrides), nullable when feeds aren't ready yet.
  live: {
    chainRow: ChainRow | null;
    smileFit: SmileFit | null;
    fwd: number | null;
    spot: number | null;          // currently equals fwd (no spot index feed yet)
    fwdRate: number | null;       // 0 by default — no rate feed
    vol: number | null;
    t_years: number | null;
  };
  // Effective inputs after applying overrides + the two-of-three triangle rule.
  effective: {
    fwd: number | null;
    spot: number | null;
    fwdRate: number | null;
    vol: number | null;
  };
  livePrice: PricedLeg | null;       // Black-76 with `live` inputs
  overridePrice: PricedLeg | null;   // Black-76 with `effective` inputs (null if no overrides active)
  hasAnyOverride: boolean;
  // Taker price = the screen bid (when selling) or ask (when buying), in the
  // same USD-per-contract units as `livePrice.premium_fwd`. Used by the
  // "taker" toolbar toggle to display the realised premium at fill instead of
  // the model's mark-IV-derived theoretical.
  takerPremiumFwd: number | null;
  takerCoinPrice: number | null;     // bid/ask in fraction-of-fwd, for bps display
}

function computeLegRow(
  leg: Leg,
  chain: ChainSnapshot | null,
  smile: SmileSnapshot | null,
  mode: 'screen' | 'interpolated',
  nowMs: number,
): LegRowData {
  const parsed = parseInstrument(leg.instrumentName);
  const chainRow = chain
    ? chain.rows.find(r => r.instrument_name === leg.instrumentName) ?? null
    : null;
  const smileFit = smile?.fit ?? null;

  const fwd = chainRow?.underlying_price ?? null;
  const spot = fwd;   // no spot index feed yet (M2.5 deferred to M6)
  const fwdRate = 0;
  const expiryMs = parsed ? parseExpiryMs(parsed.expiry) : null;
  const t_years = (expiryMs != null && Number.isFinite(expiryMs))
    ? Math.max((expiryMs - nowMs) / MS_PER_YEAR, 0)
    : null;

  // Live vol = screen mode → mark_iv straight from chain row. SABR mode → use
  // the fitted curve evaluated at this leg's strike. If the SABR feed isn't
  // ready, fall back to mark_iv so the row still prices.
  let liveVol: number | null = chainRow?.mark_iv ?? null;
  if (mode === 'interpolated' && smileFit && smileFit.kind === 'sabr'
      && parsed && fwd != null && t_years != null && t_years > 0) {
    // M3.7: fit params live in the tagged-union `params` bag. We narrow on
    // `kind === 'sabr'` here; future SVI etc. legs would dispatch on a
    // different branch (or the calibration evaluator table once M3.99
    // wires the fair-curve readout).
    const p = smileFit.params;
    const sabrVol = sabrLognormalVol(
      parsed.strike, fwd, t_years,
      p.alpha, p.beta, p.rho, p.volvol,
    );
    if (sabrVol != null && Number.isFinite(sabrVol) && sabrVol > 0) liveVol = sabrVol;
  }

  // Effective inputs — apply overrides on top of live, then resolve the
  // {spot, fwd, fwdRate} triangle. The user is constrained to at most 2 of
  // the 3 active; the third is computed from F = S · exp(r·T).
  const ovr = leg.overrides;
  const eVol = ovr.vol?.active ? ovr.vol.value : liveVol;

  const eSpotAct = ovr.spot?.active ? ovr.spot.value : null;
  const eFwdAct = ovr.fwd?.active ? ovr.fwd.value : null;
  const eRateAct = ovr.fwdRate?.active ? ovr.fwdRate.value : null;

  let eFwd: number | null = eFwdAct ?? fwd;
  let eSpot: number | null = eSpotAct ?? spot;
  let eRate: number | null = eRateAct ?? fwdRate;

  // If exactly two overrides are active, derive the third. If fewer are
  // active, keep the live values for the unset ones (already done above).
  if (t_years != null && t_years > 0) {
    const activeCount = [eSpotAct, eFwdAct, eRateAct].filter(v => v != null).length;
    if (activeCount === 2) {
      if (eSpotAct == null && eFwdAct != null && eRateAct != null) {
        eSpot = eFwdAct * Math.exp(-eRateAct * t_years);
      } else if (eFwdAct == null && eSpotAct != null && eRateAct != null) {
        eFwd = eSpotAct * Math.exp(eRateAct * t_years);
      } else if (eRateAct == null && eSpotAct != null && eFwdAct != null && eSpotAct > 0) {
        eRate = Math.log(eFwdAct / eSpotAct) / t_years;
      }
    }
  }

  const cp: 1 | -1 = parsed?.optionType === 'C' ? 1 : -1;
  const livePrice = (parsed && fwd != null && liveVol != null && t_years != null)
    ? priceBlack76(cp, fwd, parsed.strike, t_years, liveVol, fwdRate ?? 0)
    : null;

  const hasAnyOverride = !!(
    ovr.vol?.active || ovr.spot?.active || ovr.fwd?.active || ovr.fwdRate?.active
  );
  const overridePrice = (hasAnyOverride && parsed && eFwd != null && eVol != null && t_years != null)
    ? priceBlack76(cp, eFwd, parsed.strike, t_years, eVol, eRate ?? 0)
    : null;

  // Taker fill price: long legs cross the ask, short legs hit the bid.
  // Stored as a coin-fraction (Deribit's native quote) and as a USD value
  // for the $LIVE column. Both are null until both bid+ask and fwd are live.
  const takerCoinPrice = leg.qty > 0
    ? chainRow?.ask_price ?? null
    : chainRow?.bid_price ?? null;
  const takerPremiumFwd = (takerCoinPrice != null && fwd != null && Number.isFinite(takerCoinPrice))
    ? takerCoinPrice * fwd
    : null;

  return {
    leg, parsed,
    live: { chainRow, smileFit, fwd, spot, fwdRate, vol: liveVol, t_years },
    effective: { fwd: eFwd, spot: eSpot, fwdRate: eRate, vol: eVol },
    livePrice, overridePrice, hasAnyOverride,
    takerPremiumFwd, takerCoinPrice,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Subscription wiring — group legs by (currency, expiry), one chain stream
// (and optional smile stream) per group. Multiple legs on the same expiry
// dedup at the oracle's refcount, so this is the cheapest fanout.
// ─────────────────────────────────────────────────────────────────────────────

interface ExpiryKey { currency: string; expiry: string; }

function uniqueExpiryKeys(legs: Leg[]): ExpiryKey[] {
  const keys = new Map<string, ExpiryKey>();
  for (const l of legs) {
    const p = parseInstrument(l.instrumentName);
    if (!p) continue;
    const k = `${p.currency}|${p.expiry}`;
    if (!keys.has(k)) keys.set(k, { currency: p.currency, expiry: p.expiry });
  }
  return [...keys.values()];
}

function keyOf(k: ExpiryKey): string { return `${k.currency}|${k.expiry}`; }

function useChainSnapshots(keys: ExpiryKey[]): Map<string, ChainSnapshot> {
  const [snaps, setSnaps] = useState<Map<string, ChainSnapshot>>(new Map());
  // Stable string key for the dep array — useEffect's identity comparison
  // would re-run on every render otherwise.
  const depKey = keys.map(keyOf).sort().join(',');
  useEffect(() => {
    const ctrls: AbortController[] = [];
    const wantedKeys = new Set(keys.map(keyOf));
    setSnaps(prev => {
      // Drop snapshots for expiries no longer in the leg set.
      const next = new Map<string, ChainSnapshot>();
      for (const [k, v] of prev) if (wantedKeys.has(k)) next.set(k, v);
      return next;
    });
    for (const k of keys) {
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      (async () => {
        try {
          for await (const s of chainStream(k.currency, k.expiry)) {
            if (ctrl.signal.aborted) break;
            setSnaps(prev => {
              const next = new Map(prev);
              next.set(keyOf(k), s);
              return next;
            });
          }
        } catch { /* swallow — leg row will just stay un-priced */ }
      })();
    }
    return () => { for (const c of ctrls) c.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey]);
  return snaps;
}

function useSmileSnapshots(keys: ExpiryKey[]): Map<string, SmileSnapshot> {
  const [snaps, setSnaps] = useState<Map<string, SmileSnapshot>>(new Map());
  const depKey = keys.map(keyOf).sort().join(',');
  useEffect(() => {
    const ctrls: AbortController[] = [];
    const wantedKeys = new Set(keys.map(keyOf));
    setSnaps(prev => {
      const next = new Map<string, SmileSnapshot>();
      for (const [k, v] of prev) if (wantedKeys.has(k)) next.set(k, v);
      return next;
    });
    for (const k of keys) {
      const ctrl = new AbortController();
      ctrls.push(ctrl);
      (async () => {
        try {
          // Canonical id (not the `sabr-naive` alias) so QuickPricer shares
          // the oracle's WS conversation refcount with any open SmileChart
          // on the same (currency, expiry) — both end up on one backend fit.
          for await (const s of smileStream(k.currency, k.expiry, 'sabr_none_uniform_cal', null)) {
            if (ctrl.signal.aborted) break;
            setSnaps(prev => {
              const next = new Map(prev);
              next.set(keyOf(k), s);
              return next;
            });
          }
        } catch { /* swallow */ }
      })();
    }
    return () => { for (const c of ctrls) c.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depKey]);
  return snaps;
}

// ─────────────────────────────────────────────────────────────────────────────
// Widget
// ─────────────────────────────────────────────────────────────────────────────

// Strip unknown ids and dedupe — saved profiles or a downgraded codebase can
// hand us junk; render falls back to the empty list rather than crashing.
function sanitizeGreekColumns(ids: unknown): GreekColId[] {
  if (!Array.isArray(ids)) return DEFAULT_GREEK_COLS;
  const seen = new Set<string>();
  const out: GreekColId[] = [];
  for (const id of ids) {
    if (typeof id !== 'string') continue;
    if (!(id in GREEK_COL_DEFS)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id as GreekColId);
  }
  return out;
}

function QuickPricer({ instanceId, config, onConfigChange }: WidgetProps<QuickPricerConfig>) {
  // Singleton registration — the header gates "+ Quick Pricer" on this.
  useEffect(() => registerQuickPricer(instanceId), [instanceId]);

  // Bus → leg events. The handler reads the latest config via a ref; the
  // useEffect captures it once on mount and would otherwise apply edits to
  // a stale leg list.
  const configRef = useRef(config);
  configRef.current = config;
  const onConfigChangeRef = useRef(onConfigChange);
  onConfigChangeRef.current = onConfigChange;

  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const evt of busSubscribe<AddLegEvent>(Topics.quickPricerAddLeg)) {
          if (ctrl.signal.aborted) break;
          if (!evt || evt.venue !== 'deribit' || !evt.instrumentName) continue;
          const cur = configRef.current;
          const nextLegs = applyAddLeg(cur.legs, evt);
          onConfigChangeRef.current({ ...cur, legs: nextLegs });
        }
      } catch { /* noop */ }
    })();
    return () => ctrl.abort();
  }, []);

  // One-tick wall clock for `t_years` recomputation. 1s is fine — the chain
  // poll cadence is 2s, and the option time-to-expiry barely moves at sub-s.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const expiryKeys = useMemo(() => uniqueExpiryKeys(config.legs), [config.legs]);
  const chainSnaps = useChainSnapshots(expiryKeys);
  const smileKeys = config.mode === 'interpolated' ? expiryKeys : [];
  const smileSnaps = useSmileSnapshots(smileKeys);

  const rows = useMemo(() => config.legs.map(leg => {
    const p = parseInstrument(leg.instrumentName);
    const k = p ? `${p.currency}|${p.expiry}` : '';
    return computeLegRow(
      leg,
      chainSnaps.get(k) ?? null,
      smileSnaps.get(k) ?? null,
      config.mode,
      nowMs,
    );
  }), [config.legs, chainSnaps, smileSnaps, config.mode, nowMs]);

  // Per-unit denominator: minimum |qty| across legs. Single-leg packages
  // collapse to the leg's own qty so per-unit equals per-package.
  const unitDenom = useMemo(() => {
    if (!config.perUnit || config.legs.length === 0) return 1;
    let m = Infinity;
    for (const l of config.legs) m = Math.min(m, Math.abs(l.qty));
    return Number.isFinite(m) && m > 0 ? m : 1;
  }, [config.perUnit, config.legs]);

  // Totals — sum live and override premiums across legs (signed by qty).
  const totals = useMemo(() => sumTotals(rows, unitDenom, config.taker), [rows, unitDenom, config.taker]);

  // Sanitised + canonically-ordered greek column list for the table.
  const greekColumns = useMemo(() => {
    const set = new Set(sanitizeGreekColumns(config.greekColumns));
    return GREEK_COL_ORDER.filter(id => set.has(id));
  }, [config.greekColumns]);

  const [showGreekPicker, setShowGreekPicker] = useState(false);

  const updateConfig = (patch: Partial<QuickPricerConfig>) => onConfigChange({ ...config, ...patch });
  const setLegs = (legs: Leg[]) => onConfigChange({ ...config, legs });
  const setGreekCols = (next: GreekColId[]) => onConfigChange({ ...config, greekColumns: next });

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg)', color: 'var(--fg)',
      fontFamily: 'var(--font-data)', fontVariantNumeric: 'tabular-nums',
      fontSize: 11,
    }}>
      <Toolbar
        config={config}
        onUpdate={updateConfig}
        onClear={() => setLegs([])}
        onToggleGreekPicker={() => setShowGreekPicker(v => !v)}
        greekPickerOpen={showGreekPicker}
      />
      {showGreekPicker && (
        <GreekPicker
          selected={greekColumns}
          onChange={setGreekCols}
          onReset={() => setGreekCols([...DEFAULT_GREEK_COLS])}
        />
      )}
      {config.legs.length === 0 ? (
        <EmptyState />
      ) : (
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
          <LegsTable
            rows={rows}
            mode={config.mode}
            perUnit={config.perUnit}
            taker={config.taker}
            greekColumns={greekColumns}
            unitDenom={unitDenom}
            totals={totals}
            onSetQty={(name, qty) => setLegs(setLegQty(config.legs, name, qty))}
            onRemove={name => setLegs(removeLeg(config.legs, name))}
            onOverride={(name, field, patch) => setLegs(setOverride(config.legs, name, field, patch))}
          />
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Toolbar
// ─────────────────────────────────────────────────────────────────────────────

function Toolbar({
  config, onUpdate, onClear, onToggleGreekPicker, greekPickerOpen,
}: {
  config: QuickPricerConfig;
  onUpdate: (p: Partial<QuickPricerConfig>) => void;
  onClear: () => void;
  onToggleGreekPicker: () => void;
  greekPickerOpen: boolean;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '4px 10px', borderBottom: '1px solid var(--border)',
      background: 'var(--bg-1)', flexShrink: 0, height: 28,
    }}>
      <label style={chk}>
        <input
          type="checkbox"
          checked={config.mode === 'interpolated'}
          onChange={e => onUpdate({ mode: e.target.checked ? 'interpolated' : 'screen' })}
        />
        <span>interpolated</span>
      </label>
      <label style={chk}>
        <input
          type="checkbox"
          checked={config.perUnit}
          onChange={e => onUpdate({ perUnit: e.target.checked })}
        />
        <span>per-unit</span>
      </label>
      <label
        style={chk}
        title="Use the screen bid (sells) / ask (buys) for $LIVE instead of mark"
      >
        <input
          type="checkbox"
          checked={config.taker}
          onChange={e => onUpdate({ taker: e.target.checked })}
        />
        <span>taker</span>
      </label>
      <div style={{ flex: 1 }} />
      <button
        onClick={onToggleGreekPicker}
        title="Choose which greek columns to display"
        style={{
          ...btn,
          color: greekPickerOpen ? 'var(--fg)' : 'var(--fg-mute)',
          borderColor: greekPickerOpen ? 'var(--accent)' : 'var(--border)',
        }}
      >greeks…</button>
      <span style={{ color: 'var(--fg-mute)' }}>
        {config.legs.length} {config.legs.length === 1 ? 'leg' : 'legs'}
      </span>
      <button
        onClick={onClear}
        disabled={config.legs.length === 0}
        style={{ ...btn, opacity: config.legs.length === 0 ? 0.4 : 1 }}
      >clear</button>
    </div>
  );
}

function GreekPicker({
  selected, onChange, onReset,
}: {
  selected: GreekColId[];
  onChange: (ids: GreekColId[]) => void;
  onReset: () => void;
}) {
  const set = new Set(selected);
  const isDefault = selected.length === DEFAULT_GREEK_COLS.length
    && DEFAULT_GREEK_COLS.every((id, i) => id === selected[i]);
  return (
    <div style={{
      padding: '4px 10px', borderBottom: '1px solid var(--border)',
      background: 'var(--bg-1)', display: 'flex', flexWrap: 'wrap',
      gap: 10, alignItems: 'center',
    }}>
      <span style={{ color: 'var(--fg-mute)', fontSize: 9, letterSpacing: '0.10em' }}>GREEKS</span>
      {GREEK_COL_ORDER.map(id => {
        const def = GREEK_COL_DEFS[id];
        const checked = set.has(id);
        return (
          <label
            key={id} title={def.title}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer', userSelect: 'none' }}
          >
            <input
              type="checkbox" checked={checked}
              onChange={() => {
                const next = checked
                  ? selected.filter(c => c !== id)
                  : [...selected, id];
                onChange(next);
              }}
            />
            <span style={{ color: checked ? 'var(--fg)' : 'var(--fg-mute)' }}>{def.pickerLabel}</span>
          </label>
        );
      })}
      <div style={{ flex: 1 }} />
      <button
        onClick={onReset}
        disabled={isDefault}
        title="Reset to default: Δ, Γ$, ν$, Θ$/d"
        style={{ ...btn, opacity: isDefault ? 0.4 : 1 }}
      >default</button>
    </div>
  );
}

function EmptyState() {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      color: 'var(--fg-mute)', fontSize: 11, textAlign: 'center', padding: 20, gap: 6,
    }}>
      <div style={{ color: 'var(--fg-dim)', fontSize: 12 }}>no legs</div>
      <div>click + (buy) or − (sell) on a chain row to add a leg</div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// LegsTable
// ─────────────────────────────────────────────────────────────────────────────

interface LegsTableProps {
  rows: LegRowData[];
  mode: 'screen' | 'interpolated';
  perUnit: boolean;
  taker: boolean;
  greekColumns: GreekColId[];
  unitDenom: number;
  totals: Totals;
  onSetQty: (instrumentName: string, qty: number) => void;
  onRemove: (instrumentName: string) => void;
  onOverride: (instrumentName: string, field: keyof LegOverrides, patch: Partial<OverrideSlot>) => void;
}

function LegsTable(p: LegsTableProps) {
  const showOverridePrice = p.rows.some(r => r.hasAnyOverride);

  return (
    <table style={{
      width: '100%', borderCollapse: 'collapse', fontSize: 10,
      tableLayout: 'auto',
    }}>
      <thead>
        <tr style={{ position: 'sticky', top: 0, background: 'var(--bg-1)', zIndex: 1 }}>
          <Th></Th>
          <Th align="left">LEG</Th>
          <Th align="center">QTY</Th>
          <Th>VOL</Th>
          <Th title="live vol">~vol</Th>
          <Th>FWD</Th>
          <Th title="live forward">~fwd</Th>
          <Th>SPOT</Th>
          <Th title="live spot">~spot</Th>
          <Th>RATE</Th>
          <Th title="live rate">~r</Th>
          <Th title={p.taker
            ? 'Taker fill: long crosses ask, short hits bid (USD)'
            : 'Theoretical at mark IV (USD)'}>$LIVE</Th>
          <Th title={p.taker
            ? 'Taker price as bps of forward (1 bp = 1e-4 of underlying)'
            : 'Theoretical price as bps of forward (1 bp = 1e-4 of underlying)'}>bps</Th>
          {showOverridePrice && <Th title="Theoretical USD with overrides applied">$OVR</Th>}
          {p.greekColumns.map(id => {
            const def = GREEK_COL_DEFS[id];
            return <Th key={id} title={def.title}>{def.label}</Th>;
          })}
          <Th></Th>
        </tr>
      </thead>
      <tbody>
        {p.rows.map(r => (
          <LegRow
            key={r.leg.instrumentName} row={r} perUnit={p.perUnit} unitDenom={p.unitDenom}
            showOverridePrice={showOverridePrice} taker={p.taker}
            greekColumns={p.greekColumns}
            onSetQty={p.onSetQty} onRemove={p.onRemove} onOverride={p.onOverride}
          />
        ))}
        <TotalsRow
          totals={p.totals} taker={p.taker}
          showOverridePrice={showOverridePrice} greekColumns={p.greekColumns}
        />
      </tbody>
    </table>
  );
}

function Th({ children, align, title }: { children?: React.ReactNode; align?: 'left' | 'center' | 'right'; title?: string }) {
  return (
    <th
      title={title}
      style={{
        textAlign: align ?? 'right', color: 'var(--fg-mute)',
        fontWeight: 500, fontSize: 9, letterSpacing: '0.10em',
        padding: '4px 6px', borderBottom: '1px solid var(--border)',
        whiteSpace: 'nowrap',
      }}
    >{children}</th>
  );
}

interface LegRowProps {
  row: LegRowData;
  perUnit: boolean;
  unitDenom: number;
  showOverridePrice: boolean;
  taker: boolean;
  greekColumns: GreekColId[];
  onSetQty: (name: string, qty: number) => void;
  onRemove: (name: string) => void;
  onOverride: (name: string, field: keyof LegOverrides, patch: Partial<OverrideSlot>) => void;
}

function LegRow({ row, perUnit, unitDenom, showOverridePrice, taker, greekColumns, onSetQty, onRemove, onOverride }: LegRowProps) {
  const { leg, parsed, live, livePrice, overridePrice, hasAnyOverride, takerPremiumFwd, takerCoinPrice } = row;
  const tripleActiveCount = ['spot', 'fwd', 'fwdRate']
    .filter(f => leg.overrides[f as keyof LegOverrides]?.active).length;
  const tripleLocked = (field: 'spot' | 'fwd' | 'fwdRate') =>
    !leg.overrides[field]?.active && tripleActiveCount >= 2;

  const qtyScale = perUnit ? (1 / unitDenom) : 1;
  const sign = leg.qty < 0 ? -1 : 1;
  const sigQty = Math.abs(leg.qty) * qtyScale * sign;

  const livePriceForDisplay = livePrice ? scalePriced(livePrice, leg.qty * qtyScale) : null;
  const overridePriceForDisplay = overridePrice ? scalePriced(overridePrice, leg.qty * qtyScale) : null;

  // $LIVE source: taker mode uses the screen fill (bid for sells, ask for
  // buys); the bps column derives from whichever USD figure is shown so a
  // user comparing "live theoretical bps vs taker bps" reads the difference
  // directly instead of mentally toggling the price field.
  const livePremiumUsd = taker
    ? (takerPremiumFwd != null ? takerPremiumFwd * leg.qty * qtyScale : null)
    : (livePriceForDisplay?.premium_fwd ?? null);
  const liveBps = taker
    ? (takerCoinPrice != null ? takerCoinPrice * 10_000 : null)
    : (livePrice && live.fwd != null && live.fwd > 0
        ? (livePrice.premium_fwd / live.fwd) * 10_000
        : null);

  // Greeks always live per spec — overrides freeze SOME inputs but the others
  // still tick, so the user can read "what if vol were 60% but spot moves" by
  // pinning vol and watching the greeks. Taker mode does NOT re-derive greeks
  // from the bid/ask: those would need an implied-vol solve, and the model's
  // mark-IV greeks are what risk reports off of anyway.
  const priceForGreeks = (hasAnyOverride && overridePrice) ? overridePrice : livePrice;
  const greeks = priceForGreeks ? scalePriced(priceForGreeks, leg.qty * qtyScale) : null;
  // Forward used to dollarise the greeks: with active overrides the greeks
  // come from `overridePrice` (computed against `effective.fwd`), so we must
  // multiply by that same forward to stay self-consistent.
  const greekFwd = (hasAnyOverride && overridePrice && row.effective.fwd != null)
    ? row.effective.fwd
    : (live.fwd ?? null);

  return (
    <tr style={{
      borderBottom: '1px solid var(--border)',
      background: leg.qty > 0 ? 'transparent' : 'var(--bg-1)',
    }}>
      <Td align="center" style={{ width: 18 }}>
        <button
          onClick={() => onRemove(leg.instrumentName)}
          title="Remove leg"
          style={{ ...btnIcon, color: 'var(--fg-mute)' }}
        >×</button>
      </Td>
      <Td align="left">
        <span style={{ color: 'var(--fg)' }}>{leg.instrumentName}</span>
        <span style={{ color: 'var(--fg-mute)', marginLeft: 6 }}>
          {parsed?.optionType === 'C' ? 'call' : 'put'}
        </span>
      </Td>
      <Td align="center">
        <QtyEditor qty={leg.qty} onChange={q => onSetQty(leg.instrumentName, q)} displayed={sigQty} perUnit={perUnit} />
      </Td>
      <OverrideCell slot={leg.overrides.vol} placeholder={live.vol} percent
        onChange={p => onOverride(leg.instrumentName, 'vol', p)} />
      <Td>{fmt(live.vol, 4, 'pct')}</Td>
      <OverrideCell slot={leg.overrides.fwd} placeholder={live.fwd} locked={tripleLocked('fwd')}
        onChange={p => onOverride(leg.instrumentName, 'fwd', p)} />
      <Td>{fmt(live.fwd, 2)}</Td>
      <OverrideCell slot={leg.overrides.spot} placeholder={live.spot} locked={tripleLocked('spot')}
        onChange={p => onOverride(leg.instrumentName, 'spot', p)} />
      <Td>{fmt(live.spot, 2)}</Td>
      <OverrideCell slot={leg.overrides.fwdRate} placeholder={live.fwdRate} locked={tripleLocked('fwdRate')}
        percent onChange={p => onOverride(leg.instrumentName, 'fwdRate', p)} />
      <Td>{fmt(live.fwdRate, 3, 'pct')}</Td>
      <Td title={taker ? 'Taker fill (signed by qty)' : 'Theoretical at mark IV (signed by qty)'}
        style={taker ? { color: 'var(--accent)' } : undefined}>
        {fmt(livePremiumUsd, 2)}
      </Td>
      <Td>{fmt(liveBps, 1)}</Td>
      {showOverridePrice && (
        <Td style={{ outline: hasAnyOverride ? '1px solid var(--accent)' : undefined }}>
          {hasAnyOverride ? fmt(overridePriceForDisplay?.premium_fwd, 2) : <span style={{ color: 'var(--fg-mute)' }}>—</span>}
        </Td>
      )}
      {greekColumns.map(id => {
        const def = GREEK_COL_DEFS[id];
        return <Td key={id} title={def.title}>{fmt(def.legValue(greeks, greekFwd), def.decimals)}</Td>;
      })}
      <Td></Td>
    </tr>
  );
}

function QtyEditor({ qty, onChange, displayed, perUnit }: { qty: number; onChange: (q: number) => void; displayed: number; perUnit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(qty));
  useEffect(() => { setDraft(String(qty)); }, [qty]);

  if (editing) {
    return (
      <input
        autoFocus type="number" step={1} value={draft}
        onChange={e => setDraft(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const n = Number(draft);
          if (Number.isFinite(n)) onChange(Math.trunc(n));
        }}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.currentTarget.blur(); }
          if (e.key === 'Escape') { setDraft(String(qty)); setEditing(false); }
        }}
        style={{ ...inp, width: 56, textAlign: 'center' }}
      />
    );
  }
  // Per-unit display can be fractional (a 100×200 spread shows 1×2 → 0.5
  // for the 100 leg if denom were 200). Default qty stays integer.
  const formatted = perUnit ? formatPerUnit(displayed) : displayed.toString();
  const color = qty > 0 ? 'var(--ask)' : 'var(--bid)';
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <button title="−1" onClick={() => onChange(qty - 1)} style={btnIcon}>−</button>
      <button
        onClick={() => setEditing(true)}
        title="Edit quantity"
        style={{ ...btnIcon, width: 'auto', minWidth: 22, color, fontWeight: 600 }}
      >{qty > 0 ? '+' : ''}{formatted}</button>
      <button title="+1" onClick={() => onChange(qty + 1)} style={btnIcon}>+</button>
    </div>
  );
}

function formatPerUnit(v: number): string {
  if (!Number.isFinite(v)) return '—';
  return Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2);
}

function OverrideCell({
  slot, placeholder, percent, locked, onChange,
}: {
  slot?: OverrideSlot;
  placeholder: number | null;
  percent?: boolean;
  locked?: boolean;
  onChange: (p: Partial<OverrideSlot>) => void;
}) {
  const active = !!slot?.active && !locked;
  const value = slot?.value ?? placeholder ?? 0;
  return (
    <td style={tdBase}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
        <input
          type="checkbox" checked={active} disabled={locked}
          title={locked ? 'Disabled by two-of-three rule' : (active ? 'Active override' : 'Use live value')}
          onChange={e => onChange({ active: e.target.checked })}
        />
        <input
          type="number" step={percent ? 0.01 : 0.5}
          value={Number.isFinite(value) ? (percent ? value * 100 : value) : ''}
          onChange={e => {
            const raw = e.target.value === '' ? NaN : Number(e.target.value);
            const v = percent ? raw / 100 : raw;
            onChange({ value: v, active: true });
          }}
          disabled={locked}
          style={{
            ...inp, width: 56, textAlign: 'right',
            opacity: active ? 1 : 0.45,
            color: active ? 'var(--fg)' : 'var(--fg-mute)',
          }}
        />
      </div>
    </td>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Totals row
// ─────────────────────────────────────────────────────────────────────────────

interface Totals {
  premLive: number;
  premOverride: number;
  // Package bps = Σ q_i · leg_bps_i. Each leg's bps is the per-contract
  // `premium / F` figure already shown in its row, so this sums to whatever
  // the trader gets by adding the signed leg bps in their head — a 1×1
  // vertical at +50/+30 reads as +20, not the smaller value the previous
  // `signed_$ / Σ|q|·F` definition produced (different denominator from
  // per-leg, so the column never reconciled).
  bpsLive: number;
  // Per-greek-column package totals. Each leg dollarises against its own
  // forward (mixed-expiry packages would otherwise mis-aggregate), then we
  // sum the qty-weighted contributions.
  greeks: Record<GreekColId, number>;
  hasOverride: boolean;
}

function emptyGreekTotals(): Record<GreekColId, number> {
  return {
    delta_base: 0, delta_dollar: 0,
    gamma_base: 0, gamma_dollar: 0,
    vega_base: 0,  vega_dollar: 0,
    theta_base: 0, theta_dollar: 0,
  };
}

function sumTotals(rows: LegRowData[], unitDenom: number, taker: boolean): Totals {
  let premLive = 0, premOverride = 0, bpsLive = 0;
  let hasOverride = false;
  const greeks = emptyGreekTotals();
  const scale = unitDenom > 0 ? 1 / unitDenom : 1;
  for (const r of rows) {
    const q = r.leg.qty * scale;

    // $LIVE + bps source share one selector so the two columns stay in
    // lockstep. Taker mode swaps each leg's premium for the screen fill;
    // when the bid/ask isn't available (illiquid strike), fall back to the
    // model's mark-IV theoretical so the totals aren't stuck at NaN.
    const liveUsd = taker && r.takerPremiumFwd != null
      ? r.takerPremiumFwd
      : r.livePrice?.premium_fwd ?? null;
    if (liveUsd != null) premLive += q * liveUsd;

    // legBps is the same per-1-contract figure each leg row shows; q-weighted
    // and signed so reading the leg bps top-down sums to the totals value.
    const legBps = taker && r.takerCoinPrice != null
      ? r.takerCoinPrice * 10_000
      : (r.livePrice && r.live.fwd != null && r.live.fwd > 0
          ? (r.livePrice.premium_fwd / r.live.fwd) * 10_000
          : null);
    if (legBps != null) bpsLive += q * legBps;

    const greeksSrc = (r.hasAnyOverride && r.overridePrice) ? r.overridePrice : r.livePrice;
    const greekFwd = (r.hasAnyOverride && r.overridePrice && r.effective.fwd != null)
      ? r.effective.fwd
      : r.live.fwd ?? null;
    if (greeksSrc) {
      for (const id of GREEK_COL_ORDER) {
        const v = GREEK_COL_DEFS[id].legValue(greeksSrc, greekFwd);
        if (v != null && Number.isFinite(v)) greeks[id] += q * v;
      }
    }
    if (r.hasAnyOverride) hasOverride = true;

    // Override $: prefer the override-priced figure when present, fall back
    // to live so the column doesn't blink to — on legs without overrides.
    const ovrUsd = r.overridePrice?.premium_fwd ?? r.livePrice?.premium_fwd ?? null;
    if (ovrUsd != null) premOverride += q * ovrUsd;
  }
  return { premLive, premOverride, bpsLive, greeks, hasOverride };
}

function TotalsRow({ totals, showOverridePrice, taker, greekColumns }: {
  totals: Totals; taker: boolean;
  showOverridePrice: boolean; greekColumns: GreekColId[];
}) {
  return (
    <tr style={{
      borderTop: '2px solid var(--border)',
      background: 'var(--bg-1)', color: 'var(--fg)', fontWeight: 600,
    }}>
      <Td></Td>
      <Td align="left" style={{ color: 'var(--fg-dim)', letterSpacing: '0.08em' }}>TOTAL</Td>
      <Td align="center"><span style={{ color: 'var(--fg-mute)' }}>—</span></Td>
      <Td colSpan={2}><span style={{ color: 'var(--fg-mute)' }}>—</span></Td>
      <Td colSpan={2}><span style={{ color: 'var(--fg-mute)' }}>—</span></Td>
      <Td colSpan={2}><span style={{ color: 'var(--fg-mute)' }}>—</span></Td>
      <Td colSpan={2}><span style={{ color: 'var(--fg-mute)' }}>—</span></Td>
      <Td title={taker ? 'Sum of taker fills (signed)' : 'Sum of theoretical premiums (signed)'}
        style={taker ? { color: 'var(--accent)' } : undefined}>
        {fmt(totals.premLive, 2)}
      </Td>
      <Td title="Σ q · (premium / F) · 1e4 — signed sum of per-leg bps so the totals reconcile with reading the column top-down">
        {fmt(totals.bpsLive, 1)}
      </Td>
      {showOverridePrice && (
        <Td title="Package $ with overrides applied (signed)">
          {totals.hasOverride ? fmt(totals.premOverride, 2) : <span style={{ color: 'var(--fg-mute)' }}>—</span>}
        </Td>
      )}
      {greekColumns.map(id => {
        const def = GREEK_COL_DEFS[id];
        return <Td key={id} title={def.title}>{fmt(totals.greeks[id], def.decimals)}</Td>;
      })}
      <Td></Td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Cell helpers + utilities
// ─────────────────────────────────────────────────────────────────────────────

const tdBase: React.CSSProperties = {
  padding: '3px 6px', textAlign: 'right',
  whiteSpace: 'nowrap', verticalAlign: 'middle',
};

function Td({ children, align, style, colSpan, title }: {
  children?: React.ReactNode; align?: 'left' | 'center' | 'right';
  style?: React.CSSProperties; colSpan?: number; title?: string;
}) {
  return (
    <td colSpan={colSpan} title={title}
      style={{ ...tdBase, textAlign: align ?? 'right', ...style }}
    >{children}</td>
  );
}

function fmt(value: number | null | undefined, decimals: number, kind?: 'pct'): React.ReactNode {
  if (value == null || !Number.isFinite(value)) {
    return <span style={{ color: 'var(--fg-mute)' }}>—</span>;
  }
  const v = kind === 'pct' ? value * 100 : value;
  const s = v.toFixed(decimals);
  return (
    <span>
      {s}
      {kind === 'pct' && <span style={{ color: 'var(--fg-mute)' }}>%</span>}
    </span>
  );
}

function scalePriced(p: PricedLeg, qty: number): PricedLeg {
  return {
    premium_fwd: p.premium_fwd * qty,
    delta: p.delta * qty,
    gamma: p.gamma * qty,
    vega: p.vega * qty,
    theta: p.theta * qty,
  };
}

const chk: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  cursor: 'pointer', userSelect: 'none', color: 'var(--fg-dim)',
};

const btn: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg-mute)', border: '1px solid var(--border)',
  borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11,
  fontFamily: 'var(--font-chrome)',
};

const btnIcon: React.CSSProperties = {
  background: 'transparent', border: '1px solid transparent',
  color: 'var(--fg-dim)', cursor: 'pointer', fontSize: 11,
  width: 18, height: 18, padding: 0, lineHeight: '14px', borderRadius: 2,
  fontFamily: 'var(--font-data)',
};

const inp: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)',
  borderRadius: 2, padding: '1px 4px', fontSize: 10,
  fontFamily: 'var(--font-data)', fontVariantNumeric: 'tabular-nums',
};

// ─────────────────────────────────────────────────────────────────────────────
// Registration
// ─────────────────────────────────────────────────────────────────────────────

registerWidget<QuickPricerConfig>({
  id: 'quickPricer',
  title: 'Quick Pricer',
  component: QuickPricer,
  defaultConfig: DEFAULT_CONFIG,
  // v1 → initial Quick Pricer (legs/mode/perUnit). v2 → `taker` toggle plus
  // LIVE bps column and dollar-greek relabelling. v3 → user-selectable greek
  // columns (8 variants, base + dollar for each greek). Migration preserves
  // any saved legs and toggles; missing fields fall back to safe defaults.
  configVersion: 3,
  migrate: (_fromVersion, oldConfig) => {
    if (!oldConfig || typeof oldConfig !== 'object') return DEFAULT_CONFIG;
    const o = oldConfig as Partial<QuickPricerConfig>;
    return {
      legs: Array.isArray(o.legs) ? o.legs : [],
      mode: o.mode === 'interpolated' ? 'interpolated' : 'screen',
      perUnit: !!o.perUnit,
      taker: !!o.taker,
      greekColumns: o.greekColumns ? sanitizeGreekColumns(o.greekColumns) : [...DEFAULT_GREEK_COLS],
    };
  },
  accentColor: ACCENT,
});
