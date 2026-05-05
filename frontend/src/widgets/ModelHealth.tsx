// M3.95 — ModelHealth widget. Single tabbed widget with three internal tabs
// and persistent per-tab state (stored in `config.tabs.*` so switching is
// seamless, no re-mount, and a saved profile remembers the last-viewed
// sub-state of each tab independently).
//
// All three tabs read from the same set of upstream services that other
// widgets already consume — `methodologyService`, `chainService`,
// `smileService`, `bucketsService`, `calendarService`. No new backend
// endpoints; oracle refcount dedups so `ModelHealth` shares streams with
// any open SmileChart/TermStructureChart on the same key (HRT principle 1).

import { useEffect, useState } from 'react';
import { registerWidget, type WidgetProps } from '../shell/widgetRegistry';
import { fetchExpiries } from '../worker/chainService';
import {
  fetchMethodologies, type MethodologySpec,
} from '../worker/methodologyService';
import { MethodologyMultiSelect } from './modelHealth/components/MethodologyMultiSelect';
import { RmseTab } from './modelHealth/RmseTab';
import { ParamStabilityTab } from './modelHealth/ParamStabilityTab';
import { VolTimeTab } from './modelHealth/VolTimeTab';
import {
  DEFAULT_CONFIG, type Currency, type ModelHealthConfig, type TabId,
} from './modelHealth/types';

function ModelHealth({ config, onConfigChange }: WidgetProps<ModelHealthConfig>) {
  const [catalog, setCatalog] = useState<MethodologySpec[]>([]);
  const [expiries, setExpiries] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    fetchMethodologies()
      .then(list => { if (!cancelled) setCatalog(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchExpiries(config.symbol)
      .then(list => { if (!cancelled) setExpiries(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [config.symbol]);

  const setSymbol = (s: Currency) => onConfigChange({ ...config, symbol: s });
  const setActiveTab = (t: TabId) => onConfigChange({ ...config, activeTab: t });
  const setSelectedMethodologies = (ids: string[]) =>
    onConfigChange({ ...config, selectedMethodologies: ids });

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', height: '100%',
      background: 'var(--bg)', color: 'var(--fg)',
      fontSize: 11, fontFamily: 'var(--font-chrome)',
    }}>
      <Toolbar
        config={config}
        setSymbol={setSymbol}
        setActiveTab={setActiveTab}
        setSelectedMethodologies={setSelectedMethodologies}
        catalog={catalog}
      />
      <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
        {/* All three tabs stay mounted so their subscriptions stay alive
         *  across tab switches — toggling visibility instead of conditionally
         *  rendering avoids the full re-fetch + re-poll cycle on every flip
         *  and matches the spec's "seamless, no re-mount" requirement. */}
        <TabPane visible={config.activeTab === 'rmse'}>
          <RmseTab
            config={config}
            onConfigChange={onConfigChange}
            catalog={catalog}
            expiries={expiries}
          />
        </TabPane>
        <TabPane visible={config.activeTab === 'paramStability'}>
          <ParamStabilityTab
            config={config}
            onConfigChange={onConfigChange}
            catalog={catalog}
            expiries={expiries}
          />
        </TabPane>
        <TabPane visible={config.activeTab === 'volTime'}>
          <VolTimeTab
            config={config}
            onConfigChange={onConfigChange}
            catalog={catalog}
            expiries={expiries}
          />
        </TabPane>
      </div>
    </div>
  );
}

function TabPane({ visible, children }: { visible: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: visible ? 'block' : 'none',
    }}>
      {children}
    </div>
  );
}

interface ToolbarProps {
  config: ModelHealthConfig;
  setSymbol: (s: Currency) => void;
  setActiveTab: (t: TabId) => void;
  setSelectedMethodologies: (ids: string[]) => void;
  catalog: MethodologySpec[];
}

function Toolbar({
  config, setSymbol, setActiveTab, setSelectedMethodologies, catalog,
}: ToolbarProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '4px 8px', borderBottom: '1px solid var(--border)',
      flexShrink: 0, background: 'var(--bg-1)',
    }}>
      <select
        value={config.symbol}
        onChange={e => setSymbol(e.target.value as Currency)}
        style={selectStyle}
      >
        <option value="BTC">BTC</option>
        <option value="ETH">ETH</option>
      </select>
      <MethodologyMultiSelect
        catalog={catalog}
        selected={config.selectedMethodologies}
        onChange={setSelectedMethodologies}
      />
      <div style={{ flex: 1 }} />
      <TabSwitch
        activeTab={config.activeTab}
        setActiveTab={setActiveTab}
      />
    </div>
  );
}

function TabSwitch({
  activeTab, setActiveTab,
}: { activeTab: TabId; setActiveTab: (t: TabId) => void }) {
  const tabs: { id: TabId; label: string }[] = [
    { id: 'rmse', label: 'RMSE matrix' },
    { id: 'paramStability', label: 'parameter stability' },
    { id: 'volTime', label: 'vol-time' },
  ];
  return (
    <div style={{ display: 'flex', gap: 0, border: '1px solid var(--border)', borderRadius: 3, overflow: 'hidden' }}>
      {tabs.map(t => (
        <button
          key={t.id}
          onClick={() => setActiveTab(t.id)}
          style={{
            background: activeTab === t.id ? 'var(--bg-2)' : 'var(--bg-1)',
            color: activeTab === t.id ? 'var(--fg)' : 'var(--fg-mute)',
            border: 'none',
            padding: '3px 10px',
            fontFamily: 'var(--font-chrome)',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

const selectStyle: React.CSSProperties = {
  background: 'var(--bg-1)', color: 'var(--fg)',
  border: '1px solid var(--border)', borderRadius: 3,
  padding: '2px 6px', fontSize: 11, fontFamily: 'var(--font-chrome)',
};

registerWidget<ModelHealthConfig>({
  id: 'modelHealth',
  title: 'Model Health',
  component: ModelHealth,
  defaultConfig: DEFAULT_CONFIG,
  configVersion: 2,
  // v1 → v2: strip `volTime.lookbackHours` (control was reserved for the
  // bucketed cache pull that never landed; live snapshots ignore it).
  migrate: (fromVersion, oldConfig) => {
    if (fromVersion === 1 && oldConfig && typeof oldConfig === 'object') {
      const o = oldConfig as Record<string, unknown>;
      const tabs = (o.tabs ?? {}) as Record<string, unknown>;
      const volTime = (tabs.volTime ?? {}) as Record<string, unknown>;
      const { lookbackHours: _drop, ...volTimeKept } = volTime;
      return {
        ...DEFAULT_CONFIG,
        ...o,
        tabs: {
          ...DEFAULT_CONFIG.tabs,
          ...tabs,
          volTime: { ...DEFAULT_CONFIG.tabs.volTime, ...volTimeKept },
        },
        configVersion: 2,
      } as ModelHealthConfig;
    }
    return DEFAULT_CONFIG;
  },
  accentColor: 'oklch(0.78 0.14 200)',
});
