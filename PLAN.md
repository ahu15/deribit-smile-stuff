# Deribit Options Screener — Plan

## Goal

A local web app for screening Deribit options: live chain views, live and stale-fit SABR smiles, click-through historical detail, and a flexible widget-based dashboard. Multi-monitor friendly (Bloomberg-style popouts). Single-user, runs on the local machine.

## Hard constraints

- **Local app**, single user. No deploy, no auth.
- **No disk persistence.** Everything is in-memory, session-scoped. The historical & live data layer (M2.5) holds:
  - Per-instrument time-series of mark / mark_iv / bid / ask / spread, capped at ~24h.
  - Per-currency aggregate series (DVOL, perp price, index, forward curve points).
  - Per-instrument trade-print log, capped at ~24h.
  - On startup: a backfill job reconstructs "today so far" using `get_last_trades_by_currency`, `get_tradingview_chart_data`, and `get_volatility_index_data` so any view that opens has history immediately.
  - The live REST poll loop appends to the same store; readers and writers share one source of truth.
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
2. **REST throughout. No WS.** This screener never asks for sub-1s data fidelity at any level — chain views, per-instrument detail, forwards, trades. `get_book_summary_by_currency` at 2s gives a coherent atomic snapshot of an entire chain in one call, and `public/ticker?instrument_name=X` at 2s gives full per-instrument detail (sizes, greeks, bid/ask IVs) for any one option being inspected. At human-paced render rates the difference vs WS is invisible, the code is simpler, the rate-limit footprint is small, and the corp proxy doesn't block it. WS subscriptions are out of the production path — the codebase ships REST-only.
3. **Token-bucket-paced polling.** All polling loops submit through the rate-limit-aware REST client (`PriorityRestQueue` + `TokenBucket`) so live-UI fetches preempt backfill jobs and 10028 / 429 responses trigger exponential backoff with jitter.

### Channel selection

| Use | Endpoint | Cadence | Rationale |
|---|---|---|---|
| Whole-currency option chain (mark, IV, bid/ask, OI, volume, mid, last, price_change) | `public/get_book_summary_by_currency` (REST) | 2s | One call per currency returns every option with the chain-table fields. Atomic snapshot. ~1 token/call. **Note: this endpoint does *not* return bid/ask sizes** — see ChainTable note below. |
| Per-instrument detail (sizes, bid_iv / ask_iv, greeks, full quote) | `public/ticker?instrument_name=X` (REST) | 2s, only while `InstrumentDetail` is open | One call per visible detail widget. Cheap because only the in-focus option is polled, not the whole chain. |
| Forwards (perp + futures) | `public/ticker?instrument_name=BTC-PERPETUAL` (REST) | 2s | Underlying price for the chain comes free in `get_book_summary_by_currency`; an explicit ticker poll is only needed for perp basis / funding (M5 `ForwardCurve`) and forward-curve term structure. Small fixed set per currency. |
| Trade-print stream (`InstrumentDetail`, Analysis backfill) | `public/get_last_trades_by_instrument_and_time` (REST) | 2s delta-fetch while detail open; one bulk fetch on Analysis open | Each poll asks for trades since the last poll's max timestamp — only new prints come back. Throttled, prioritized via `PriorityRestQueue` (live UI > backfill). |
| Forward candle history | `public/get_tradingview_chart_data` (REST) | on-demand | One call per perp/future at Analysis-mode backfill. |
| DVOL series | `public/get_volatility_index_data` (REST) | on-demand at widget mount, then 60s refresh | DVOL changes slowly; aggressive polling adds nothing. |
| End-to-end heartbeat | `public/get_time` (REST) | on-demand by `pingService` | Cheap roundtrip for the M1 e2e test; surfaces backend-↔-Deribit RTT and clock skew in the UI. |

