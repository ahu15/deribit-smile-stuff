// VolTimeTab — cal-vs-wkg A/B view + holidays-in-life heatmap.
//
// Pair-residual panel: auto-pairs methodologies by their non-time-basis axes
// (sabr_<freeze>_<weights>) and renders ΔRMSE = wkg − cal per expiry per
// pair. Sign of Δ drives a diverging color: cool = wkg better, warm = cal
// better.
//
// Holidays-in-life panel: bucket each expiry by the count of holidays that
// fall inside (now → expiry) — cells are mean wkg-basis residual per
// (methodology × bucket). Sourced from the same live smileStream the RMSE
// tab uses; oracle dedup ensures a shared backend conversation.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { MethodologySpec } from '../../worker/methodologyService';
import type { SmileSnapshot } from '../../worker/smileService';
import { smileStream } from '../../worker/smileService';
import { calendarStream, type CalendarPayload } from '../../worker/calendarService';
import { sortExpiries } from '../../shared/expiry';
import { Heatmap, makeRmseColor, makeDeltaColor } from './components/Heatmap';
import {
  autoPairMethodologies, pairResiduals, holidaysHeatmap, holidaysInLife,
  bucketHolidays, type MethodologyPair,
} from './aggregations';
import type { ModelHealthConfig, VolTimeTabState } from './types';

interface Props {
  config: ModelHealthConfig;
  onConfigChange: (next: ModelHealthConfig) => void;
  catalog: MethodologySpec[];
  expiries: string[];
}

