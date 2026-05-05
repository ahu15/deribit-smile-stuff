// MethodologyMultiSelect — top-level toolbar control. Compact "N selected"
// summary that opens an inline checkbox column with the catalog grouped by
// freeze axis (the most useful primary grouping). All three tabs read from
// `selectedMethodologies` so this is the one surface that narrows everything.

import { useState } from 'react';
import type { MethodologySpec } from '../../../worker/methodologyService';

interface Props {
  catalog: MethodologySpec[];
  selected: string[];
  onChange: (next: string[]) => void;
}

export function MethodologyMultiSelect({ catalog, selected, onChange }: Props) {
  const [open, setOpen] = useState(false);

  const groups = new Map<string, MethodologySpec[]>();
  for (const m of catalog) {
    const key = m.freeze;
    const arr = groups.get(key) ?? [];
    arr.push(m);
    groups.set(key, arr);
  }
  for (const arr of groups.values()) arr.sort((a, b) => a.id.localeCompare(b.id));

  const toggle = (id: string) => {
    const has = selected.includes(id);
    onChange(has ? selected.filter(x => x !== id) : [...selected, id]);
  };
  const selectAll = () => onChange(catalog.map(m => m.id));
  const clear = () => onChange([]);

  const buttonLabel = selected.length === 0
    ? 'methodologies: all'
    : `methodologies: ${selected.length}/${catalog.length}`;

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        onClick={() => setOpen(v => !v)}
        style={{
          background: 'var(--bg-1)', color: 'var(--fg)',
          border: '1px solid var(--border)', borderRadius: 3,
          padding: '2px 8px', fontSize: 11, cursor: 'pointer',
          fontFamily: 'var(--font-chrome)',
        }}
      >
        {buttonLabel} {open ? '▴' : '▾'}
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: '100%', left: 0, marginTop: 2,
          background: 'var(--bg-1)', color: 'var(--fg)',
          border: '1px solid var(--border)', borderRadius: 3,
          padding: 6, zIndex: 10,
          minWidth: 360, maxHeight: 360, overflowY: 'auto',
          fontFamily: 'var(--font-chrome)', fontSize: 11,
          boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
            <button onClick={selectAll} style={chipBtn}>all</button>
            <button onClick={clear} style={chipBtn}>none</button>
            <span style={{ flex: 1 }} />
            <button onClick={() => setOpen(false)} style={chipBtn}>close</button>
          </div>
          {[...groups.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([freeze, list]) => (
            <div key={freeze} style={{ marginBottom: 6 }}>
              <div style={{
                color: 'var(--fg-mute)', fontSize: 10, letterSpacing: '0.10em',
                textTransform: 'uppercase', marginBottom: 2,
              }}>
                freeze: {freeze}
              </div>
              {list.map(m => (
                <label key={m.id} style={rowStyle}>
                  <input
                    type="checkbox"
                    checked={selected.includes(m.id)}
                    onChange={() => toggle(m.id)}
                  />
                  <span style={{ flex: 1, color: selected.includes(m.id) ? 'var(--fg)' : 'var(--fg-mute)' }}>
                    {m.label}
                  </span>
                  <span style={{ color: 'var(--fg-mute)', fontFamily: 'var(--font-data)' }}>
                    {m.time_basis}
                  </span>
                </label>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const chipBtn: React.CSSProperties = {
  background: 'var(--bg-2)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 3,
  padding: '1px 6px', fontSize: 10, cursor: 'pointer',
  fontFamily: 'var(--font-chrome)',
};
const rowStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 6,
  padding: '2px 4px', cursor: 'pointer', userSelect: 'none',
};
