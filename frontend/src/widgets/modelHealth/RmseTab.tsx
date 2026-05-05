// RmseTab — heatmap of (methodology × expiry) live residuals. Subscribes to
// one `smileStream` per cell on the current chain poll; oracle refcount
// dedups so other widgets on the same key share the upstream conversation
// (HRT principle 1). Calendar_rev rides on each envelope so a recalibrate
// refreshes wkg-basis cells without churning the open subscriptions
// (HRT principle 6).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MethodologySpec } from '../../worker/methodologyService';
import type { SmileSnapshot } from '../../worker/smileService';
import { smileStream } from '../../worker/smileService';
import { sortExpiries } from '../../shared/expiry';
import {
  Heatmap, makeRmseColor,
} from './components/Heatmap';
import {
  rowSummary, surfaceSummary, type RmseRowSummary,
} from './aggregations';
import type { RmseTabState, ModelHealthConfig } from './types';

interface Props {
  config: ModelHealthConfig;
  onConfigChange: (next: ModelHealthConfig) => void;
  catalog: MethodologySpec[];
  expiries: string[];
}


export function RmseTab({
  config, onConfigChange, catalog, expiries,
}: Props) {
  const tab = config.tabs.rmse;
  const setTab = (next: Partial<RmseTabState>) =>
    onConfigChange({ ...config, tabs: { ...config.tabs, rmse: { ...tab, ...next } } });

  // Resolve the toolbar's selected ids to spec rows that exist in the catalog.
  const methodologies = useMemo(
    () => catalog.filter(m =>
      config.selectedMethodologies.length === 0 ||
      config.selectedMethodologies.includes(m.id)),
    [catalog, config.selectedMethodologies],
  );
  // Sort methodologies for stable rendering: cal/wkg pairs adjacent.
  const sortedMethodologies = useMemo(() => {
    return [...methodologies].sort((a, b) => a.id.localeCompare(b.id));
  }, [methodologies]);

  // Apply expiry filter.
  const visibleExpiries = useMemo(() => {
    const sorted = sortExpiries(expiries);
    if (tab.expiryFilter.length === 0) return sorted;
    const set = new Set(tab.expiryFilter);
    return sorted.filter(e => set.has(e));
  }, [expiries, tab.expiryFilter]);

  // Subscribe to smileStream per (symbol, methodology, expiry). Including
  // `symbol` in the dedup key means a BTC→ETH switch tears down all live
  // streams cleanly via the same diff loop as a methodology toggle.
  const cellKeys = useMemo(() => {
    const keys: { methodology: MethodologySpec; expiry: string; key: string }[] = [];
    for (const m of sortedMethodologies) {
      for (const ex of visibleExpiries) {
        keys.push({
          methodology: m, expiry: ex,
          key: `${config.symbol}::${m.id}::${ex}`,
        });
      }
    }
    return keys;
  }, [config.symbol, sortedMethodologies, visibleExpiries]);

  // methodology id → expiry → snapshot
  const [snaps, setSnaps] = useState<Map<string, Map<string, SmileSnapshot>>>(
    new Map(),
  );

  // Stable per-key AbortController map (HRT principle 6). Toggling one
  // methodology or expiry only spawns/tears down the *delta*; existing cells
  // keep their open WS conversations and their already-rendered values
  // instead of all flashing back to "·" on every config edit.
  const ctrlsRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const ctrls = ctrlsRef.current;
    const wantedKeys = new Set<string>();

    for (const { methodology: m, expiry, key } of cellKeys) {
      wantedKeys.add(key);
      if (ctrls.has(key)) continue; // already streaming
      const ts = m.requires_ts ? `ts_atm_dmr_${m.time_basis}` : null;
      const ctrl = new AbortController();
      ctrls.set(key, ctrl);
      (async () => {
        try {
          for await (const s of smileStream(config.symbol, expiry, m.id, ts)) {
            if (ctrl.signal.aborted) break;
            setSnaps(prev => {
              const next = new Map(prev);
              const inner = new Map(next.get(m.id) ?? new Map());
              inner.set(expiry, s);
              next.set(m.id, inner);
              return next;
            });
          }
        } catch {
          // Failed cell stays empty — cell renders as "·".
        }
      })();
    }

    // Tear down streams whose keys are no longer wanted, and drop their
    // entry from `snaps` so stale cells don't linger after a filter narrows.
    for (const [key, ctrl] of ctrls) {
      if (wantedKeys.has(key)) continue;
      ctrl.abort();
      ctrls.delete(key);
      const parts = key.split('::');
      const mid = parts[1];
      const ex = parts[2];
      setSnaps(prev => {
        const inner = prev.get(mid);
        if (!inner?.has(ex)) return prev;
        const next = new Map(prev);
        const newInner = new Map(inner);
        newInner.delete(ex);
        if (newInner.size === 0) next.delete(mid);
        else next.set(mid, newInner);
        return next;
      });
    }
  }, [config.symbol, cellKeys]);

  // Final teardown on unmount.
  useEffect(() => () => {
    for (const ctrl of ctrlsRef.current.values()) ctrl.abort();
    ctrlsRef.current.clear();
  }, []);

  // Build the matrix of fits + summaries. Methodologies with zero successful
  // fits across every visible expiry are dropped from the rendered matrix —
  // when many methodologies are subscribed at once the heavier weighted
  // calibrators (atm-manual, bidask-spread*) can't keep up with the 2s
  // chain poll, so their rows would otherwise display as 13 columns of `·`.
  // The dropped count surfaces as "pending: N" in the corner so the user
  // knows the catalog isn't being silently filtered.
  const { rmseCells, rowSummaries, surfaceCell, allValues, visibleMethodologies, pendingCount } = useMemo(() => {
    const allValues: number[] = [];
    const rmseCells: { value: number | null; title?: string }[][] = [];
    const matrixFits: (import('../../worker/smileService').SmileFit | null)[][] = [];
    const visibleMethodologies: typeof sortedMethodologies = [];
    let pendingCount = 0;
    for (const m of sortedMethodologies) {
      const row: { value: number | null; title?: string }[] = [];
      const rowFits: (import('../../worker/smileService').SmileFit | null)[] = [];
      let rowHasFit = false;
      for (const ex of visibleExpiries) {
        const fit = snaps.get(m.id)?.get(ex)?.fit ?? null;
        rowFits.push(fit);
        if (fit && Number.isFinite(fit.residual_rms)) {
          rowHasFit = true;
          allValues.push(fit.residual_rms);
          row.push({
            value: fit.residual_rms,
            title: `${m.label} · ${ex}\n`
              + `RMSE = ${(fit.residual_rms * 100).toFixed(2)}%`
              + ` · n=${fit.market_iv.length}`
              + ` · t_cal=${fit.t_years_cal.toFixed(3)}y`
              + ` · t_wkg=${fit.t_years_wkg.toFixed(3)}y`,
          });
        } else {
          row.push({ value: null, title: `${m.label} · ${ex}\nno fit yet` });
        }
      }
      if (!rowHasFit) {
        pendingCount++;
        continue;
      }
      visibleMethodologies.push(m);
      rmseCells.push(row);
      matrixFits.push(rowFits);
    }
    const rowSummaries: RmseRowSummary[] =
      matrixFits.map(fits => rowSummary(fits, tab.rowWeighting));
    const surfaceCell = surfaceSummary(matrixFits, tab.rowWeighting);
    return {
      rmseCells, rowSummaries, surfaceCell, allValues,
      visibleMethodologies, pendingCount,
    };
  }, [sortedMethodologies, visibleExpiries, snaps, tab.rowWeighting]);

  const colorFor = useMemo(() => {
    if (tab.colorScale === 'per_row') {
      // Build a mapper per row from its own [min, max], then dispatch by
      // rowIndex at render time. Lets within-row variation stay legible
      // when methodologies have very different absolute residual levels
      // (e.g. atm-manual ~3% vs uniform ~0.5%).
      const perRow = rmseCells.map(row => {
        const rowVals = row
          .map(c => c.value)
          .filter((v): v is number => v != null && Number.isFinite(v));
        if (rowVals.length === 0) return makeRmseColor(0, 0.05);
        return makeRmseColor(Math.min(...rowVals), Math.max(...rowVals));
      });
      return (v: number | null, rowIndex: number) => {
        if (rowIndex < 0 || rowIndex >= perRow.length) {
          // Surface summary cell — fall back to global range so the corner
          // still ranks meaningfully against the matrix.
          return makeRmseColor(
            allValues.length ? Math.min(...allValues) : 0,
            allValues.length ? Math.max(...allValues) : 0.05,
          )(v);
        }
        return perRow[rowIndex](v);
      };
    }
    const lo = allValues.length === 0 ? 0 : Math.min(...allValues);
    const hi = allValues.length === 0 ? 0.05 : Math.max(...allValues);
    const m = makeRmseColor(lo, hi);
    return (v: number | null) => m(v);
  }, [rmseCells, allValues, tab.colorScale]);

  const formatValue = (v: number) => `${(v * 100).toFixed(2)}%`;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12, padding: 8, overflow: 'auto' }}>
      <SettingsRow
        tab={tab}
        setTab={setTab}
        catalogCount={catalog.length}
        allExpiries={sortExpiries(expiries)}
      />
      <div style={{ overflowX: 'auto' }}>
        <Heatmap
          rowLabels={visibleMethodologies.map(m => m.label)}
          colLabels={visibleExpiries}
          cells={rmseCells}
          rowSummary={rowSummaries.map(rs => ({ value: rs.mean }))}
          surfaceSummary={{ value: surfaceCell.mean }}
          cornerLabel={`surface (${surfaceCell.count} fits)`}
          formatValue={formatValue}
          colorFor={colorFor}
        />
      </div>
      {pendingCount > 0 && (
        <div style={{
          color: 'var(--fg-mute)', fontSize: 10, fontFamily: 'var(--font-chrome)',
          letterSpacing: '0.05em',
        }}>
          {pendingCount} methodolog{pendingCount === 1 ? 'y' : 'ies'} not shown — fits still computing.
          Heavier weighted calibrators (atm-manual, bidask-spread) can lag the
          2s chain poll when many are subscribed at once; rows appear as soon
          as their first fit lands.
        </div>
      )}
    </div>
  );
}

