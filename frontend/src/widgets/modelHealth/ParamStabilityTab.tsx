// ParamStabilityTab — small-multiples grid: rows = methodologies (filtered
// by the top-level toolbar), cols = selected params. Each cell is a
// sparkline + std-dev readout, sourced from M3.9's bucketed cache via
// smileBucketsStream. Single-expiry per spec — caller picks the expiry in
// this tab's settings row, the chart shows parameter stability over the
// last 24h for that one expiry.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MethodologySpec } from '../../worker/methodologyService';
import {
  smileBucketsStream, type SmileBucketEntry,
} from '../../worker/bucketsService';
import { sortExpiries, pickClosestExpiry } from '../../shared/expiry';
import { Sparkline } from './components/Sparkline';
import { extractParamSeries } from './aggregations';
import { COMPARE_PALETTE } from '../../shared/overlayUi';
import type { ModelHealthConfig, ParamStabilityTabState } from './types';

interface Props {
  config: ModelHealthConfig;
  onConfigChange: (next: ModelHealthConfig) => void;
  catalog: MethodologySpec[];
  expiries: string[];
}

const HOUR_MS = 60 * 60 * 1000;
const PARAM_OPTIONS = ['alpha', 'rho', 'volvol', 'beta'];

export function ParamStabilityTab({
  config, onConfigChange, catalog, expiries,
}: Props) {
  const tab = config.tabs.paramStability;
  const setTab = (next: Partial<ParamStabilityTabState>) =>
    onConfigChange({
      ...config,
      tabs: { ...config.tabs, paramStability: { ...tab, ...next } },
    });

  // Resolve expiry against the live list — recover gracefully if a saved
  // profile holds a rolled-off token.
  const sortedExpiries = useMemo(() => sortExpiries(expiries), [expiries]);
  useEffect(() => {
    if (sortedExpiries.length === 0) return;
    if (tab.expiry && sortedExpiries.includes(tab.expiry)) return;
    const next = pickClosestExpiry(tab.expiry, sortedExpiries);
    if (next && next !== tab.expiry) setTab({ expiry: next });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortedExpiries, tab.expiry]);

  // Memoize the sorted view so its identity is stable across renders —
  // downstream `wantedKeys` and the subscription effect both depend on this
  // reference, and a fresh array each render would re-run them needlessly.
  const methodologies = useMemo(
    () => catalog
      .filter(m =>
        config.selectedMethodologies.length === 0
        || config.selectedMethodologies.includes(m.id))
      .slice()
      .sort((a, b) => a.id.localeCompare(b.id)),
    [catalog, config.selectedMethodologies],
  );

  // Subscribe one bucketsStream per (symbol, expiry, methodology). Stable
  // per-key controller map: toggling one methodology only spawns/tears down
  // that one's bucket subscription — the others keep their already-streamed
  // history visible (HRT principle 6). Oracle dedup means another widget on
  // the same key (e.g. SmileChart with historyOverlayHours>0) shares the
  // upstream conversation.
  const [bucketMap, setBucketMap] = useState<Map<string, SmileBucketEntry[]>>(new Map());
  const lookbackMs = tab.lookbackHours * HOUR_MS;
  const ctrlsRef = useRef<Map<string, AbortController>>(new Map());

  // The lookback ride along in the dedup key so changing `LOOKBACK` tears
  // down old subscriptions and starts new ones at the new window. (Same
  // pattern as embedding `symbol` — a different upstream conversation per
  // distinct param tuple.)
  const wantedKeys = useMemo(() => {
    if (!tab.expiry) return [] as { id: string; basis: string; ts: string | null; key: string }[];
    return methodologies.map(m => ({
      id: m.id,
      basis: m.time_basis,
      ts: m.requires_ts ? `ts_atm_dmr_${m.time_basis}` : null,
      key: `${config.symbol}::${tab.expiry}::${tab.lookbackHours}::${m.id}`,
    }));
  }, [config.symbol, tab.expiry, tab.lookbackHours, methodologies]);

  useEffect(() => {
    const ctrls = ctrlsRef.current;
    const wantedSet = new Set(wantedKeys.map(w => w.key));

    for (const { id, ts, key } of wantedKeys) {
      if (ctrls.has(key)) continue;
      const ctrl = new AbortController();
      ctrls.set(key, ctrl);
      const expiry = tab.expiry!;
      (async () => {
        try {
          for await (const env of smileBucketsStream(
            config.symbol, expiry, id, ts, lookbackMs,
          )) {
            if (ctrl.signal.aborted) break;
            if (env.kind === 'snapshot') {
              setBucketMap(prev => {
                const next = new Map(prev);
                next.set(id, env.buckets);
                return next;
              });
            } else {
              setBucketMap(prev => {
                const next = new Map(prev);
                const cur = next.get(id) ?? [];
                const last = cur[cur.length - 1];
                const entry = { bucket_ts: env.bucket_ts, fit: env.fit };
                if (last && last.bucket_ts === env.bucket_ts) {
                  next.set(id, [...cur.slice(0, -1), entry]);
                } else {
                  next.set(id, [...cur, entry]);
                }
                return next;
              });
            }
          }
        } catch {
          // Empty cell renders as "no data".
        }
      })();
    }

    for (const [key, ctrl] of ctrls) {
      if (wantedSet.has(key)) continue;
      ctrl.abort();
      ctrls.delete(key);
      // Drop the methodology's stale bucket history. Tied to the key's id
      // segment (last colon-delimited part), not the symbol/expiry — those
      // changes invalidate every entry by definition (every key changes),
      // but a single-methodology toggle should only drop that one row.
      const id = key.split('::').slice(3).join('::');
      setBucketMap(prev => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }
  }, [config.symbol, tab.expiry, wantedKeys, lookbackMs]);

  useEffect(() => () => {
    for (const ctrl of ctrlsRef.current.values()) ctrl.abort();
    ctrlsRef.current.clear();
  }, []);

  // Per-column shared y-domain so all methodologies in a column align.
  const yDomains = useMemo(() => {
    const out: Record<string, [number, number]> = {};
    for (const p of tab.selectedParams) {
      const all: number[] = [];
      for (const m of methodologies) {
        const buckets = bucketMap.get(m.id) ?? [];
        for (const b of buckets) {
          const v = b.fit?.params[p];
          if (v != null && Number.isFinite(v)) all.push(v);
        }
      }
      if (all.length === 0) continue;
      out[p] = [Math.min(...all), Math.max(...all)];
    }
    return out;
  }, [bucketMap, tab.selectedParams, methodologies]);

  // Drop methodologies whose buckets are still empty across every selected
  // param — saves the user from a wall of "no data" sparklines while heavier
  // calibrators are still computing their first fits.
  const visibleMethodologies = methodologies.filter(m => {
    const buckets = bucketMap.get(m.id) ?? [];
    return tab.selectedParams.some(p =>
      buckets.some(b => {
        const v = b.fit?.params[p];
        return v != null && Number.isFinite(v);
      }));
  });
  const pendingCount = methodologies.length - visibleMethodologies.length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12, padding: 8, overflow: 'auto' }}>
      <SettingsRow
        tab={tab}
        setTab={setTab}
        sortedExpiries={sortedExpiries}
      />
      <div style={{
        display: 'grid',
        gridTemplateColumns: `220px repeat(${tab.selectedParams.length}, 1fr)`,
        gap: 6,
        fontFamily: 'var(--font-data)', fontSize: 11,
      }}>
        <div />
        {tab.selectedParams.map(p => (
          <div key={p} style={{
            color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em',
            textAlign: 'center',
          }}>{p.toUpperCase()}</div>
        ))}
        {visibleMethodologies.map((m, i) => (
          <RowSparklines
            key={m.id}
            methodology={m}
            params={tab.selectedParams}
            buckets={bucketMap.get(m.id) ?? []}
            yDomains={yDomains}
            color={COMPARE_PALETTE[i % COMPARE_PALETTE.length]}
          />
        ))}
      </div>
      {pendingCount > 0 && (
        <div style={{
          color: 'var(--fg-mute)', fontSize: 10, fontFamily: 'var(--font-chrome)',
          letterSpacing: '0.05em',
        }}>
          {pendingCount} methodolog{pendingCount === 1 ? 'y' : 'ies'} not shown
          — bucket history still seeding for slower calibrators.
        </div>
      )}
    </div>
  );
}

