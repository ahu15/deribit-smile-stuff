import {
  createContext, createElement, useCallback, useContext, useEffect, useState,
  type ReactNode,
} from 'react';

// App-wide default fair-value methodology. Per-widget configs may override
// this — when a widget's `fairCurveOverride` is null, it follows whatever
// the user has selected as the global default; when set, the override
// persists across changes to the global default.
//
// Mirrors the ThemeProvider pattern (single source of truth, localStorage
// backed) so every consumer sees one value and re-renders together on change.

const STORAGE_KEY = 'deribit-smile:defaultModel';
const FALLBACK_ID = 'sabr_none_uniform_cal';

function readStored(): string {
  if (typeof localStorage === 'undefined') return FALLBACK_ID;
  return localStorage.getItem(STORAGE_KEY) || FALLBACK_ID;
}

interface DefaultModelCtx {
  defaultMethodology: string;
  setDefaultMethodology: (id: string) => void;
}

const Ctx = createContext<DefaultModelCtx | null>(null);

export function DefaultModelProvider({ children }: { children: ReactNode }) {
  const [defaultMethodology, setState] = useState<string>(readStored);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, defaultMethodology);
  }, [defaultMethodology]);

  const setDefaultMethodology = useCallback((id: string) => setState(id), []);

  return createElement(
    Ctx.Provider,
    { value: { defaultMethodology, setDefaultMethodology } },
    children,
  );
}

export function useDefaultModel(): DefaultModelCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useDefaultModel must be used inside DefaultModelProvider');
  return ctx;
}

/** Resolve a widget's `fairCurveOverride` against the global default. Null
 *  means "follow the default"; a string means "pin to this methodology". */
export function useEffectiveModel(override: string | null): string {
  const { defaultMethodology } = useDefaultModel();
  return override ?? defaultMethodology;
}
