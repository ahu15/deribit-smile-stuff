import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { DockviewReact, themeAbyss, themeLight } from 'dockview';
import type {
  DockviewApi, DockviewReadyEvent, IDockviewPanelProps, SerializedDockview,
} from 'dockview';
import 'dockview/dist/styles/dockview.css';

import { StatusPill } from '../components/StatusPill';
import { useTheme } from '../hooks/useTheme';
import { useQuickPricerOpen } from '../hooks/useQuickPricer';
import { getWidget, allWidgets } from './widgetRegistry';
import {
  DEFAULT_PROFILE,
  deleteProfile, exportAllProfiles, getActiveProfile, importProfiles,
  listProfiles, loadLayout, saveLayout, setActiveProfile,
} from './layoutPersistence';

// Trigger all widget registrations before the shell mounts.
import '../widgets/Notes';
import '../widgets/ChainTable';
import '../widgets/SmileChart';
import '../widgets/QuickPricer';
import '../widgets/VolCalendar';
import '../widgets/TermStructureChart';

// ---------- panel params ----------

interface PanelParams {
  widgetId: string;
  config: unknown;
  configVersion: number;
}

function migrate(spec: ReturnType<typeof getWidget>, fromVersion: number, oldConfig: unknown): unknown {
  if (!spec) return oldConfig;
  return spec.migrate ? spec.migrate(fromVersion, oldConfig) : spec.defaultConfig;
}

// ---------- panel wrapper ----------