**ChainTable sizes column.** `get_book_summary_by_currency` deliberately omits `best_bid_amount` / `best_ask_amount`. The chain table therefore won't show sizes by default. If a user toggles a "sizes" column on, the widget would have to per-instrument-poll `public/ticker` for every visible row (~30 rows × 2 ccy / 2s ≈ 30 req/s — at or above bucket). Default for now: omit sizes from `ChainTable`; sizes show up in `InstrumentDetail` (M4) which is single-instrument and cheap. Revisit if a real workflow needs at-a-glance sizes.

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
| `ChainTable` | `{venue, symbol, expiry, columns[]}` | Virtualized scroll. Toggleable cols: mid$, mid₿, IV, spread bps, spread $, OI, Δ, Γ, ν, residual-vs-SABR. **Bid/ask sizes intentionally not in the default set** (book_summary doesn't return them — see data strategy). |
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

- **`AnalysisService` in the oracle.** Reads from the M2.5 data layer — does not own its own buffer or run its own backfill. Computes analysis-specific derivatives on top of the existing time-series store.
- **Bucketing + per-bucket SABR fits.** On first subscription per (symbol, expiry), bucket the layer's trades + chain-history into 5–15 min windows and fit SABR per bucket via `sabr_greeks.SABRfit`. Cache the seeded `fitHistory` so re-opens are cheap.
- **Service surface (AsyncGenerator-yielding):**
  - `fitHistory(symbol, expiry)` → series of `{ts, alpha, rho, volvol, residualRMS}`.
  - `priceHistory(instrumentName)` → series of `{ts, mid_btc, mid_usd, bid, ask}` + trade prints (read from data layer).
  - `greeksHistory(instrumentName)` → series of `{ts, delta, gamma, vega, theta}` computed from the historical fit at each ts and the spot at that ts.
  - `forwardHistory(symbol)` → series of forward curves through the day (read from data layer).
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
│   │   │   ├── adapter.py            # REST polling, ChainSnapshot assembly
│   │   │   ├── rest_client.py        # rate-limit-aware (token bucket, priority queue, backoff)
│   │   │   └── auth.py               # read-only API key handling (optional)
│   │   ├── bloomberg.py              # later
│   │   └── registry.py
│   ├── chain.py                      # snapshot model, expiry grouping, T calc
│   ├── fit.py                        # uses sabr_greeks.SABRfit
│   ├── history.py                    # M2.5 data layer: rolling 24h time-series store + startup backfill
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
        │   ├── historyService.ts     # dual-mode: subscribes to backend M2.5 data layer (series + trades + helpers)
        │   ├── analysisService.ts    # dual-mode: reads historyService, adds bucketed SABR fits + decay decomposition
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

1. **M1 — Backend + worker scaffolding.** ✅ **Complete (2026-04-28).** Delivered:
   - FastAPI app with `VenueAdapter` ABC and a `DeribitAdapter` that polls Deribit REST. The build initially attempted an authenticated WS connection per the original plan, then pivoted to REST-only after (a) the corp proxy blocks WS upgrade and (b) sub-1s data fidelity isn't a goal at any level (see [data strategy](#rate-limits--data-strategy)).
   - Chain-level data: `get_book_summary_by_currency` polled every 2s per currency (BTC + ETH), normalised into `ChainSnapshot { marks, book_summaries }`. IV is normalised from percent → decimal at the adapter boundary.
   - Rate-limit-aware REST client: `TokenBucket` (5 tok/s sustained, 20 burst) + `PriorityRestQueue` (live-UI vs backfill priorities) + 10028 / 429 exponential backoff with jitter. `truststore.SSLContext` wired into `httpx` for corp-proxy SSL.
   - `/ws/oracle` WS endpoint (browser ↔ backend, not Deribit ↔ backend) streams `chain_snapshot` and `rate_limit_status` envelopes; also handles a `ping` round-trip via Deribit `public/get_time`.
   - Frontend SharedWorker oracle (`oracle.ts`) with DedicatedWorker fallback. `HRTWorker` module exposes `isOracleContext` mode detection, `registerService` / `getService`, a refcounted `acquireSharedStream` (per-key dedup across tabs), and `subscribeRemote` returning AsyncGenerators. Conversation-id protocol in `transport.ts`.
   - Three dual-mode services: `pingService` (Deribit→backend→oracle→tab roundtrip, the M1 e2e test), `chainService`, `rateLimitService`.
   - React UI: `StatusPill` (bucket %, queue depth, last-throttled), `ChainView` (currency, instrument count, spot, snapshot timestamp), `PingView` (rtt, clock skew, last roundtrip).
2. **M2 — Widget shell.** ✅ **Complete (2026-04-29).** Delivered:
   - Dockview shell (`DockShell.tsx`) with the abyss theme, embedded `StatusPill`, and a single `widget` panel component that dispatches via the registry.
   - `widgetRegistry` exposes `WidgetSpec<TConfig>` (id, title, component, `defaultConfig`, `configVersion`, optional `migrate`, optional `accentColor`) and `registerWidget` / `getWidget` / `allWidgets`. Dev-mode warning on duplicate registration. Each registered widget gets a "+ Title" button in the header automatically.
   - `WidgetPanel` wrapper handles config-version migration: when a stored panel's `configVersion` differs from the spec, it renders with the migrated config on the same frame and persists the migrated value via `api.updateParameters` in an effect, so a stored layout migrates exactly once. `onConfigChange` always writes back the *current* spec version, fixing a drift bug where edits would otherwise re-stamp the old version.
   - Layout persistence in `localStorage` (`layoutPersistence.ts`): named profiles, debounced auto-save (500 ms) on every dockview layout change, flush-on-unmount, active-profile pointer survives reload. JSON export downloads a versioned `ProfileBundle` (`{version: 1, active, profiles}`); JSON import restores all profiles, switches to the bundle's active profile, and validates the version + name shapes.
   - Profile management UI: dropdown switcher, "save as…" inline input (Enter/Esc), delete (disabled when active = `default`, confirms before deleting, falls back to default on success), and JSON export/import buttons (file input + download anchor).
   - Popout: header "⇱ popout" button calls `api.addPopoutGroup(activePanel)`. Pop-outs reuse the same browser context, so the future SharedWorker oracle remains a single subscriber.
   - Notes shakedown widget: simple textarea with debounced (400 ms) save, flush-pending-edit on unmount, gray accent stripe.
   - Vite hardening: `resolve.dedupe: ['react','react-dom']` to stop dockview's CJS pre-bundle from instantiating a second React copy (which had been firing "Invalid hook call" warnings in dev). `vite-env.d.ts` added.
   - Browser-verified end-to-end: add panel, save-as, switch profile, JSON export round-trip, JSON import (new profile becomes active and renders), delete (falls back to default), Notes config persisted with correct `configVersion`, full state restored on reload.
3. **M2.5 — Historical & live data layer.** ✅ **Complete (2026-04-29).** Delivered:
   - `backend/history.py` — `HistoryStore`: per-(instrument, field) deques (`mark`, `mark_iv`, `bid_price`, `ask_price`, `mid`, `spread`), per-(currency, field) aggregate deques (`dvol`, `perp`, `forward_opt:{expiry}` from option-chain `underlying_price`, `forward_fut:{expiry}` from future chart-data backfill — same expiry key so the two are diffable for basis), per-instrument trade-print logs. All 24h-capped, threadsafe, with subscriber callbacks for live deltas and helper queries (`change`, `session_open`, `range`). Out-of-order / duplicate-timestamp samples are dropped.
   - **Spot index intentionally not stored.** SABR fits, smile views, InstrumentDetail, and Analysis Mode all key off the per-expiry forward (which we now have, both option-implied and future-mark). ForwardCurve plots basis vs perp, not vs spot. Spot becomes load-bearing only at M6 for the ETF↔synthetic arb (IBIT vs BTC, ETHA vs ETH), where it'll be provided by the Bloomberg adapter via `xbbg` subscribing to `XBTUSD Curncy` / `XETUSD Curncy`. Until then, no `spot` / `index` aggregate exists, and downstream code should not assume one.
   - `backend/backfill.py` — `Backfill` orchestrator runs three task families per currency at `PRIORITY_BACKFILL`: ccy-wide trades via `get_last_trades_by_currency_and_time` (with paging) seed per-instrument mark/IV + the trade log, `get_tradingview_chart_data` per future + perpetual seeds the forward-curve aggregates, `get_volatility_index_data` seeds DVOL. Dead instruments (no trades in lookback) never get per-instrument calls — they fall out of the trade-aggregation step. Total/completed counters drive `BackfillProgress` snapshots; total grows once forwards are enumerated so progress is monotonic.
   - `DeribitAdapter` constructs the store + backfill, spawns backfill on `start()`, and live-appends every per-instrument field plus the per-currency `index` from `_merge`. Live polling preempts backfill via the existing `PriorityRestQueue` (live=0, backfill=10).
   - `DeribitRestClient` gained `get_last_trades_by_currency`, `get_tradingview_chart_data`, `get_volatility_index_data`, `get_instruments` — all submitted at `PRIORITY_BACKFILL` with the existing 10028 / 429 backoff path.
   - WS protocol extended with conversation-tagged subscriptions: `subscribe_history` / `subscribe_aggregate` / `subscribe_trades` / `unsubscribe`. The backend pushes one snapshot envelope (`history_snapshot` / `aggregate_snapshot` / `trades_snapshot`) then live append envelopes (`*_append`), all tagged with the client's `conversationId` so the oracle can fan out without cross-talk. Per-subscription async pump task with bounded queue (drops on overflow rather than blocking the writer). Backfill progress is a broadcast (untagged) `backfill_progress` envelope.
   - HTTP helpers: `GET /api/history/change`, `GET /api/history/session-open`, `GET /api/history/range` (validates `t1_ms >= t0_ms`).
   - `oracle.ts` gained `backendConversation(subscribeMsg)` — generates a conversation id, sends the subscribe message, yields every backend envelope tagged with that id, and on cancellation cleanly sends `unsubscribe`.
   - `worker/historyService.ts` (dual-mode) registers `historySeries` / `historyAggregate` / `historyTrades` / `backfillProgress` services; client API exposes `seriesStream(instrument, field)`, `aggregateStream(currency, field)`, `tradesStream(instrument)`, `backfillProgressStream()` plus the HTTP-backed `change`, `sessionOpen`, `range` helpers.
   - `StatusPill` shows `history: NN%` while running and `history ✓` once the backfill completes.
   - Browser-verified: backfill completed in ~5s populating ~10k per-instrument samples, 23 aggregate series (DVOL + index + forwards across BTC/ETH), and 2k trade prints. End-to-end WS round-trip confirmed for all four envelope types with correct conversation-id routing; HTTP helpers returned expected values.
4. **M3 — Chain + live smile.** ✅ **Complete (2026-04-29).** Delivered:
   - `backend/fit.py` — `fit_smile(forward, t_years, strikes, ivs, beta=1.0)` wraps `sabr_greeks.SABRfit`, filters non-finite / zero IVs, samples a smooth `grid_size` curve across the observed strike range, and returns `FitResult { alpha, rho, volvol, beta, forward, t_years, strikes, fitted_iv, market_strikes, market_iv, residual_rms }`. Residual RMS is computed against market quotes at the actual strikes, so the value is comparable across expiries.
   - `backend/chain.py` — `ChainRow` dataclass (flat per-instrument row including `change_1h`/`change_24h` slots) plus instrument-name parsers `parse_strike`, `parse_option_type`, and `expiry_ms` (Deribit options expire 08:00 UTC). `ChainSnapshot.expiries()` now sorts by `expiry_ms` so dropdowns are chronological, not lexicographic.
   - `DeribitAdapter.chain_rows(currency, expiry?)` builds `ChainRow[]` from the latest snapshot. Per-row deltas come from `HistoryStore.change(name, "mark"|"mark_iv", lookback_ms)` — the M2.5 layer is the only data source, no extra Deribit calls. Rows are sorted by (`expiry_ms`, `strike`, `option_type`). `DeribitAdapter.smile_fit(currency, expiry)` averages IVs per strike across calls/puts (parity-quoted on Deribit, so they should agree; averaging just denoises) and runs `fit_smile` against the option-implied forward.
   - WS protocol extended with two new conversation-tagged subscriptions: `subscribe_chain {currency, expiry?}` (full-chain when `expiry` omitted, slice otherwise) and `subscribe_smile {currency, expiry}`. Each pumps on every chain poll and emits `chain_snapshot` / `smile_snapshot` envelopes. The legacy single-currency global broadcast was removed — every chain consumer now goes through a tagged conversation. New helper `GET /api/chain/expiries?currency=X` for dropdown bootstrapping. `subscribe_currency` was retired.
   - `worker/chainService.ts` rewritten to conversation form (`chainStream(currency, expiry?)`), `worker/smileService.ts` added (`smileStream(currency, expiry)`), and `oracle.ts` registers the new `smile` service. Multiple widgets on the same `(currency, expiry)` slice share one upstream backend conversation via the oracle's `acquireSharedStream` refcount, so 5 SmileChart copies of the same expiry produce one SABR fit per snapshot, not five.
   - `ChainTable` widget rebuilt against [Option Chain Visual Spec.md](Option%20Chain%20Visual%20Spec.md): mirrored geometry (`[Calls cols, reversed] [STRIKE] [Puts cols]`), one row per strike; brand-coloured strike spine with hairline borders; spot line drawn between the two strikes flanking F with `F 76382.33` label; ITM cell-side shading (calls below F, puts above F) via background tint, never text dimming. Typography pass: `font-variant-numeric: tabular-nums`, integer at primary fg, decimal point + fractional at fg-dim, trailing zeros + `K`/`M`/`%` suffixes at fg-mute, three font sizes (12 / 11 / 10 px) per metric level, headers UPPERCASE 9 px with 0.10em letter-spacing. Configurable density (compact 18 / default 22 / comfortable 28). Bid renders warm (`oklch(0.72 0.16 50)`), ask cool (`oklch(0.78 0.14 220)`). Tick flashes: each cell holds its previous mounted value in a ref and fires a 700 ms `Element.animate` green/red background fade on change — never on text, never on first mount. The previous-value tracking is intentionally per-cell client-side state, not in the oracle: tick flashing is a presentation concern that different tabs may want to disable per spec, and keeping it client-side preserves the oracle's role as the single canonical-snapshot publisher (HRT principles 1, 4, 6). Auto-scroll to ATM on first paint; the parent remounts `Mirror` on `(currency, expiry)` change so the latch resets cleanly. Config-version migrator preserves v1 saved layouts.
   - `SmileChart` widget: live SABR fit per snapshot, hand-rolled SVG with fitted curve, market-IV dots, dashed forward marker, per-currency accent (BTC orange / ETH purple), live params readout (α / ρ / ν / F / T / RMS) and snapshot timestamp in the toolbar. Insufficient-quote case is flagged in the toolbar instead of crashing the fit.
   - DockShell save-as flow gained an explicit `save` button next to the input (disabled until non-empty). Previously only `Enter` committed and clicking elsewhere silently dropped the typed name — surfaced after user feedback.
   - Browser-verified end-to-end: BTC and ETH expiry dropdowns populate from `/api/chain/expiries`, chain rebuild renders the mirrored grid with ITM shading and tick flashes (502 animations across 56 mark cells over three polls verified in DevTools), SABR fit refreshes every 2 s in lockstep with the chain poll, snapshot timestamp ticks 10:51:29 → 10:51:31 → 10:51:33, and currency / expiry switches reset the chain cleanly without stale state bleeding through.
   - **Theming pass (post-M3 sub-task).** Two palettes specified in [COLOR_PALETTE.md](COLOR_PALETTE.md): dark (deep blue-black ground, near-white fg, blue accent, magenta-red `--neg` so it doesn't compete with `--bid`) and light (cool gray paper, true blue accent, desaturated red bid). Single set of CSS custom properties on `:root[data-theme]`; every component now reads from these tokens — no hex/rgb literals outside the theme file other than per-symbol identity colours (BTC orange, ETH purple, Notes grey). Fonts switched to `Inter` (chrome) + `Commit Mono` (data) with `JetBrains Mono` / `ui-monospace` fallbacks. Toggle button (`☾ dark` / `☀ light`) lives next to the StatusPill in the shell header; persists in `localStorage` under `deribit-smile:theme`. An inline `<script>` in `index.html` reads the stored value before paint to avoid a flash of the wrong palette on reload. Theme state lives in a single `ThemeProvider` context so all components re-render together. Dockview's theme is set via the `theme={themeLight | themeAbyss}` prop — passing a className on `DockviewReact` accumulates classes across renders, but the `theme` prop swaps cleanly. ChainTable's per-cell tick-flash colours read `--flash-up` / `--flash-down` from `getComputedStyle` at the moment of the flash so they adapt to the active theme without a re-render. Browser-verified: body bg switches `rgb(7,10,16)` ↔ `rgb(244,246,250)`, dv-groupview switches `rgb(0,12,24)` ↔ `rgb(255,255,255)`, currency-identity accents persist across modes, no console errors.
5. **M3.5 — Stale-fit smile.** `SmileChart` stale-fit mode with wall-clock-aligned interval; `SmileGrid` small-multiples. New `StaleFitService` in oracle.
6. **M4 — Click-through.** `InstrumentDetail` widget for quick-look. `ChainTable` row-click opens it as a new dock panel (with "pop out" button). Trade-IV history chart and spread ring buffer chart both read from the M2.5 data layer — no extra Deribit calls beyond the one new `public/ticker` poll for the open instrument.
7. **M4.5 — Analysis Mode.** `AnalysisService` in oracle computes analysis-specific derivatives on top of the M2.5 data layer: bucketed SABR fits per time window (`fitHistory`), `greeksHistory` from historical fit + spot, `decayDecomposition` (theoretical θ vs actual P&L). Six analysis widgets. Layout-template-with-parameter-binding mechanism in the shell. "Open Analysis" action on `ChainTable` and `InstrumentDetail` spawns a tab group bound to the clicked instrument.
7. **M5 — Surface, forwards, DVOL, pricer.** `SurfaceHeatmap`, `ForwardCurve`, `DvolPanel`, `Pricer`.
8. **M6 — Bloomberg.** Bloomberg `VenueAdapter` via `xbbg`. `IbitArb` and `EthaArb` cross-venue widgets. Bloomberg also fills the spot-index gap deferred in M2.5: subscribes to `XBTUSD Curncy` / `XETUSD Curncy` and writes per-currency `spot` aggregates into the same `HistoryStore`, unlocking ETF↔synthetic basis math and (optionally) sharper decay decomposition in M4.5.
9. **M7 — Open-ended.** Additional venues (OKX, Bybit, Paradigm) as adapters; existing widgets pick them up automatically.

## Defaults locked in

- SABR: β = 1, per-expiry independent fits via `sabr_greeks.SABRfit`.
- Data transport: **REST throughout, polled at 2s.** No WS in the production path. Sub-1s fidelity is a non-goal for this screener at every level (chain, per-instrument, forwards, trades).
- Chain-level: `get_book_summary_by_currency` per currency every 2s. Sizes are *not* shown in `ChainTable` by default (require per-instrument calls — see [data strategy](#rate-limits--data-strategy)).
- Per-instrument: `public/ticker` per open `InstrumentDetail` every 2s; `get_last_trades_by_instrument_and_time` delta-fetched at 2s for the trade-print panel.
- Stale-fit cadence: default 5 min, wall-clock-aligned, configurable 1–30 min per widget instance.
- History lookback: ~24h, fetched on demand from Deribit when `InstrumentDetail` opens.
- Spread history: in-memory ring buffer, session-scoped, no disk; appended from each `public/ticker` poll while `InstrumentDetail` is open.
- Currency color accents: BTC orange, ETH purple, SOL cyan, equity ETF white.
- Profile storage: `localStorage`, with JSON import/export.

## Open items (not blocking)

- Default columns for `ChainTable` first cut.
- Whether `Pricer` should support multi-leg (spreads/flies) at M5 or wait.
- DVOL display: gauge vs sparkline vs both.
- Whether to expose raw fit residuals as a dedicated diagnostic widget.
- **Rate-limit specifics**: confirm exact token-bucket numbers for our account tier from the live Deribit rate-limits page; the configured `sustained_rate` / `burst_size` / per-endpoint cost weights are conservative defaults pending verification. M1 REST polling at 2s × 2 currencies sits at ~1 req/s sustained — well under any plausible bucket — so this isn't blocking.
- **Sizes in ChainTable**: deliberately omitted because `book_summary` doesn't carry them and per-instrument polling for every visible row hits rate-limit bucket. Revisit if a real screening workflow surfaces a need for at-a-glance sizes (e.g. spread-trader looking for fillable size on the wings).
