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