function WidgetPanel({ api, params }: IDockviewPanelProps<PanelParams>) {
  const spec = getWidget(params.widgetId);
  const stale = !!spec && params.configVersion !== spec.configVersion;

  const onConfigChange = useCallback((newConfig: unknown) => {
    if (!spec) return;
    api.updateParameters({
      widgetId: params.widgetId,
      config: newConfig,
      configVersion: spec.configVersion,
    } satisfies PanelParams);
  }, [api, spec, params.widgetId]);

  // Persist migrated config so a stored layout migrates exactly once.
  useEffect(() => {
    if (!stale || !spec) return;
    api.updateParameters({
      widgetId: params.widgetId,
      config: migrate(spec, params.configVersion, params.config),
      configVersion: spec.configVersion,
    } satisfies PanelParams);
  }, [api, spec, stale, params.widgetId, params.configVersion, params.config]);

  if (!spec) {
    return <div style={{ padding: 12, color: 'var(--fg-mute)', fontSize: 12 }}>Unknown widget: {params.widgetId}</div>;
  }

  // Render with migrated config until the effect persists it — avoids one frame of stale UI.
  const config = stale ? migrate(spec, params.configVersion, params.config) : params.config;
  const Component = spec.component;

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {spec.accentColor && (
        <div style={{ height: 2, background: spec.accentColor, flexShrink: 0 }} />
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Component instanceId={api.id} config={config} onConfigChange={onConfigChange} />
      </div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const COMPONENTS: Record<string, React.FunctionComponent<IDockviewPanelProps<any>>> = {
  widget: WidgetPanel,
};

// ---------- shell context ----------

interface ShellCtx {
  addPanel: (widgetId: string) => void;
  popoutActive: () => void;
  activeProfile: string;
  profiles: string[];
  switchProfile: (name: string) => void;
  saveCurrentAs: (name: string) => void;
  deleteCurrent: () => void;
  exportProfiles: () => void;
  importProfilesFromFile: (file: File) => Promise<void>;
}

const ShellContext = createContext<ShellCtx | null>(null);

export function useDockShell(): ShellCtx {
  const ctx = useContext(ShellContext);
  if (!ctx) throw new Error('useDockShell must be used inside DockShell');
  return ctx;
}

// ---------- DockShell ----------

const SAVE_DEBOUNCE_MS = 500;

function newPanelId(widgetId: string): string {
  return `${widgetId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function tryLoadInto(api: DockviewApi, layout: unknown): boolean {
  if (!layout) return false;
  try { api.fromJSON(layout as SerializedDockview); return true; }
  catch { return false; }
}

function addShakedownPanel(api: DockviewApi) {
  const spec = getWidget('notes');
  if (!spec) return;
  api.addPanel({
    id: newPanelId(spec.id),
    component: 'widget',
    title: spec.title,
    params: { widgetId: spec.id, config: spec.defaultConfig, configVersion: spec.configVersion },
  });
}

export function DockShell() {
  const apiRef = useRef<DockviewApi | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeProfileRef = useRef<string>(getActiveProfile());

  const [activeProfile, setActiveProfileState] = useState<string>(getActiveProfile);
  const [profiles, setProfiles] = useState<string[]>(listProfiles);

  // Single source of truth for "switch the active profile name".
  const setActive = useCallback((name: string) => {
    activeProfileRef.current = name;
    setActiveProfile(name);
    setActiveProfileState(name);
  }, []);

  const scheduleSave = useCallback(() => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const api = apiRef.current;
      if (!api) return;
      saveLayout(activeProfileRef.current, api.toJSON());
      setProfiles(listProfiles());
    }, SAVE_DEBOUNCE_MS);
  }, []);

  // Flush pending save and clear the timer on unmount.
  useEffect(() => () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      const api = apiRef.current;
      if (api) saveLayout(activeProfileRef.current, api.toJSON());
    }
  }, []);

  const addPanel = useCallback((widgetId: string) => {
    const api = apiRef.current;
    if (!api) return;
    const spec = getWidget(widgetId);
    if (!spec) return;
    api.addPanel({
      id: newPanelId(widgetId),
      component: 'widget',
      title: spec.title,
      params: { widgetId, config: spec.defaultConfig, configVersion: spec.configVersion },
    });
  }, []);

  const popoutActive = useCallback(() => {
    const api = apiRef.current;
    const panel = api?.activePanel;
    if (!api || !panel) return;
    api.addPopoutGroup(panel);
  }, []);

  const switchProfile = useCallback((name: string) => {
    const api = apiRef.current;
    if (!api || name === activeProfileRef.current) return;
    tryLoadInto(api, loadLayout(name));
    setActive(name);
  }, [setActive]);

  const saveCurrentAs = useCallback((name: string) => {
    const api = apiRef.current;
    if (!api) return;
    saveLayout(name, api.toJSON());
    setActive(name);
    setProfiles(listProfiles());
  }, [setActive]);

  const deleteCurrent = useCallback(() => {
    const name = activeProfileRef.current;
    if (name === DEFAULT_PROFILE) return;
    if (!confirm(`Delete profile "${name}"?`)) return;
    deleteProfile(name);
    setProfiles(listProfiles());
    setActive(DEFAULT_PROFILE);
    const api = apiRef.current;
    if (api) tryLoadInto(api, loadLayout(DEFAULT_PROFILE));
  }, [setActive]);

  const exportProfilesNow = useCallback(() => {
    const api = apiRef.current;
    if (api) saveLayout(activeProfileRef.current, api.toJSON());
    const bundle = exportAllProfiles();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.download = `deribit-smile-profiles-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, []);

  const importProfilesFromFile = useCallback(async (file: File) => {
    const bundle = JSON.parse(await file.text());
    const { imported, active } = importProfiles(bundle);
    if (imported.length === 0) return;
    setProfiles(listProfiles());
    const target = active ?? imported[0];
    const api = apiRef.current;
    if (api) tryLoadInto(api, loadLayout(target));
    setActive(target);
  }, [setActive]);

  const onReady = useCallback((evt: DockviewReadyEvent) => {
    apiRef.current = evt.api;
    evt.api.onDidLayoutChange(scheduleSave);
    // updateParameters() does NOT fire onDidLayoutChange (Dockview only treats
    // structural moves as layout changes). Without this hook, in-session widget
    // config edits — column toggles, density, expiry rollover fallback —
    // silently fail to persist into the active profile. Wiring per-panel here
    // means the autosave mirrors what api.toJSON() would dump right now.
    evt.api.onDidAddPanel(panel => {
      panel.api.onDidParametersChange(scheduleSave);
    });
    if (!tryLoadInto(evt.api, loadLayout(activeProfileRef.current))) {
      addShakedownPanel(evt.api);
    }
  }, [scheduleSave]);

  const ctx = useMemo<ShellCtx>(() => ({
    addPanel, popoutActive,
    activeProfile, profiles,
    switchProfile, saveCurrentAs, deleteCurrent,
    exportProfiles: exportProfilesNow, importProfilesFromFile,
  }), [
    addPanel, popoutActive, activeProfile, profiles,
    switchProfile, saveCurrentAs, deleteCurrent,
    exportProfilesNow, importProfilesFromFile,
  ]);

  return (
    <ShellContext.Provider value={ctx}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        <ShellHeader />
        <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <DockviewBody onReady={onReady} />
        </div>
      </div>
    </ShellContext.Provider>
  );
}

function DockviewBody({ onReady }: { onReady: (e: DockviewReadyEvent) => void }) {
  const { theme } = useTheme();
  // Use the supported `theme` prop. Dockview defaults to `themeAbyss` if
  // omitted, so passing the matching theme object every render keeps the
  // class swap clean (no accumulation, no flicker).
  return (
    <DockviewReact
      theme={theme === 'light' ? themeLight : themeAbyss}
      components={COMPONENTS}
      onReady={onReady}
    />
  );
}

// ---------- header ----------

function ShellHeader() {
  const {
    addPanel, popoutActive,
    activeProfile, profiles, switchProfile, saveCurrentAs, deleteCurrent,
    exportProfiles, importProfilesFromFile,
  } = useDockShell();
  const { theme, toggleTheme } = useTheme();
  const pricerOpen = useQuickPricerOpen();
  const [savingAs, setSavingAs] = useState('');
  const [showSave, setShowSave] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const widgets = allWidgets();

  const commitSave = () => {
    const name = savingAs.trim();
    if (name) { saveCurrentAs(name); setShowSave(false); setSavingAs(''); }
  };

  const onPickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    importProfilesFromFile(file).catch(err => alert(`Import failed: ${err.message ?? err}`));
  };

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '5px 14px', borderBottom: '1px solid var(--border)',
      background: 'var(--bg-1)', flexShrink: 0,
      fontFamily: 'var(--font-chrome)',
    }}>
      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', letterSpacing: '0.04em' }}>
        deribit smile
      </span>
      <StatusPill />
      <button
        onClick={toggleTheme}
        style={btnStyle}
        title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        {theme === 'dark' ? '☀ light' : '☾ dark'}
      </button>
      <Spacer />
      {widgets.map(w => {
        const isQuickPricer = w.id === 'quickPricer';
        const disabled = isQuickPricer && pricerOpen;
        return (
          <button
            key={w.id}
            onClick={() => addPanel(w.id)}
            disabled={disabled}
            title={disabled ? 'Only one Quick Pricer can be open at a time' : `Add ${w.title}`}
            style={{
              ...btnStyle,
              opacity: disabled ? 0.4 : 1,
              cursor: disabled ? 'not-allowed' : 'pointer',
            }}
          >+ {w.title}</button>
        );
      })}
      <Divider />
      <button onClick={popoutActive} style={btnStyle} title="Pop out active panel">⇱ popout</button>
      <Divider />
      <ProfileSection
        activeProfile={activeProfile}
        profiles={profiles}
        showSave={showSave}
        savingAs={savingAs}
        onSwitch={switchProfile}
        onSavingAsChange={setSavingAs}
        onCommitSave={commitSave}
        onOpenSave={() => setShowSave(true)}
        onCloseSave={() => setShowSave(false)}
        onDelete={deleteCurrent}
      />
      <button onClick={exportProfiles} style={btnStyle} title="Export all profiles to JSON">export</button>
      <button onClick={() => fileInputRef.current?.click()} style={btnStyle} title="Import profiles from JSON">import</button>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        onChange={onPickFile}
        style={{ display: 'none' }}
      />
    </div>
  );
}

