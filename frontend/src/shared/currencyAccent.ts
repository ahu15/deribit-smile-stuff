// Theme-aware per-currency accent colors. The brand identity (BTC orange,
// ETH purple) stays recognizable in both modes, but light mode uses darker
// variants so the strike-spine accent and curve lines pass AA contrast on
// the lighter `--bg-2` / chrome surfaces.
//
// Dark-mode BTC #f7931a on `#161d2c` ≈ 7.8:1 (great).
// Dark-mode BTC #f7931a on light `#d2dae6`  ≈ 2.6:1 (fails AA).
// Light-mode #b35900 on `#d2dae6` ≈ 5.5:1 (passes AA).

import { useTheme, type Theme } from '../hooks/useTheme';

export type Currency = 'BTC' | 'ETH';

const ACCENT_BY_THEME: Record<Theme, Record<Currency, string>> = {
  dark: {
    BTC: '#f7931a',
    ETH: '#8c8cf7',
  },
  light: {
    BTC: '#b35900',
    ETH: '#4747c2',
  },
};

/** Returns the per-currency accent for the active theme. Re-renders the
 *  caller on theme toggle (since `useTheme()` is a context subscription). */
export function useCurrencyAccent(symbol: Currency): string {
  const { theme } = useTheme();
  return ACCENT_BY_THEME[theme][symbol];
}

/** Theme-independent default — used for `accentColor` in widget registration
 *  (the dock-panel header stripe paints once and isn't contrast-critical). */
export const DEFAULT_BTC_ACCENT = ACCENT_BY_THEME.dark.BTC;
