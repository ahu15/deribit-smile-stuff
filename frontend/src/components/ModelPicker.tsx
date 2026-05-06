// ModelPicker — dropdown that selects a fair-value methodology.
//
// Two flavours:
//  • <DefaultModelPicker /> — wires to the app-wide context. Sits in the
//    shell header next to the theme toggle; every chain / pricer that
//    follows the default reads from this single value.
//  • <OverrideModelPicker value onChange /> — per-widget. `value=null`
//    means "follow the default", and the dropdown shows that as the
//    leading option. When set to a methodology id, the widget pins to it
//    and persists across changes to the default.

import { useEffect, useState } from 'react';
import {
  fetchMethodologies, type MethodologySpec,
} from '../worker/methodologyService';
import { useDefaultModel } from '../hooks/useDefaultModel';

const selectStyle: React.CSSProperties = {
  background: 'var(--bg)',
  color: 'var(--fg-dim)',
  border: '1px solid var(--border)',
  borderRadius: 3,
  padding: '2px 6px',
  fontSize: 11,
  cursor: 'pointer',
  fontFamily: 'var(--font-chrome)',
  maxWidth: 280,
};

function useMethodologyCatalog(): MethodologySpec[] {
  const [catalog, setCatalog] = useState<MethodologySpec[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchMethodologies().then(list => {
      if (!cancelled) setCatalog(list);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);
  return catalog;
}

/** Renders a methodology's catalog `label` if available, else the raw id. */
export function methodologyLabel(catalog: MethodologySpec[], id: string): string {
  return catalog.find(m => m.id === id)?.label ?? id;
}

interface DefaultModelPickerProps {
  /** Optional small label to render before the select. */
  label?: string;
}

export function DefaultModelPicker({ label = 'model' }: DefaultModelPickerProps) {
  const { defaultMethodology, setDefaultMethodology } = useDefaultModel();
  const catalog = useMethodologyCatalog();
  // Heal a stale persisted id once the catalog lands. An older deploy may
  // have left an id in localStorage that no longer exists; without this the
  // <select> emits a "value not in options" warning and the dropdown shows
  // an arbitrary first option while still reporting the dead id as `value`.
  useEffect(() => {
    if (catalog.length === 0) return;
    if (catalog.some(m => m.id === defaultMethodology)) return;
    const fallback = catalog.find(m => m.id === 'sabr_none_uniform_cal') ?? catalog[0];
    setDefaultMethodology(fallback.id);
  }, [catalog, defaultMethodology, setDefaultMethodology]);

  // Catalog-loading or unknown-id keeps the raw id visible in the <select>
  // (tagged "(unknown)") rather than silently snapping to an arbitrary other
  // option, until the heal effect above runs on the next paint.
  const knownInCatalog = catalog.some(m => m.id === defaultMethodology);
  return (
    <span
      title="App-wide default fair-value methodology — drives Chain & Quick Pricer. Smile / Term Structure widgets have their own pickers."
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <span style={{ color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em' }}>
        {label.toUpperCase()}
      </span>
      <select
        value={defaultMethodology}
        onChange={e => setDefaultMethodology(e.target.value)}
        style={selectStyle}
      >
        {!knownInCatalog && (
          <option value={defaultMethodology}>
            {catalog.length === 0 ? defaultMethodology : `${defaultMethodology} (unknown)`}
          </option>
        )}
        {catalog.map(m => (
          <option key={m.id} value={m.id}>{m.label}</option>
        ))}
      </select>
    </span>
  );
}

interface OverrideModelPickerProps {
  /** null = follow the global default; string = pin this widget to that id. */
  value: string | null;
  onChange: (id: string | null) => void;
  /** Title shown on hover (e.g. "Fair-value model for this chain"). */
  title?: string;
}

export function OverrideModelPicker(p: OverrideModelPickerProps) {
  const { defaultMethodology } = useDefaultModel();
  const catalog = useMethodologyCatalog();

  // Sentinel: empty string in the <select> means "follow default". A real id
  // matches a registered methodology. Decoded back to null on change.
  const sentinelDefault = '';
  const sentinelEffective = p.value ?? sentinelDefault;

  // While the catalog is still loading, render a bare "default" — the raw id
  // is noisy and flickers to the human label a tick later. Once loaded, show
  // the resolved label so the user knows what "default" currently means.
  const defaultOptionLabel = catalog.length === 0
    ? 'default'
    : `default (${methodologyLabel(catalog, defaultMethodology)})`;

  // If the pinned id isn't in the catalog (stale saved profile / removed
  // methodology), keep the value selectable so we don't silently morph the
  // widget onto a different fit — render it as "<id> (unknown)" so the
  // mismatch is visible.
  const overridden = p.value != null;
  const overrideKnown = p.value != null && catalog.some(m => m.id === p.value);
  const showStaleOption = overridden && !overrideKnown;

  return (
    <select
      value={sentinelEffective}
      title={p.title ?? 'Fair-value model — overrides the app-wide default for this widget'}
      onChange={e => {
        const v = e.target.value;
        p.onChange(v === sentinelDefault ? null : v);
      }}
      style={{
        ...selectStyle,
        // Visual signal that the widget is pinned away from the default.
        borderColor: overridden ? 'var(--accent)' : 'var(--border)',
        color: overridden ? 'var(--fg)' : 'var(--fg-dim)',
      }}
    >
      <option value={sentinelDefault}>{defaultOptionLabel}</option>
      {showStaleOption && p.value != null && (
        <option value={p.value}>
          {catalog.length === 0 ? p.value : `${p.value} (unknown)`}
        </option>
      )}
      {catalog.map(m => (
        <option key={m.id} value={m.id}>{m.label}</option>
      ))}
    </select>
  );
}