function RowSparklines({
  methodology, params, buckets, yDomains, color,
}: {
  methodology: MethodologySpec;
  params: string[];
  buckets: SmileBucketEntry[];
  yDomains: Record<string, [number, number]>;
  color: string;
}) {
  return (
    <>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        color: 'var(--fg)', fontSize: 11,
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }} title={methodology.id}>
        <span style={{
          width: 8, height: 8, borderRadius: 4, background: color, flexShrink: 0,
        }} />
        {methodology.label}
      </div>
      {params.map(p => {
        const series = extractParamSeries(buckets, p);
        return (
          <div key={p} style={{
            background: 'var(--bg-1)', padding: 4, position: 'relative',
            display: 'flex', flexDirection: 'column', gap: 2,
          }}>
            <Sparkline
              series={series}
              width={140}
              height={36}
              color={color}
              yDomain={yDomains[p]}
            />
            <div style={{
              display: 'flex', justifyContent: 'space-between',
              fontSize: 9, color: 'var(--fg-mute)',
            }}>
              <span>n={series.points.length}</span>
              {series.mean != null && (
                <span>μ={series.mean.toFixed(3)}</span>
              )}
              {series.std != null && (
                <span>σ={series.std.toFixed(3)}</span>
              )}
            </div>
          </div>
        );
      })}
    </>
  );
}

function SettingsRow({
  tab, setTab, sortedExpiries,
}: {
  tab: ParamStabilityTabState;
  setTab: (next: Partial<ParamStabilityTabState>) => void;
  sortedExpiries: string[];
}) {
  const toggleParam = (p: string) => {
    const has = tab.selectedParams.includes(p);
    setTab({
      selectedParams: has
        ? tab.selectedParams.filter(x => x !== p)
        : [...tab.selectedParams, p],
    });
  };
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      fontFamily: 'var(--font-chrome)', fontSize: 11,
    }}>
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>EXPIRY</span>
      <select
        value={tab.expiry ?? ''}
        onChange={e => setTab({ expiry: e.target.value || null })}
        style={selectStyle}
      >
        {sortedExpiries.length === 0 && <option value="">(none)</option>}
        {sortedExpiries.map(e => <option key={e} value={e}>{e}</option>)}
      </select>
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>LOOKBACK</span>
      <select
        value={tab.lookbackHours}
        onChange={e => setTab({ lookbackHours: Number(e.target.value) as ParamStabilityTabState['lookbackHours'] })}
        style={selectStyle}
      >
        <option value={6}>6h</option>
        <option value={12}>12h</option>
        <option value={24}>24h</option>
      </select>
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>PARAMS</span>
      {PARAM_OPTIONS.map(p => (
        <label key={p} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={tab.selectedParams.includes(p)}
            onChange={() => toggleParam(p)}
          />
          <span style={{ color: tab.selectedParams.includes(p) ? 'var(--fg)' : 'var(--fg-mute)' }}>{p}</span>
        </label>
      ))}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-1)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 3,
  padding: '2px 6px', fontSize: 11, fontFamily: 'var(--font-chrome)',
};
