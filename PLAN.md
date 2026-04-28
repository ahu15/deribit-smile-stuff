# Deribit Options Screener — Plan

## Goal

A local web app for screening Deribit options: live chain views, live and stale-fit SABR smiles, click-through historical detail, and a flexible widget-based dashboard. Multi-monitor friendly (Bloomberg-style popouts). Single-user, runs on the local machine.

## Hard constraints

- **Local app**, single user. No deploy, no auth.
- **No disk persistence.** Everything is in-memory, session-scoped. Three layers:
  - On-demand fetches from Deribit for trades / candles / DVOL (~24h lookback).
  - Per-instrument spread ring buffer (Deribit doesn't expose historic L2).
  - Chain-snapshot ring buffer (1-min cadence, rolling 24h) feeding Analysis Mode — see below.
  - On startup: a backfill job reconstructs "today so far" using Deribit trades + candles so the analysis views have history before the app's been running for hours.
- **Currencies**: BTC + ETH at launch, SOL by config flip, room for more.
- **Cross-venue**: Bloomberg via `xbbg` later for IBIT / ETHA arb. Architecture must allow more venues (OKX, Bybit, Paradigm, etc.) without core changes.
- **SABR**: use `sabr_greeks.py` as-is. β = 1 default (matches Deribit lognormal quoting). Per-expiry independent fits.
- **Corp SSL**: backend uses `truststore.inject_into_ssl()` (Deribit calls go through corp proxy).
- **Rate limits**: backend respects Deribit's [rate limits](https://support.deribit.com/hc/en-us/articles/25944617523357-Rate-Limits). Strategy in dedicated section below.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Browser                                                    │
│                                                             │
│   Tab / Popout A ─┐                                         │
│   Tab / Popout B ─┼──MessagePort──►  SharedWorker (Oracle)  │
│   Tab / Popout C ─┘                  • chain snapshot cache │
│                                      • per-instrument ring  │
│                                        buffer (spread hist) │
│                                      • subscription mux     │
│                                      • WS client to backend │
│                                          │                  │
└──────────────────────────────────────────┼──────────────────┘
                                           │ ws://localhost
                  ┌────────────────────────▼──────────────────┐
                  │  FastAPI (single instance)                │
                  │  • VenueAdapter interface                 │
                  │  • Deribit poller (BTC/ETH/SOL)           │
                  │  • SABR fits per expiry                   │
                  │  • on-demand history endpoints            │
                  │  • Bloomberg adapter (later)              │
                  └───────────────────────────────────────────┘
```

### Why this shape

- **FastAPI backend** because (a) `sabr_greeks.py` is Python and we want native scipy speed, (b) Bloomberg/`xbbg` forces a Python process to exist anyway, (c) keeps `truststore` shim in one place.
- **SharedWorker oracle** because opening N tabs / popouts must not multiply Deribit polling. One oracle subscribes to the backend WS; tabs subscribe to the oracle.
- **Dockview** for the widget shell because it supports drag-tile *and* real browser-window popouts. Popped-out windows stay in the same browser context, so they remain subscribers to the same SharedWorker — multi-monitor "for free."

## Rate limits & data strategy

Deribit applies account-scoped credit-bucket rate limits with separate matching-engine vs non-matching pools, sustained refill + burst capacity, and per-endpoint cost variance. Throttling surfaces as HTTP 429 / JSON-RPC error code 10028. Authenticated sessions get more headroom than unauthenticated. **Specific numbers depend on the account tier and should be re-verified against the live rate-limits page; the architecture below is designed to stay well under any reasonable bucket.**

### Architectural rules

1. **Backend is the only process talking to Deribit.** Browser-side code (SharedWorker, tabs, popouts) never connects directly. One backend = one rate-limit footprint regardless of how many tabs/widgets are open.
2. **WebSocket subscriptions over REST polling for live data.** REST is reserved for one-shots: startup backfill, on-demand history, sizes/OI refreshes that aren't in any WS channel.
3. **Authenticated WS session.** Use a read-only API key for the backend's connection — better limits than anonymous, and required for some private channels we won't use but is also generally polite to identify ourselves.
4. **Single shared WS connection per process.** Don't open one WS per widget; multiplex.

### Channel selection

| Use | Channel / endpoint | Cadence | Rationale |
|---|---|---|---|
| Whole-currency option mark + IV | `markprice.options.{ccy}` (WS) | streamed | Replaces 2s `book_summary` poll for the IV column. Single channel covers all options for a currency. |
| Per-instrument best bid/ask + size (visible widgets) | `quote.{instrument}` (WS) | streamed | Only subscribe for instruments currently visible in a `ChainTable` / `InstrumentDetail` / Analysis group. Dynamic sub/unsub. |
| Per-instrument trades (visible widgets) | `trades.{instrument}.100ms` (WS) | streamed | Same dynamic-sub pattern. |
| Forwards (perp + futures) | `ticker.{instrument}.100ms` (WS) | streamed | One sub per perp/future per ccy — small fixed set. |
| OI / daily volume refresh | `get_book_summary_by_currency` (REST) | ~30s | Bulk endpoint; OI/volume not in `markprice.options`. One call per ccy per refresh. |
| Trade-print history (Analysis backfill, `InstrumentDetail`) | `get_last_trades_by_instrument_and_time` (REST) | on-demand | Throttled, prioritized. |
| Forward candle history | `get_tradingview_chart_data` (REST) | on-demand | One call per perp/future at backfill. |
| DVOL series | `get_volatility_index_data` (REST) | on-demand | One call per widget mount, then refresh on a slow timer. |

### Dynamic subscription management

The oracle tracks "what instruments are subscribed to, by whom" as a refcount per (channel, instrument). When the *first* tab subscribes to an instrument, oracle asks the backend to add the WS sub; when the *last* unsubscribes, the backend drops it. Combined with HRT-style conversation cancellation on widget unmount, idle subscriptions don't accumulate.

### Rate-limit-aware REST client

In the backend:

- **Token bucket** with configurable sustained rate and burst size, scoped to non-matching pool.
- **Per-endpoint cost weights** (configurable; bulk endpoints cost more tokens).
- **Priority queue**: live UI fetches (e.g. opening an `InstrumentDetail`) preempt backfill jobs.
- **Exponential backoff with jitter** on 10028 / 429.
- **Status pill in the UI**: shows current bucket fill %, queue depth, last-throttled timestamp. Visible always — surfaces throttling rather than hiding it.

### Analysis Mode backfill plan

M4.5's startup backfill is the biggest rate-limit risk in the app. Mitigations:

- **Stage in priority order**: (1) front-month expiry ATM ±10 strikes, (2) other expiries ATM ±10 strikes, (3) wings. The user sees useful data within seconds; full coverage takes minutes if it has to.
- **Aggregate where possible**: for fit history, prefer `get_last_trades_by_currency` (currency-wide trades) over per-instrument calls — one call returns trades across all instruments, cheaper to bucket.
- **Skip dead instruments**: anything with no trades in the lookback window contributes nothing, don't fetch it.
- **Cooperative**: the backfill scheduler yields to live UI fetches via the priority queue. Backfill can take 5–10 minutes in the background; that's fine.
- **Cache aggressively in-process**: a backfill result isn't refetched until the next session.

### What if we're rate-limited anyway

- **Live data continues** (WS subs are not affected by REST throttling — different pool).
- **Backfill pauses** with a UI toast, resumes when bucket recovers.
- **On-demand fetches** queue up; UI shows "loading" with bucket-fill estimate.

## HRT SharedWorker principles applied

Mapped from [HRTWorker article](https://www.hudsonrivertrading.com/hrtbeat/hrtworker-a-sharedworker-framework/).

1. **One oracle, many clients.** Tabs never hit FastAPI directly — always through the SharedWorker.
2. **Dual-mode service classes.** Each service (`ChainService`, `HistoryService`, `StaleFitService`, ...) has one class with two modes; oracle-mode runs the impl, client-mode is a transparent proxy returning AsyncGenerators. Same import, same call site.
3. **Conversations, not RPC.** Methods are `async function*`; clients consume with `for await...of`. Cancellation propagates back up to oracle.
4. **Structured-clone-safe payloads only.** Plain objects, no class instances or methods crossing the port.
5. **Graceful degradation.** Detect SharedWorker support at boot; fall back to DedicatedWorker (or main thread) with the same class API.
6. **Stable conversation IDs + explicit cleanup.** Tab close / widget unmount cancels the conversation, oracle drops the subscriber. Otherwise ring buffers leak.

## Venue/symbol abstraction

All widget configs reference an instrument as `{venue, symbol}`. Canonical IDs: `deribit:BTC`, `deribit:ETH`, `deribit:SOL`, `bloomberg:IBIT`, etc.

Cross-venue widgets carry multiple instrument refs:

```ts
{ etf: 'bloomberg:IBIT', synthetic: 'deribit:BTC', expiry: '...' }
```

Single widget instance is one currency (mixing happens via tiling, not within one widget — currency-mixed tables make units ambiguous).

## Widget shell

**Library:** dockview.

**Registry:**

```ts
type WidgetSpec<TConfig> = {
  id: string;                         // 'chainTable', 'smileChart', ...
  title: string;
  component: React.FC<{ instanceId: string; config: TConfig }>;
  defaultConfig: TConfig;
  configForm: React.FC<{ value: TConfig; onChange: (c: TConfig) => void }>;
  configVersion: number;              // bump on schema change
};
```

Adding a widget = registering one entry. Each widget instance is an independent SharedWorker subscriber.

**Persistence:**

- Named layout profiles in `localStorage` (`"morning"`, `"etha-arb"`, `"surfaces"`).
- JSON import/export.
- Per-widget config carries `configVersion`; on load, run registered migrators or fall back to `defaultConfig`.

**UX touches:**

- Currency color accent per widget header (BTC orange, ETH purple, SOL cyan, equity ETF white).
- Symbol picker sourced from `/venues/{venue}/symbols` so adding SOL is a config flip.
- Ship default profiles for common workflows.

## Widget catalog

| Widget | Config | Notes |
|---|---|---|
| `ChainTable` | `{venue, symbol, expiry, columns[]}` | Virtualized scroll. Toggleable cols: mid$, mid₿, IV, spread bps, spread $, size bid/ask, OI, Δ, Γ, ν, residual-vs-SABR. |
| `SmileChart` | `{venue, symbol, expiry, mode: 'live' \| 'staleFit', intervalMin?}` | Two modes in one component. |
| `SmileGrid` | `{venue, symbol, mode}` | Small-multiples of all expiries. |
| `SurfaceHeatmap` | `{venue, symbol}` | (T, log-moneyness) heatmap. |
| `Pricer` | `{venue, symbol, expiry, strike, side, qty}` | Live SABR params → `BSMerton`; scenario shifters (Δspot, Δσ, Δt). |
| `ForwardCurve` | `{venue, symbol}` | Futures term structure + basis vs perp. |
| `DvolPanel` | `{venue, symbol}` | DVOL + intraday sparkline. |
| `InstrumentDetail` | `{venue, instrumentName}` | Opened from `ChainTable` row-click as a new dock panel. Trade IV history (24h via `get_last_trades_by_instrument`), DVOL overlay, in-memory spread ring buffer chart, OI/size/greeks. |
| `Notes` | `{}` | Free text. Persists with layout. Doubles as M2 shakedown widget. |
| `IbitArb` / `EthaArb` | `{etf, synthetic, refExpiry}` | Cross-venue (Bloomberg + Deribit). M6+. |
| **Analysis Mode widgets (M4.5)** | | All take `{venue, instrumentName}`. Spawn together as a tab group when an option is clicked. |
| `HistoricalFitsPanel` | `{venue, instrumentName}` | α / ρ / ν time series for the instrument's expiry through the day, plus residuals. |
| `OptionPriceHistory` | `{venue, instrumentName}` | Premium evolution (₿ and $) with trade prints overlaid. |
| `DecayMonitor` | `{venue, instrumentName}` | Theoretical θ-integrated decay vs actual price change; residual attributed to vol/spot moves. |
| `GreeksEvolution` | `{venue, instrumentName}` | Δ / Γ / ν / Θ time series for the option through the day. |
| `ForwardEvolution` | `{venue, symbol}` | Forward term structure at intraday snapshots (spaghetti) + spot path. |
| `SmileDayEvolution` | `{venue, symbol, expiry}` | Overlaid smiles at hourly snapshots through the day for one expiry. |

## Smile views

Two distinct smile widgets — keep both.

**Live-fit (`mode: 'live'`):** SABR fitted on every chain snapshot. Curve and dots move together.

**Stale-fit (`mode: 'staleFit'`):** SABR fitted every N minutes, **wall-clock-aligned** (e.g. fits at :00, :05, :10 for N=5). Curve frozen between fits; live bid/ask/mark dots overlaid. Label: "fit @ HH:MM:SS · Xm Ys ago." The point of this view is the gap — dots drifting off the frozen curve = vol has moved since the last fit.

Implementation: new oracle-mode `StaleFitService` subscribes to the same chain feed `ChainService` produces, ignores all snapshots except every N min, runs `SABR.SABRfit` on those, caches `{expiry, fitTimestamp, alpha, rho, volvol, beta, fittedCurve}`. Tabs subscribe with `staleFitService.subscribe(instrument, intervalMin)` → AsyncGenerator yielding new fits or heartbeats.

Multi-tab payoff: 10 tabs of stale-fit smiles still produce **one** fit per expiry per N min total.

## Analysis Mode

Bloomberg-style deep-dive on a clicked option. Click an option in `ChainTable` (or anywhere it shows up) → a **new dockview tab group** opens, pre-arranged with the analysis widgets, all bound to that instrument. The group is dismissable as a unit, popoutable as a window, and savable as part of a profile. Inside the group, each widget is independently rearrangeable.

### Implementation

- **`AnalysisService` in the oracle.** Holds a chain-snapshot ring buffer (1-min cadence, rolling 24h, ~36MB per currency). Live polling appends; nothing hits disk.
- **Startup backfill.** Before the ring buffer has any depth, fetch:
  - `get_last_trades_by_instrument_and_time` for each expiry's instruments (current trading day).
  - `get_tradingview_chart_data` for the perp and each future (forward path).
  - Bucket trades into time windows (5–15 min), fit SABR per bucket via `sabr_greeks.SABRfit` to seed the historical-fit time series.
- **Service surface (AsyncGenerator-yielding):**
  - `fitHistory(symbol, expiry)` → series of `{ts, alpha, rho, volvol, residualRMS}`.
  - `priceHistory(instrumentName)` → series of `{ts, mid_btc, mid_usd, bid, ask}` + trade prints.
  - `greeksHistory(instrumentName)` → series of `{ts, delta, gamma, vega, theta}` computed from the historical fit at each ts and the spot at that ts.
  - `forwardHistory(symbol)` → series of forward curves through the day.
  - `decayDecomposition(instrumentName)` → series of `{ts, theoreticalTheta, actualPnL, volSpotResidual}`.

### Layout templates with parameter binding

The widget shell gets a small extension: a **layout template** is a JSON layout where some configs reference a placeholder like `$instrument` or `$symbol`. "Open Analysis" instantiates the `analysis-default` template by substituting the clicked instrument into all `$instrument`/`$symbol` slots and creating a new dockview tab group from the result. Same mechanism is reusable for any future "click X → spawn this layout" workflow.

## Repo layout

```
deribit smile stuff/
├── PLAN.md
├── sabr_greeks.py                    # existing, unchanged
├── pyproject.toml
├── backend/
│   ├── main.py                       # FastAPI app, WS endpoint to oracle
│   ├── venues/
│   │   ├── base.py                   # VenueAdapter interface
│   │   ├── deribit/
│   │   │   ├── __init__.py
│   │   │   ├── adapter.py            # impl
│   │   │   ├── ws_client.py          # auth, single shared WS, channel sub/unsub
│   │   │   ├── rest_client.py        # rate-limit-aware (token bucket, priority queue, backoff)
│   │   │   └── auth.py               # read-only API key handling
│   │   ├── bloomberg.py              # later
│   │   └── registry.py
│   ├── chain.py                      # snapshot model, expiry grouping, T calc
│   ├── fit.py                        # uses sabr_greeks.SABRfit
│   ├── history.py                    # on-demand trade/IV/DVOL fetchers (use rest_client)
│   └── ratelimit.py                  # token bucket primitives, status pill feed
└── frontend/                         # Vite + React + TS
    ├── vite.config.ts
    └── src/
        ├── worker/
        │   ├── hrtWorker.ts          # base class, oracle/client modes
        │   ├── remoteExecute.ts      # decorator
        │   ├── transport.ts          # MessagePort framing
        │   ├── chainService.ts       # dual-mode
        │   ├── staleFitService.ts    # dual-mode
        │   ├── historyService.ts     # dual-mode (ring buffer + on-demand)
        │   ├── analysisService.ts    # dual-mode (chain snapshot ring + backfill + fit/greeks history)
        │   └── oracle.ts             # SharedWorker entrypoint
        ├── hooks/
        │   └── useSubscription.ts    # wraps `for await` into React state
        ├── shell/
        │   ├── DockShell.tsx         # dockview integration
        │   ├── widgetRegistry.ts
        │   ├── layoutPersistence.ts
        │   ├── layoutTemplates.ts    # parameter-bound templates (e.g. analysis-default)
        │   └── ProfileSwitcher.tsx
        └── widgets/
            ├── ChainTable.tsx
            ├── SmileChart.tsx
            ├── SmileGrid.tsx
            ├── SurfaceHeatmap.tsx
            ├── Pricer.tsx
            ├── ForwardCurve.tsx
            ├── DvolPanel.tsx
            ├── InstrumentDetail.tsx
            ├── analysis/             # M4.5 — opened as a tab group via layout template
            │   ├── HistoricalFitsPanel.tsx
            │   ├── OptionPriceHistory.tsx
            │   ├── DecayMonitor.tsx
            │   ├── GreeksEvolution.tsx
            │   ├── ForwardEvolution.tsx
            │   └── SmileDayEvolution.tsx
            ├── IbitArb.tsx           # M6+
            ├── EthaArb.tsx           # M6+
            └── Notes.tsx
```

## Milestones

1. **M1 — Backend + worker scaffolding.** FastAPI with `VenueAdapter` interface, Deribit impl with: (a) authenticated WS connection subscribing to `markprice.options.{BTC,ETH}` and ticker channels for perps/futures, (b) ~30s REST `get_book_summary_by_currency` refresh for OI/volume, (c) rate-limit-aware REST client (token bucket, priority queue, 10028 backoff), (d) WS endpoint pushing snapshots to the oracle. SharedWorker oracle scaffolding (HRTWorker base class, conversation protocol, mode detection, graceful fallback, refcounted dynamic subscriptions). End-to-end `pingService` test: a tab consumes a stream that originated from Deribit through the worker through the backend. Status pill in the UI showing rate-limit state.
2. **M2 — Widget shell.** Dockview integration, widget registry, layout persistence (named profiles, JSON import/export), popout support. Ship with `Notes` widget to shake out drag/resize/popout/save.
3. **M3 — Chain + live smile.** `ChainTable` (virtualized, toggleable columns) and `SmileChart` (live mode). Both take `{venue, symbol, expiry}`.
4. **M3.5 — Stale-fit smile.** `SmileChart` stale-fit mode with wall-clock-aligned interval; `SmileGrid` small-multiples. New `StaleFitService` in oracle.
5. **M4 — Click-through.** `InstrumentDetail` widget for quick-look. `ChainTable` row-click opens it as a new dock panel (with "pop out" button). Spread ring buffer wired up.
6. **M4.5 — Analysis Mode.** `AnalysisService` in oracle: chain-snapshot ring buffer, **rate-limit-aware staged backfill** (priority queue, currency-wide trades aggregation, ATM-first ordering, dead-instrument skipping), fit/greeks/forward/decay history streams. Six analysis widgets. Layout-template-with-parameter-binding mechanism in the shell. "Open Analysis" action on `ChainTable` and `InstrumentDetail` spawns a tab group bound to the clicked instrument. Backfill progress + bucket state visible in status pill.
7. **M5 — Surface, forwards, DVOL, pricer.** `SurfaceHeatmap`, `ForwardCurve`, `DvolPanel`, `Pricer`.
8. **M6 — Bloomberg.** Bloomberg `VenueAdapter` via `xbbg`. `IbitArb` and `EthaArb` cross-venue widgets.
9. **M7 — Open-ended.** Additional venues (OKX, Bybit, Paradigm) as adapters; existing widgets pick them up automatically.

## Defaults locked in

- SABR: β = 1, per-expiry independent fits via `sabr_greeks.SABRfit`.
- Live data: WebSocket-first via `markprice.options.{ccy}` + dynamic per-instrument `quote` / `trades` subs.
- REST refresh for OI/volume: ~30s.
- Stale-fit cadence: default 5 min, wall-clock-aligned, configurable 1–30 min per widget instance.
- History lookback: ~24h, fetched on demand from Deribit when `InstrumentDetail` opens.
- Spread history: in-memory ring buffer, session-scoped, no disk.
- Currency color accents: BTC orange, ETH purple, SOL cyan, equity ETF white.
- Profile storage: `localStorage`, with JSON import/export.

## Open items (not blocking)

- Default columns for `ChainTable` first cut.
- Whether `Pricer` should support multi-leg (spreads/flies) at M5 or wait.
- DVOL display: gauge vs sparkline vs both.
- Whether to expose raw fit residuals as a dedicated diagnostic widget.
- **Rate-limit specifics**: confirm exact token-bucket numbers for our account tier from the live Deribit rate-limits page; the strategy is conservative but the configured `sustained_rate` / `burst_size` / per-endpoint cost weights should match real values. The rate-limits page was unreachable through the corp proxy when this plan was written.
- Whether to ever fall back to anonymous mode if the read-only API key is unavailable, or hard-fail at startup.