// ───────────────── settings row ─────────────────

function SettingsRow({
  tab, setTab, catalogCount, allExpiries,
}: {
  tab: RmseTabState;
  setTab: (next: Partial<RmseTabState>) => void;
  catalogCount: number;
  allExpiries: string[];
}) {
  void catalogCount;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      fontFamily: 'var(--font-chrome)', fontSize: 11,
    }}>
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>WEIGHTING</span>
      <select
        value={tab.rowWeighting}
        onChange={e => setTab({ rowWeighting: e.target.value as RmseTabState['rowWeighting'] })}
        style={selectStyle}
      >
        <option value="equal">equal</option>
        <option value="by_quotes">by quotes</option>
      </select>
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>SCALE</span>
      <select
        value={tab.colorScale}
        onChange={e => setTab({ colorScale: e.target.value as RmseTabState['colorScale'] })}
        style={selectStyle}
      >
        <option value="absolute">absolute</option>
        <option value="per_row">per row</option>
      </select>
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>EXPIRIES</span>
      <ExpiryFilter
        all={allExpiries}
        selected={tab.expiryFilter}
        onChange={next => setTab({ expiryFilter: next })}
      />
    </div>
  );
}

function ExpiryFilter({
  all, selected, onChange,
}: {
  all: string[]; selected: string[]; onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = selected.length === 0 ? 'all' : `${selected.length}/${all.length}`;
  const toggle = (e: string) => {
    const has = selected.includes(e);
    onChange(has ? selected.filter(x => x !== e) : [...selected, e]);
  };
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button onClick={() => setOpen(v => !v)} style={selectStyle}>{label} {open ? '▴' : '▾'}</button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 2,
          background: 'var(--bg-1)', border: '1px solid var(--border)',
          padding: 6, zIndex: 10, maxHeight: 280, overflowY: 'auto',
          fontFamily: 'var(--font-data)', fontSize: 11,
        }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
            <button onClick={() => onChange([])} style={selectStyle}>all</button>
            <button onClick={() => onChange(all.slice())} style={selectStyle}>none</button>
          </div>
          {all.map(e => (
            <label key={e} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={selected.length === 0 ? false : selected.includes(e)}
                onChange={() => toggle(e)}
              />
              <span>{e}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-1)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 3,
  padding: '2px 6px', fontSize: 11, fontFamily: 'var(--font-chrome)',
};