export function VolTimeTab({
  config, onConfigChange, catalog, expiries,
}: Props) {
  const tab = config.tabs.volTime;
  const setTab = (next: Partial<VolTimeTabState>) =>
    onConfigChange({ ...config, tabs: { ...config.tabs, volTime: { ...tab, ...next } } });

  // Auto-pair the full catalog, then narrow to the toolbar's selection (if
  // a user wants both halves of a pair shown at once they've already done
  // it via the top-level toolbar).
  const allPairs = useMemo(() => autoPairMethodologies(catalog), [catalog]);
  const visiblePairs = useMemo(() => {
    const sel = new Set(config.selectedMethodologies);
    let pairs = allPairs;
    if (sel.size > 0) {
      pairs = pairs.filter(p => sel.has(p.cal.id) || sel.has(p.wkg.id));
    }
    if (tab.pairFilter.length > 0) {
      const pf = new Set(tab.pairFilter);
      pairs = pairs.filter(p => pf.has(p.pairId));
    }
    return pairs;
  }, [allPairs, config.selectedMethodologies, tab.pairFilter]);

  const sortedExpiries = useMemo(() => sortExpiries(expiries), [expiries]);
  const visibleExpiries = useMemo(() => {
    if (tab.expiryFilter.length === 0) return sortedExpiries;
    const set = new Set(tab.expiryFilter);
    return sortedExpiries.filter(e => set.has(e));
  }, [sortedExpiries, tab.expiryFilter]);

  // Subscribe to live snapshots for every (symbol, methodology, expiry) the
  // visible pairs reference. Matrix is keyed methodology.id → expiry → snap.
  const cellKeys = useMemo(() => {
    const ms = new Set<string>();
    for (const p of visiblePairs) { ms.add(p.cal.id); ms.add(p.wkg.id); }
    // For the holidays panel, we still want every wkg-basis methodology
    // covered by the toolbar even if it doesn't have a paired cal variant.
    if (tab.panel === 'holidays_in_life') {
      const sel = new Set(config.selectedMethodologies);
      for (const m of catalog) {
        if (m.time_basis !== 'wkg') continue;
        if (sel.size > 0 && !sel.has(m.id)) continue;
        ms.add(m.id);
      }
    }
    const keys: { methodology: MethodologySpec; expiry: string; key: string }[] = [];
    for (const id of ms) {
      const m = catalog.find(x => x.id === id);
      if (!m) continue;
      for (const ex of visibleExpiries) {
        keys.push({
          methodology: m, expiry: ex,
          key: `${config.symbol}::${id}::${ex}`,
        });
      }
    }
    return keys;
  }, [config.symbol, visiblePairs, visibleExpiries, tab.panel, config.selectedMethodologies, catalog]);

  const [matrix, setMatrix] = useState<Map<string, Map<string, SmileSnapshot>>>(new Map());
  // Stable per-key AbortController map — same delta-only teardown pattern as
  // RmseTab so toggling pair filters / panels doesn't churn open conversations
  // (HRT principle 6).
  const ctrlsRef = useRef<Map<string, AbortController>>(new Map());

  useEffect(() => {
    const ctrls = ctrlsRef.current;
    const wantedKeys = new Set<string>();

    for (const { methodology: m, expiry, key } of cellKeys) {
      wantedKeys.add(key);
      if (ctrls.has(key)) continue;
      const ts = m.requires_ts ? `ts_atm_dmr_${m.time_basis}` : null;
      const ctrl = new AbortController();
      ctrls.set(key, ctrl);
      (async () => {
        try {
          for await (const s of smileStream(config.symbol, expiry, m.id, ts)) {
            if (ctrl.signal.aborted) break;
            setMatrix(prev => {
              const next = new Map(prev);
              const inner = new Map(next.get(m.id) ?? new Map());
              inner.set(expiry, s);
              next.set(m.id, inner);
              return next;
            });
          }
        } catch {
          // empty cell
        }
      })();
    }

    for (const [key, ctrl] of ctrls) {
      if (wantedKeys.has(key)) continue;
      ctrl.abort();
      ctrls.delete(key);
      const parts = key.split('::');
      const mid = parts[1];
      const ex = parts[2];
      setMatrix(prev => {
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

  useEffect(() => () => {
    for (const ctrl of ctrlsRef.current.values()) ctrl.abort();
    ctrlsRef.current.clear();
  }, []);

  // Calendar — feeds holidays-in-life bucketing.
  const [calendar, setCalendar] = useState<CalendarPayload | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    (async () => {
      try {
        for await (const c of calendarStream()) {
          if (ctrl.signal.aborted) break;
          setCalendar(c);
        }
      } catch {
        // calendar is optional for the heatmap; nulls collapse to bucket "0"
      }
    })();
    return () => ctrl.abort();
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 12, padding: 8, overflow: 'auto' }}>
      <SettingsRow
        tab={tab}
        setTab={setTab}
        allPairs={allPairs}
        sortedExpiries={sortedExpiries}
      />
      {tab.panel === 'pair_residual' ? (
        <PairResidualView pairs={visiblePairs} expiries={visibleExpiries} matrix={matrix} />
      ) : (
        <HolidaysInLifeView
          catalog={catalog}
          selected={config.selectedMethodologies}
          expiries={visibleExpiries}
          matrix={matrix}
          calendar={calendar}
        />
      )}
    </div>
  );
}

// ───────────────── pair residual panel ─────────────────

function PairResidualView({
  pairs, expiries, matrix,
}: {
  pairs: MethodologyPair[];
  expiries: string[];
  matrix: Map<string, Map<string, SmileSnapshot>>;
}) {
  if (pairs.length === 0) {
    return (
      <div style={{ color: 'var(--fg-mute)', fontSize: 11, padding: 8 }}>
        no cal/wkg pairs in selection
      </div>
    );
  }

  // Compute every Δ first to size the diverging color scale.
  const allDeltas: number[] = [];
  const perPairAll = pairs.map(p => {
    const cal = matrix.get(p.cal.id) ?? new Map<string, SmileSnapshot>();
    const wkg = matrix.get(p.wkg.id) ?? new Map<string, SmileSnapshot>();
    const rows = pairResiduals(expiries, cal, wkg);
    for (const r of rows) if (r.delta != null) allDeltas.push(r.delta);
    return { pair: p, rows };
  });
  // Drop pairs that have no fits in either half across every visible expiry —
  // when many methodologies are subscribed at once, the heavier weighted
  // calibrators can lag the chain poll. Showing 12 columns of `·` for those
  // pairs is noise rather than signal; surface the suppressed count instead.
  const perPair = perPairAll.filter(({ rows }) =>
    rows.some(r => r.cal_rmse != null || r.wkg_rmse != null));
  const pendingCount = perPairAll.length - perPair.length;
  const absMax = Math.max(0.005, ...allDeltas.map(d => Math.abs(d)));
  const colorFor = makeDeltaColor(absMax);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>
        ΔRMSE = wkg − cal &nbsp;·&nbsp;
        <span style={{ color: 'oklch(0.50 0.10 220)' }}>cool = wkg better</span> ·{' '}
        <span style={{ color: 'oklch(0.50 0.10 30)' }}>warm = cal better</span>
      </div>
      {perPair.map(({ pair, rows }) => (
        <PairCard key={pair.pairId} pair={pair} rows={rows} colorFor={colorFor} />
      ))}
      {pendingCount > 0 && (
        <div style={{
          color: 'var(--fg-mute)', fontSize: 10, fontFamily: 'var(--font-chrome)',
          letterSpacing: '0.05em',
        }}>
          {pendingCount} pair{pendingCount === 1 ? '' : 's'} not shown — fits still computing.
        </div>
      )}
    </div>
  );
}

function PairCard({
  pair, rows, colorFor,
}: {
  pair: MethodologyPair;
  rows: ReturnType<typeof pairResiduals>;
  colorFor: (v: number | null) => string;
}) {
  // Drop expiries where neither half has landed yet — same lag-suppression
  // rule the outer pair filter uses, applied per-column within a pair.
  const visibleRows = rows.filter(r => r.cal_rmse != null || r.wkg_rmse != null);
  const validDeltas = visibleRows.map(r => r.delta).filter((d): d is number => d != null);
  const meanDelta = validDeltas.length > 0
    ? validDeltas.reduce((a, b) => a + b, 0) / validDeltas.length
    : null;
  return (
    <div style={{ background: 'var(--bg-1)', padding: 8, border: '1px solid var(--border)' }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4,
        fontFamily: 'var(--font-chrome)', fontSize: 11,
      }}>
        <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{pair.pairId}</span>
        <span style={{ color: 'var(--fg-mute)', fontSize: 10 }}>
          {pair.cal.label} ↔ {pair.wkg.label}
        </span>
        <span style={{ flex: 1 }} />
        {meanDelta != null && (
          <span style={{
            color: meanDelta < 0 ? 'oklch(0.65 0.14 220)' : 'oklch(0.65 0.14 30)',
            fontFamily: 'var(--font-data)',
          }}>
            mean Δ = {(meanDelta * 100).toFixed(2)}%
            {meanDelta < 0 ? ' (wkg)' : ' (cal)'}
          </span>
        )}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <Heatmap
          rowLabels={['Δ RMSE', 'cal', 'wkg']}
          colLabels={visibleRows.map(r => r.expiry)}
          cells={[
            visibleRows.map(r => ({
              value: r.delta,
              title: r.delta != null ? `Δ = ${(r.delta * 100).toFixed(2)}%` : 'no data',
            })),
            visibleRows.map(r => ({ value: r.cal_rmse })),
            visibleRows.map(r => ({ value: r.wkg_rmse })),
          ]}
          formatValue={v => `${(v * 100).toFixed(2)}%`}
          colorFor={(v) => colorFor(v)}
          cellWidth={56}
          cellHeight={20}
          rowLabelWidth={84}
        />
      </div>
    </div>
  );
}