function Spacer() { return <div style={{ flex: 1 }} />; }
function Divider() { return <div style={{ width: 1, height: 14, background: 'var(--border)', flexShrink: 0 }} />; }

interface ProfileSectionProps {
  activeProfile: string;
  profiles: string[];
  showSave: boolean;
  savingAs: string;
  onSwitch: (name: string) => void;
  onSavingAsChange: (v: string) => void;
  onCommitSave: () => void;
  onOpenSave: () => void;
  onCloseSave: () => void;
  onDelete: () => void;
}

function ProfileSection(p: ProfileSectionProps) {
  const canDelete = p.activeProfile !== DEFAULT_PROFILE && p.profiles.includes(p.activeProfile);
  return (
    <>
      <select
        value={p.activeProfile}
        onChange={e => p.onSwitch(e.target.value)}
        style={{ background: 'var(--bg)', color: 'var(--fg-dim)', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 6px', fontSize: 11, cursor: 'pointer', fontFamily: 'var(--font-chrome)' }}
      >
        {p.profiles.length === 0 && <option value={p.activeProfile}>{p.activeProfile}</option>}
        {p.profiles.map(name => <option key={name} value={name}>{name}</option>)}
      </select>
      {p.showSave ? (
        <>
          <input
            value={p.savingAs}
            onChange={e => p.onSavingAsChange(e.target.value)}
            placeholder="name…"
            autoFocus
            onKeyDown={e => {
              if (e.key === 'Enter') p.onCommitSave();
              if (e.key === 'Escape') p.onCloseSave();
            }}
            style={{ background: 'var(--bg)', color: 'var(--fg)', border: '1px solid var(--border)', borderRadius: 3, padding: '2px 6px', fontSize: 11, width: 110, fontFamily: 'var(--font-chrome)' }}
          />
          <button
            onClick={p.onCommitSave}
            disabled={!p.savingAs.trim()}
            title="Save (or press Enter)"
            style={{ ...btnStyle, opacity: p.savingAs.trim() ? 1 : 0.4, cursor: p.savingAs.trim() ? 'pointer' : 'not-allowed' }}
          >save</button>
          <button onClick={p.onCloseSave} title="Cancel (Esc)" style={btnStyle}>✕</button>
        </>
      ) : (
        <button onClick={p.onOpenSave} style={btnStyle}>save as…</button>
      )}
      <button
        onClick={p.onDelete}
        disabled={!canDelete}
        title={canDelete ? `Delete profile "${p.activeProfile}"` : 'Cannot delete the default profile'}
        style={{ ...btnStyle, opacity: canDelete ? 1 : 0.35, cursor: canDelete ? 'pointer' : 'not-allowed' }}
      >
        delete
      </button>
    </>
  );
}

const btnStyle: React.CSSProperties = {
  background: 'var(--bg)', color: 'var(--fg-dim)', border: '1px solid var(--border)',
  borderRadius: 3, padding: '2px 8px', cursor: 'pointer', fontSize: 11,
  fontFamily: 'var(--font-chrome)',
};
