// M3.95 — ModelHealth widget config + per-tab state slices.
//
// Persistent per-tab state per spec: the discriminated `tabs` block holds
// each tab's independent slice (filters, sorts, lookback) so switching tabs
// is `setState({activeTab})` only and a profile-restored widget remembers
// its last-viewed sub-state. The top-level `selectedMethodologies` is the
// shared toolbar surface that every tab reads from.

export type Currency = 'BTC' | 'ETH';

export type TabId = 'rmse' | 'paramStability' | 'volTime';
export type LookbackHours = 6 | 12 | 24;

export interface RmseTabState {
  // Subset of expiries shown in the matrix; empty → all current expiries.
  expiryFilter: string[];
  // Row-total weighting rule. `equal` averages per-expiry RMSE; `by_quotes`
  // weights by the number of market_iv samples each fit consumed.
  rowWeighting: 'equal' | 'by_quotes';
  // `absolute` shares the color scale across the whole matrix; `per_row`
  // normalizes each methodology row to its own range so within-row
  // expiry-to-expiry variation is visible even when methodologies have
  // very different absolute residual levels.
  colorScale: 'absolute' | 'per_row';
}

export interface ParamStabilityTabState {
  // Single expiry per spec — small multiples are over (param × methodology),
  // not over expiries.
  expiry: string | null;
  lookbackHours: LookbackHours;
  // SABR parameter names. Open-ended for future families (e.g. SVI) —
  // unknown names just yield empty sparklines.
  selectedParams: string[];
}

export interface VolTimeTabState {
  // Methodology-pair filter, keyed by the basis-stripped id
  // (e.g. `sabr_alpha-from-ts_uniform`). Empty → all auto-paired entries.
  pairFilter: string[];
  // Subset of expiries shown in the pair-residual panel.
  expiryFilter: string[];
  panel: 'pair_residual' | 'holidays_in_life';
}

export interface ModelHealthConfig {
  venue: 'deribit';
  symbol: Currency;
  // Top-level toolbar — every tab reads from this single set so switching
  // narrows all three tabs in lockstep. Empty → "all in catalog".
  selectedMethodologies: string[];
  activeTab: TabId;
  tabs: {
    rmse: RmseTabState;
    paramStability: ParamStabilityTabState;
    volTime: VolTimeTabState;
  };
  configVersion: 2;
}

export const DEFAULT_CONFIG: ModelHealthConfig = {
  venue: 'deribit',
  symbol: 'BTC',
  // Default to a small readable set — both freeze=none uniform variants
  // (cal+wkg, the M3.7 baseline) plus the alpha-from-ts uniform pair so
  // the cal-vs-wkg A/B view in the vol-time tab opens populated.
  selectedMethodologies: [
    'sabr_none_uniform_cal',
    'sabr_none_uniform_wkg',
    'sabr_alpha-from-ts_uniform_cal',
    'sabr_alpha-from-ts_uniform_wkg',
  ],
  activeTab: 'rmse',
  tabs: {
    rmse: {
      expiryFilter: [],
      rowWeighting: 'equal',
      colorScale: 'absolute',
    },
    paramStability: {
      expiry: null,
      lookbackHours: 24,
      selectedParams: ['alpha', 'rho', 'volvol'],
    },
    volTime: {
      pairFilter: [],
      expiryFilter: [],
      panel: 'pair_residual',
    },
  },
  configVersion: 2,
};