// ───────────────── holidays-in-life panel ─────────────────

function HolidaysInLifeView({
  catalog, selected, expiries, matrix, calendar,
}: {
  catalog: MethodologySpec[];
  selected: string[];
  expiries: string[];
  matrix: Map<string, Map<string, SmileSnapshot | undefined>>;
  calendar: CalendarPayload | null;
}) {
  const wkgInSelection = catalog.filter(m =>
    m.time_basis === 'wkg'
    && (selected.length === 0 || selected.includes(m.id)));
  // Drop wkg-basis methodologies whose matrix is still empty across every
  // visible expiry — same lag-suppression rule used elsewhere in the widget
  // so heavy weighted calibrators don't fill the heatmap with empty rows.
  const wkgSelection = wkgInSelection.filter(m => {
    const inner = matrix.get(m.id);
    if (!inner) return false;
    for (const ex of expiries) {
      const r = inner.get(ex)?.fit?.residual_rms;
      if (r != null && Number.isFinite(r)) return true;
    }
    return false;
  });
  const wkgPendingCount = wkgInSelection.length - wkgSelection.length;

  const nowMs = Date.now();
  const allBuckets = ['0', '1', '2+'] as const;

  // Count expiries per bucket and drop columns with zero — those would only
  // ever render as empty cells, which is correct-but-noisy. The default
  // calendar has no holidays defined, so the 1 / 2+ columns are guaranteed
  // empty until the user adds holidays in VolCalendar.
  const bucketCounts = allBuckets.map(b => ({
    bucket: b,
    count: expiries.filter(ex =>
      bucketHolidays(holidaysInLife(ex, nowMs, calendar)) === b).length,
  }));
  const visibleBuckets = bucketCounts.filter(bc => bc.count > 0);

  const cells = holidaysHeatmap(
    wkgSelection, matrix, expiries, nowMs, calendar,
  );
  const rmseValues = cells
    .map(c => c.mean_rmse)
    .filter((v): v is number => v != null);
  const colorFor = rmseValues.length > 0
    ? makeRmseColor(Math.min(...rmseValues), Math.max(...rmseValues))
    : makeRmseColor(0, 0.05);

  // Reshape `cells` into [rows][cols] using only the buckets that actually
  // have expiries.
  const rows = wkgSelection.map(m => {
    return visibleBuckets.map(({ bucket: b }) => {
      const c = cells.find(cell => cell.methodology === m.id && cell.bucket === b);
      return {
        value: c?.mean_rmse ?? null,
        title: c
          ? `${m.label} · ${b} holidays · n=${c.count}`
          : `${m.label} · ${b} holidays · no data`,
      };
    });
  });

  const colLabels = visibleBuckets.map(bc =>
    bc.bucket === '2+' ? '2+ holidays'
    : bc.bucket === '1' ? '1 holiday'
    : '0 holidays');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>
        WKG-BASIS RESIDUAL × HOLIDAYS-IN-LIFE
        {' · '}
        {bucketCounts.map(bc => `${bc.bucket}=${bc.count}`).join(' · ')}
        {' expiries'}
        {!calendar && ' · (calendar pending)'}
      </div>
      {wkgSelection.length === 0 ? (
        <div style={{ color: 'var(--fg-mute)', fontSize: 11, padding: 8 }}>
          no wkg-basis methodologies in selection
        </div>
      ) : visibleBuckets.length === 0 ? (
        <div style={{ color: 'var(--fg-mute)', fontSize: 11, padding: 8 }}>
          no expiries in any bucket — add holidays in VolCalendar to populate
          the 1 / 2+ columns.
        </div>
      ) : visibleBuckets.length === 1 ? (
        <div style={{ color: 'var(--fg-mute)', fontSize: 11, padding: 8 }}>
          all expiries fall in the "{colLabels[0]}" bucket — this view becomes
          informative once VolCalendar has holidays that fall inside the live
          expiry window. Add holidays to compare residuals across bucket sizes.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <Heatmap
            rowLabels={wkgSelection.map(m => m.label)}
            colLabels={colLabels}
            cells={rows}
            formatValue={v => `${(v * 100).toFixed(2)}%`}
            colorFor={colorFor}
            cellWidth={84}
          />
        </div>
      )}
      {wkgPendingCount > 0 && (
        <div style={{
          color: 'var(--fg-mute)', fontSize: 10, fontFamily: 'var(--font-chrome)',
          letterSpacing: '0.05em',
        }}>
          {wkgPendingCount} wkg-basis methodolog{wkgPendingCount === 1 ? 'y' : 'ies'} not shown — fits still computing.
        </div>
      )}
    </div>
  );
}

