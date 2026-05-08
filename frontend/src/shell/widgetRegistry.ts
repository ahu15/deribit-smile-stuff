import type { ComponentType } from 'react';

export interface WidgetProps<TConfig = unknown> {
  instanceId: string;
  config: TConfig;
  onConfigChange: (c: TConfig) => void;
}

export interface WidgetSpec<TConfig = unknown> {
  id: string;
  title: string;
  component: ComponentType<WidgetProps<TConfig>>;
  defaultConfig: TConfig;
  configVersion: number;
  migrate?: (fromVersion: number, oldConfig: unknown) => TConfig;
  accentColor?: string;
  // Derive the tab title from the live config so a Chain on BTC 25SEP26 reads
  // as "Chain BTC 25sep26" instead of the static "Chain". Called on mount and
  // on every config change. Should tolerate pre-migration shapes (the panel
  // wrapper passes `params.config` directly, even when stale).
  formatTitle?: (config: TConfig) => string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<string, WidgetSpec<any>>();

export function registerWidget<T>(spec: WidgetSpec<T>): void {
  if (registry.has(spec.id) && import.meta.env?.DEV) {
    console.warn(`[widgetRegistry] overwriting widget "${spec.id}"`);
  }
  registry.set(spec.id, spec);
}

export function getWidget(id: string): WidgetSpec | undefined {
  return registry.get(id);
}

export function allWidgets(): WidgetSpec[] {
  return [...registry.values()];
}
