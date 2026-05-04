// VolCalendar — manual entry surface for the vol-time / working-day
// calendar (M3.6). Single shared calendar across BTC + ETH for now.
//
// Layout:
//   * Toolbar — `recalibrate` button + revision pill + total-vol-days/yr.
//     Recalibrate is the *only* trigger that bumps the rev seen by cached
//     fits; raw edits flow as `putCalendar` and are visible to live fits
//     on the next 2s chain poll, but the M3.7/M3.9 bucketed cache stays
//     pinned to its rev until recalibrate is invoked.
//   * Weekday weights — two numeric inputs (Sat / Sun). Crypto trades
//     24/7 so the weekday rail reduces to "weekend dampening" in
//     practice; Mon-Fri are implicit 1.0.
//   * Holiday table — date input + preset dropdown + name + delete.
//     Adding a row pre-fills the weight from the chosen preset; "Custom"
//     exposes the numeric input.
//   * Diagnostics rail — per-expiry dte vs dte_wkg + ratio. Pulls the
//     known expiries from the chain stream (BTC + ETH merged so the
//     widget covers both currencies the system polls today).
//
// All calendar reads/writes go through `worker/calendarService.ts` so
// tabs never touch the FastAPI routes directly (HRT principle 1).
// Widget config carries no calendar data — the calendar is global, not
// per-widget; only display preferences (sort order etc.) live in
// `VolCalendarConfig`.

import { useEffect, useMemo, useState } from 'react';
import { registerWidget, type WidgetProps } from '../shell/widgetRegistry';
import {
  calendarStream, putCalendar, recalibrate,
  type CalendarPayload,
} from '../worker/calendarService';
import { fetchExpiries } from '../worker/chainService';
import { parseExpiryMs, sortExpiries } from '../shared/expiry';
import { HOLIDAY_PRESETS } from '../shared/calendarPresets';
import { calYte, totalVolDaysPerYear, volYte } from '../shared/volTime';

// localStorage key for the cross-session calendar mirror. Stored globally
// (NOT inside a Dockview profile) per spec — switching profiles must not
// secretly swap calendars under the user.
const STORAGE_KEY = 'deribit-smile:calendar:v1';

// Currencies whose expiries feed the diagnostics rail. Hard-coded for
// M3.6 because the backend only polls these two. M6 / Bloomberg expands
// the set; the diagnostics rail picks them up automatically once the
// per-currency `fetchExpiries` calls return more lists.
const DIAG_CURRENCIES: ('BTC' | 'ETH')[] = ['BTC', 'ETH'];

// ────────────────────────────────────────────────────────────────────────────
// Widget
// ────────────────────────────────────────────────────────────────────────────

// Calendar is global, not per-widget — the config is intentionally empty.
// Display-only preferences (sort order, etc.) can land here later if needed.
type VolCalendarConfig = Record<string, never>;
const DEFAULT_CONFIG: VolCalendarConfig = {};