// ───────────────── settings row ─────────────────

function SettingsRow({
  tab, setTab, allPairs, sortedExpiries,
}: {
  tab: VolTimeTabState;
  setTab: (next: Partial<VolTimeTabState>) => void;
  allPairs: MethodologyPair[];
  sortedExpiries: string[];
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      fontFamily: 'var(--font-chrome)', fontSize: 11,
    }}>
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>VIEW</span>
      <select
        value={tab.panel}
        onChange={e => setTab({ panel: e.target.value as VolTimeTabState['panel'] })}
        style={selectStyle}
      >
        <option value="pair_residual">cal/wkg pair Δ</option>
        <option value="holidays_in_life">holidays-in-life</option>
      </select>
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>PAIRS</span>
      <PairFilter
        all={allPairs}
        selected={tab.pairFilter}
        onChange={next => setTab({ pairFilter: next })}
      />
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>EXPIRIES</span>
      <ExpiryFilter
        all={sortedExpiries}
        selected={tab.expiryFilter}
        onChange={next => setTab({ expiryFilter: next })}
      />
    </div>
  );
}

function PairFilter({
  all, selected, onChange,
}: {
  all: MethodologyPair[]; selected: string[]; onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = selected.length === 0 ? 'all' : `${selected.length}/${all.length}`;
  const toggle = (id: string) => {
    const has = selected.includes(id);
    onChange(has ? selected.filter(x => x !== id) : [...selected, id]);
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
            <button onClick={() => onChange(all.map(p => p.pairId))} style={selectStyle}>none</button>
          </div>
          {all.map(p => (
            <label key={p.pairId} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={selected.length === 0 ? false : selected.includes(p.pairId)}
                onChange={() => toggle(p.pairId)}
              />
              <span>{p.pairId}</span>
            </label>
          ))}
        </div>
      )}
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
                onChange={() => {
                  const has = selected.includes(e);
                  onChange(has ? selected.filter(x => x !== e) : [...selected, e]);
                }}
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