function VolCalendar(_props: WidgetProps<VolCalendarConfig>) {
  const [calendar, setCalendar] = useState<CalendarPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'idle' | 'putting' | 'recalibrating'>('idle');
  const [expiries, setExpiries] = useState<Record<string, string[]>>({});

  // Backend is canonical for the active calendar; localStorage is a
  // paint-cache that just avoids a "loading…" flash on cold boot. The
  // first envelope from `calendarStream()` always overwrites whatever we
  // painted from localStorage, so a stale local copy never trumps the
  // server's current weights — the user sees the live calendar
  // immediately when they open the widget.
  useEffect(() => {
    let cancelled = false;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setCalendar(JSON.parse(raw) as CalendarPayload);
    } catch { /* ignore parse errors */ }

    (async () => {
      try {
        for await (const cal of calendarStream()) {
          if (cancelled) break;
          setCalendar(cal);
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cal)); }
          catch { /* quota / private mode */ }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // Pull expiries for the diagnostics rail.
  useEffect(() => {
    let cancelled = false;
    Promise.all(DIAG_CURRENCIES.map(async ccy => [ccy, await fetchExpiries(ccy)] as const))
      .then(pairs => {
        if (cancelled) return;
        const map: Record<string, string[]> = {};
        for (const [ccy, list] of pairs) map[ccy] = list;
        setExpiries(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const onPut = async (next: Omit<CalendarPayload, 'rev'>): Promise<void> => {
    setBusy('putting');
    setError(null);
    try {
      await putCalendar(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('idle');
    }
  };

  const onRecalibrate = async (): Promise<void> => {
    if (!calendar) return;
    setBusy('recalibrating');
    setError(null);
    try {
      await recalibrate();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy('idle');
    }
  };

  if (!calendar) {
    return <div style={{ padding: 12, color: 'var(--fg-mute)', fontSize: 11 }}>loading calendar…</div>;
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg)', color: 'var(--fg)',
      fontSize: 11, fontFamily: 'var(--font-data)',
      fontVariantNumeric: 'tabular-nums', overflow: 'hidden',
    }}>
      <Toolbar
        calendar={calendar}
        busy={busy}
        onRecalibrate={onRecalibrate}
      />
      {error && (
        <div style={{ padding: '4px 12px', color: 'var(--neg)', borderBottom: '1px solid var(--border)' }}>
          error: {error}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 14 }}>
        <WeekdaySection calendar={calendar} onPut={onPut} />
        <HolidaySection calendar={calendar} onPut={onPut} />
        <DiagnosticsSection calendar={calendar} expiriesByCcy={expiries} />
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Toolbar
// ────────────────────────────────────────────────────────────────────────────

function Toolbar({ calendar, busy, onRecalibrate }: {
  calendar: CalendarPayload;
  busy: 'idle' | 'putting' | 'recalibrating';
  onRecalibrate: () => void;
}) {
  const totalDays = useMemo(() => totalVolDaysPerYear(calendar), [calendar]);
  const onClick = (): void => {
    if (confirm(`Recalibrate at calendar rev ${calendar.rev}?`)) onRecalibrate();
  };
  const recalLabel = busy === 'recalibrating' ? 'recalibrating…' : 'recalibrate';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0,
      padding: '5px 12px', borderBottom: '1px solid var(--border)', background: 'var(--bg-1)',
    }}>
      <span style={{ color: 'var(--fg-dim)' }}>vol-time calendar</span>
      <span style={{
        background: 'var(--bg)', border: '1px solid var(--border)',
        borderRadius: 3, padding: '1px 6px', color: 'var(--fg-mute)',
        fontFamily: 'var(--font-data)',
      }} title="Calendar revision (SHA-1 of weights only — names don't bump it)">
        rev {calendar.rev || '—'}
      </span>
      <span style={{ color: 'var(--fg-mute)' }}>
        {totalDays.toFixed(1)} vol days / yr
      </span>
      {busy === 'putting' && <span style={{ color: 'var(--fg-mute)' }}>saving…</span>}
      <div style={{ flex: 1 }} />
      <button
        onClick={onClick}
        disabled={busy !== 'idle'}
        title="Recompute every wkg-basis cached fit under the current calendar rev"
        style={{
          ...btnStyle,
          opacity: busy !== 'idle' ? 0.5 : 1,
          cursor: busy !== 'idle' ? 'wait' : 'pointer',
        }}
      >{recalLabel}</button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Weekday weights
// ────────────────────────────────────────────────────────────────────────────

function WeekdaySection({ calendar, onPut }: {
  calendar: CalendarPayload;
  onPut: (next: Omit<CalendarPayload, 'rev'>) => Promise<void>;
}) {
  const onWeekendChange = (key: 'sat_weight' | 'sun_weight', value: number): void => {
    const sanitized = clampWeight(value);
    onPut({ ...stripRev(calendar), [key]: sanitized });
  };
  return (
    <Section title="weekday weights" subtitle="Mon–Fri implicit 1.0">
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <WeightInput
          label="Sat"
          value={calendar.sat_weight}
          onCommit={v => onWeekendChange('sat_weight', v)}
        />
        <WeightInput
          label="Sun"
          value={calendar.sun_weight}
          onCommit={v => onWeekendChange('sun_weight', v)}
        />
      </div>
    </Section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Holiday list
// ────────────────────────────────────────────────────────────────────────────

function HolidaySection({ calendar, onPut }: {
  calendar: CalendarPayload;
  onPut: (next: Omit<CalendarPayload, 'rev'>) => Promise<void>;
}) {
  const dates = useMemo(
    () => Object.keys(calendar.holiday_weights).sort(),  // ISO strings sort lexically
    [calendar.holiday_weights],
  );

  // Inline "add holiday" form state. Held locally so the calendar isn't
  // rev-bumped until the user actually commits.
  const [addDate, setAddDate] = useState<string>('');
  const [addPresetIdx, setAddPresetIdx] = useState<number>(0);
  const [addCustomWeight, setAddCustomWeight] = useState<number>(0.1);
  const [addName, setAddName] = useState<string>('');

  const addPreset = HOLIDAY_PRESETS[addPresetIdx];
  const addWeightValue = addPreset.weight ?? addCustomWeight;
  const canAdd = !!addDate && !calendar.holiday_weights[addDate]
    && Number.isFinite(addWeightValue);

  const onAdd = (): void => {
    if (!canAdd) return;
    const next = stripRev(calendar);
    next.holiday_weights = { ...next.holiday_weights, [addDate]: clampWeight(addWeightValue) };
    if (addName.trim()) {
      next.holiday_names = { ...next.holiday_names, [addDate]: addName.trim() };
    }
    void onPut(next);
    setAddDate('');
    setAddName('');
    setAddPresetIdx(0);
  };

  const onDelete = (iso: string): void => {
    const nextWeights = { ...calendar.holiday_weights };
    const nextNames = { ...calendar.holiday_names };
    delete nextWeights[iso];
    delete nextNames[iso];
    void onPut({
      holiday_weights: nextWeights,
      holiday_names: nextNames,
      sat_weight: calendar.sat_weight,
      sun_weight: calendar.sun_weight,
    });
  };

  const onWeightChange = (iso: string, value: number): void => {
    void onPut({
      ...stripRev(calendar),
      holiday_weights: { ...calendar.holiday_weights, [iso]: clampWeight(value) },
    });
  };

  const onNameChange = (iso: string, name: string): void => {
    const trimmed = name.trim();
    const nextNames = { ...calendar.holiday_names };
    if (trimmed) nextNames[iso] = trimmed;
    else delete nextNames[iso];
    void onPut({
      ...stripRev(calendar),
      holiday_names: nextNames,
    });
  };

  return (
    <Section title={`holidays (${dates.length})`} subtitle="explicit overrides — apply on top of weekday defaults">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '110px 1fr 110px 36px', gap: 8, color: 'var(--fg-mute)', padding: '0 4px' }}>
          <span>date</span>
          <span>name</span>
          <span>weight</span>
          <span />
        </div>
        {dates.length === 0 && (
          <div style={{ color: 'var(--fg-mute)', padding: '6px 4px', fontStyle: 'italic' }}>
            no holidays — weekend defaults apply
          </div>
        )}
        {dates.map(iso => (
          <HolidayRow
            key={iso}
            iso={iso}
            weight={calendar.holiday_weights[iso]}
            name={calendar.holiday_names[iso] ?? ''}
            onWeight={v => onWeightChange(iso, v)}
            onName={n => onNameChange(iso, n)}
            onDelete={() => onDelete(iso)}
          />
        ))}

        <div style={{
          display: 'grid', gridTemplateColumns: '110px 1fr 110px 36px', gap: 8,
          padding: '8px 4px 0 4px', borderTop: '1px solid var(--border)', marginTop: 6,
        }}>
          <input
            type="date"
            value={addDate}
            onChange={e => setAddDate(e.target.value)}
            style={inputStyle}
          />
          <input
            type="text"
            value={addName}
            onChange={e => setAddName(e.target.value)}
            placeholder="(optional name)"
            style={inputStyle}
          />
          <div style={{ display: 'flex', gap: 4 }}>
            <select
              value={addPresetIdx}
              onChange={e => setAddPresetIdx(parseInt(e.target.value, 10))}
              style={{ ...inputStyle, flex: 1 }}
            >
              {HOLIDAY_PRESETS.map((p, i) => (
                <option key={p.label} value={i}>{p.label}</option>
              ))}
            </select>
            {addPreset.weight === null && (
              <input
                type="number"
                step="0.05"
                min={0}
                max={1}
                value={addCustomWeight}
                onChange={e => setAddCustomWeight(parseFloat(e.target.value) || 0)}
                style={{ ...inputStyle, width: 50 }}
              />
            )}
          </div>
          <button
            onClick={onAdd}
            disabled={!canAdd}
            title={canAdd ? 'Add holiday' : 'Pick a date first (or this date already has an entry)'}
            style={{ ...btnStyle, opacity: canAdd ? 1 : 0.4, cursor: canAdd ? 'pointer' : 'not-allowed' }}
          >+</button>
        </div>
      </div>
    </Section>
  );
}

function HolidayRow({ iso, weight, name, onWeight, onName, onDelete }: {
  iso: string;
  weight: number;
  name: string;
  onWeight: (v: number) => void;
  onName: (s: string) => void;
  onDelete: () => void;
}) {
  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '110px 1fr 110px 36px', gap: 8,
      padding: '2px 4px', alignItems: 'center',
    }}>
      <span style={{ color: 'var(--fg-dim)' }}>{iso}</span>
      <input
        type="text"
        defaultValue={name}
        onBlur={e => { if (e.target.value.trim() !== name) onName(e.target.value); }}
        placeholder="—"
        style={inputStyle}
      />
      <input
        type="number"
        step="0.05"
        min={0}
        max={1}
        defaultValue={weight}
        key={`w-${iso}-${weight}`}
        onBlur={e => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v !== weight) onWeight(v);
        }}
        style={{ ...inputStyle, textAlign: 'right' }}
      />
      <button
        onClick={onDelete}
        title="Remove holiday"
        style={{ ...btnStyle, padding: '2px 6px' }}
      >×</button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Diagnostics — per-expiry dte vs dte_wkg + ratio
// ────────────────────────────────────────────────────────────────────────────

interface DiagRow {
  currency: string;
  expiry: string;
  dte: number;
  dteWkg: number;
  ratio: number;
}

function DiagnosticsSection({ calendar, expiriesByCcy }: {
  calendar: CalendarPayload;
  expiriesByCcy: Record<string, string[]>;
}) {
  // Snap "now" once per render so the dte values don't twitch as the user
  // types — they update every render anyway because the calendar is the
  // controlled input.
  const now = Date.now();

  const rows: DiagRow[] = useMemo(() => {
    const out: DiagRow[] = [];
    for (const ccy of Object.keys(expiriesByCcy).sort()) {
      const list = sortExpiries(expiriesByCcy[ccy] ?? []);
      for (const expiry of list) {
        const exMs = parseExpiryMs(expiry);
        if (exMs == null || exMs <= now) continue;
        const cal = calYte(exMs, now);
        const wkg = volYte(exMs, now, calendar);
        if (cal <= 0) continue;
        out.push({
          currency: ccy,
          expiry,
          dte: cal * 365,
          dteWkg: wkg * 365,
          ratio: wkg / cal,
        });
      }
    }
    return out;
  }, [calendar, expiriesByCcy, now]);

  return (
    <Section title={`diagnostics (${rows.length} expiries)`} subtitle="dte and dte_wkg under the current calendar">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '40px 90px 1fr 1fr 1fr', gap: 8, color: 'var(--fg-mute)', padding: '0 4px' }}>
          <span>ccy</span>
          <span>expiry</span>
          <span style={{ textAlign: 'right' }}>dte</span>
          <span style={{ textAlign: 'right' }}>dte_wkg</span>
          <span style={{ textAlign: 'right' }}>ratio</span>
        </div>
        {rows.length === 0 && (
          <div style={{ color: 'var(--fg-mute)', padding: '6px 4px', fontStyle: 'italic' }}>
            no expiries available — backend may still be polling
          </div>
        )}
        {rows.map(r => (
          <div key={`${r.currency}-${r.expiry}`} style={{
            display: 'grid', gridTemplateColumns: '40px 90px 1fr 1fr 1fr', gap: 8, padding: '1px 4px',
          }}>
            <span style={{ color: 'var(--fg-dim)' }}>{r.currency}</span>
            <span>{r.expiry}</span>
            <span style={{ textAlign: 'right' }}>{r.dte.toFixed(2)}</span>
            <span style={{ textAlign: 'right' }}>{r.dteWkg.toFixed(2)}</span>
            <span style={{ textAlign: 'right', color: r.ratio === 1 ? 'var(--fg-mute)' : 'var(--fg)' }}>
              {r.ratio.toFixed(4)}
            </span>
          </div>
        ))}
      </div>
    </Section>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Reusable bits
// ────────────────────────────────────────────────────────────────────────────

function Section({ title, subtitle, children }: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <header style={{ marginBottom: 6 }}>
        <span style={{ color: 'var(--fg)', fontWeight: 600 }}>{title}</span>
        {subtitle && (
          <span style={{ color: 'var(--fg-mute)', marginLeft: 8 }}>· {subtitle}</span>
        )}
      </header>
      {children}
    </section>
  );
}

function WeightInput({ label, value, onCommit }: {
  label: string;
  value: number;
  onCommit: (v: number) => void;
}) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ color: 'var(--fg-dim)' }}>{label}</span>
      <input
        type="number"
        step="0.05"
        min={0}
        max={1}
        defaultValue={value}
        key={`${label}-${value}`}
        onBlur={e => {
          const v = parseFloat(e.target.value);
          if (Number.isFinite(v) && v !== value) onCommit(v);
        }}
        style={{ ...inputStyle, width: 60, textAlign: 'right' }}
      />
    </label>
  );
}

function clampWeight(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function stripRev(c: CalendarPayload): Omit<CalendarPayload, 'rev'> {
  return {
    holiday_weights: c.holiday_weights,
    holiday_names: c.holiday_names,
    sat_weight: c.sat_weight,
    sun_weight: c.sun_weight,
  };
}

const inputStyle: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 3,
  padding: '2px 6px', fontSize: 11,
  fontFamily: 'var(--font-data)', fontVariantNumeric: 'tabular-nums',
};

const btnStyle: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg-dim)',
  border: '1px solid var(--border)', borderRadius: 3,
  padding: '2px 8px', cursor: 'pointer', fontSize: 11,
  fontFamily: 'var(--font-chrome)',
};

// ────────────────────────────────────────────────────────────────────────────

registerWidget<VolCalendarConfig>({
  id: 'volCalendar',
  title: 'Vol Calendar',
  component: VolCalendar,
  defaultConfig: DEFAULT_CONFIG,
  configVersion: 1,
  accentColor: '#9ca3af',
});
