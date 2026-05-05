# Deribit Options Screener — Plan

## Goal

A local web app for screening Deribit options: live chain views, live SABR smiles with a frozen historic-fit overlay, click-through historical detail, multi-leg quick pricing, and a flexible widget-based dashboard. Multi-monitor friendly (Bloomberg-style popouts). Single-user, runs on the local machine.

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
2. **Dual-mode service classes.** Each service (`ChainService`, `SmileService`, `HistoryService`, `BusService`, ...) has one class with two modes; oracle-mode runs the impl, client-mode is a transparent proxy returning AsyncGenerators. Same import, same call site.
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
| `SmileChart` | `{venue, symbol, expiry}` | Live-fit SABR curve + market dots, plus optional frozen historic-fit overlay (user-pinned timestamp from the 24h `HistoryStore`). |
| `SmileGrid` | `{venue, symbol}` | Small-multiples of all expiries. M5. |
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

`SmileChart` runs in **live-fit** mode: SABR fitted on every chain snapshot, curve and dots move together. Multiple widgets on the same `(currency, expiry)` share one upstream fit via the oracle's `acquireSharedStream` refcount (HRT principle 1) — 10 tabs still produce one `SABR.SABRfit` per expiry per snapshot.

The "frozen curve, drifting dots" view that an earlier draft of this plan called *stale-fit* is already covered by the M3+ frozen historic-fit overlay: `historic_smile_fit(currency, expiry, as_of_ms)` snaps to the closest sample in the 24h `HistoryStore` and runs one fit; the frontend overlays the frozen curve dashed behind the live one. User-pinned timestamp instead of a wall-clock cadence — captures the same analytical signal (gap between fixed reference and live dots = vol has moved) without a dedicated cadence service. A "snap to most recent N-min boundary" auto-advance toggle on `SmileChart` is a small future enhancement that would re-add the cadence behaviour without standing up a new oracle service; not currently scheduled.

`SmileGrid` (small-multiples of all expiries) lands in M5 — a thin wrapper around `smileService`, no new oracle service needed.

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
   - `backend/fit.py` — `fit_smile(forward, t_years, strikes, ivs, beta=1.0)` wraps `sabr_greeks.SABRfit`, filters non-finite / zero IVs, samples a smooth `grid_size` curve across the observed strike range, and returns `FitResult { alpha, rho, volvol, beta, forward, t_years, strikes, fitted_iv, market_strikes, market_iv, residual_rms }`. Residual RMS is computed against market quotes at the actual strikes, so the value is comparable across expiries. `average_iv_by_strike(pairs)` collapses (strike, iv) pairs into ascending strikes + per-strike means, used by both the live and historic fits so they agree on the call/put combining rule.
   - `backend/chain.py` — `ChainRow` dataclass (flat per-instrument row including `change_1h`/`change_24h` slots) plus instrument-name parsers `parse_strike`, `parse_option_type`, and `expiry_ms` (Deribit options expire 08:00 UTC). `ChainSnapshot.expiries()` now sorts by `expiry_ms` so dropdowns are chronological, not lexicographic. (The previously-stub `ForwardPrice` / `ChainSnapshot.forwards` field was removed: forwards live in `HistoryStore` aggregates, not on the snapshot.)
   - `DeribitAdapter.chain_rows(currency, expiry?)` builds `ChainRow[]` from the latest snapshot. Per-row deltas come from `HistoryStore.change(name, "mark"|"mark_iv", lookback_ms)` — the M2.5 layer is the only data source, no extra Deribit calls. Rows are sorted by (`expiry_ms`, `strike`, `option_type`). `DeribitAdapter.smile_fit(currency, expiry)` runs `fit_smile` against the option-implied forward via `average_iv_by_strike`.
   - **Bid/ask IV inversion (`backend/iv.py`).** `get_book_summary_by_currency` doesn't return `bid_iv`/`ask_iv` for options, so `chain_rows` inverts the coin-denominated bid/ask back to vol via `iv_from_price` (Black-76 wrapper around `BSMerton`, seeded from `mark_iv` so Newton converges in a few iterations). Lives in its own module to honour the PLAN constraint that `sabr_greeks.py` ships unmodified. Sub-intrinsic prints, non-convergence, and pathological vols return `None` so the row falls back to "no IV" rather than emitting junk.
   - WS protocol extended with two new conversation-tagged subscriptions: `subscribe_chain {currency, expiry?}` (full-chain when `expiry` omitted, slice otherwise) and `subscribe_smile {currency, expiry}`. Each pumps on every chain poll and emits `chain_snapshot` / `smile_snapshot` envelopes. The legacy single-currency global broadcast was removed — every chain consumer now goes through a tagged conversation. New helper `GET /api/chain/expiries?currency=X` for dropdown bootstrapping. `subscribe_currency` was retired.
   - `worker/chainService.ts` rewritten to conversation form (`chainStream(currency, expiry?)`), `worker/smileService.ts` added (`smileStream(currency, expiry)`), and `oracle.ts` registers the new `smile` service. Multiple widgets on the same `(currency, expiry)` slice share one upstream backend conversation via the oracle's `acquireSharedStream` refcount, so 5 SmileChart copies of the same expiry produce one SABR fit per snapshot, not five. The expiry-list HTTP fetch (`fetchExpiries`) is also routed through the oracle as a one-shot `chainExpiries` service so duplicate widget mounts share one fetch (HRT principle 1).
   - `ChainTable` widget rebuilt against [Option Chain Visual Spec.md](Option%20Chain%20Visual%20Spec.md): mirrored geometry (`[Calls cols, reversed] [STRIKE] [Puts cols]`), one row per strike; brand-coloured strike spine with hairline borders; spot line drawn between the two strikes flanking F with `F 76382.33` label; ITM cell-side shading (calls below F, puts above F) via background tint, never text dimming. Typography pass: `font-variant-numeric: tabular-nums`, integer at primary fg, decimal point + fractional at fg-dim, trailing zeros + `K`/`M`/`%` suffixes at fg-mute, three font sizes (12 / 11 / 10 px) per metric level, headers UPPERCASE 9 px with 0.10em letter-spacing. Configurable density (compact 18 / default 22 / comfortable 28). Bid renders warm (`oklch(0.72 0.16 50)`), ask cool (`oklch(0.78 0.14 220)`). Tick flashes: each cell holds its previous mounted value in a ref and fires a 700 ms `Element.animate` green/red background fade on change — never on text, never on first mount, and *never on ITM cells* (deep-ITM legs that bounce with the forward aren't where price discovery lives). The previous-value tracking is intentionally per-cell client-side state, not in the oracle: tick flashing is a presentation concern that different tabs may want to disable per spec, and keeping it client-side preserves the oracle's role as the single canonical-snapshot publisher (HRT principles 1, 4, 6). Auto-scroll to ATM on first paint; the parent remounts `Mirror` on `(currency, expiry)` change so the latch resets cleanly.
   - **ChainTable column model.** `MetricDef` carries `flashEpsilon` per column so flashes signal *visible* moves at the displayed precision (1 bp on coin prices, 1¢ on USD, 0.1 vol on IV). Two presets — `dollar` (USD-denominated bid/ask/mark + IV) and `bps` (coin-denominated bid/ask/mark + IV) — apply metrics + density in one update so the picker round-trips cleanly. USD columns multiply each row's coin price by *its own* `underlying_price` so each expiry uses its own forward. Config v3 migrator preserves user-tweaked column lists from v1/v2 and injects the USD pair if absent.
   - `SmileChart` widget: live SABR fit per snapshot, hand-rolled SVG with fitted curve, market-IV dots, dashed forward marker, per-currency accent (BTC orange / ETH purple), live params readout (α / ρ / ν / F / T / RMS) and snapshot timestamp in the toolbar. Insufficient-quote case is flagged in the toolbar instead of crashing the fit. Display-toggle settings panel for curve / mark / bid IV / ask IV (chain subscription is gated on `showBid || showAsk` so the second backend conversation only opens when the user actually asks for it). Bid/ask points render warm/cool to match `ChainTable`'s palette. `FlashCircle` mirrors the chain's flash logic on SVG circles for the live mark/bid/ask dots, reading `--flash-up` / `--flash-down` from the active theme.
   - **Frozen historic-fit overlay.** `DeribitAdapter.historic_smile_fit` walks each instrument's `mark_iv` series, snaps to the closest sample to `as_of_ms` (clamping to the 24h buffer boundary), pairs with the snapped option-implied forward, and runs `fit_smile`. Returns a typed `HistoricSmileFit` dataclass (fit + market points + snapped/earliest/latest timestamps + forward) so `main.py` and the frontend share a contract instead of a stringly-keyed dict. Frontend exposure: `fetchHistoricSmile` is an oracle-routed one-shot service (HRT principle 1) — no direct `fetch` from the React component. The default as-of is "(mount time − 24h)" captured in a ref and intentionally NOT persisted in the saved profile (a stale absolute timestamp would sit outside the 24h buffer on next session); session-local override via the settings panel's `datetime-local` input with a "reset" button. Plot draws the frozen curve dashed in `--fg-dim` behind the live curve so the live one keeps visual priority; toolbar shows `frozen @ HH:MM:SS` from the actually-snapped timestamp. Settings panel also offers an x-range zoom (xMin / xMax) — clipping the curve to a hand-picked window auto-tightens the y-axis to whatever points are visible, so deep-OTM IVs don't squash the ATM region. Config v5 migrator drops `historicAsOfMs` from older saves.
   - **Closest-expiry recovery.** `frontend/src/shared/expiry.ts` exports `parseExpiryMs` / `pickClosestExpiry` / `sortExpiries`, shared by `ChainTable` and `SmileChart`. When a saved profile holds a token that's rolled off, the widget falls back to the chronologically nearest remaining expiry — preserving every other widget setting while still rendering *some* chain.
   - **WS reconnect replay.** `oracle.ts` keeps a `Map<conversationId, subscribeMsg>` of every still-open `backendConversation`. On `WebSocket.onopen` it re-sends each subscribe with the same conversation id — without this, every open chain/smile/history stream silently hangs after a backend restart because the new socket has no record of the old subscription.
   - DockShell save-as flow gained an explicit `save` button next to the input (disabled until non-empty). Previously only `Enter` committed and clicking elsewhere silently dropped the typed name — surfaced after user feedback.
   - Dropped the previously-defined-but-unused `DeribitAdapter.latest_snapshot` and `refresh_book_summaries` (also from `VenueAdapter`). Every chain consumer is now strictly a `chain_stream` subscriber, no out-of-band reads.
   - Browser-verified end-to-end: BTC and ETH expiry dropdowns populate from `/api/chain/expiries`, chain rebuild renders the mirrored grid with ITM shading and tick flashes (502 animations across 56 mark cells over three polls verified in DevTools), SABR fit refreshes every 2 s in lockstep with the chain poll, snapshot timestamp ticks 10:51:29 → 10:51:31 → 10:51:33, and currency / expiry switches reset the chain cleanly without stale state bleeding through. Historic-fit overlay populates within ~200 ms of toggling on, frozen curve persists through subsequent live polls, as-of override + reset round-trips cleanly.
   - **Theming pass (post-M3 sub-task).** Two palettes specified in [COLOR_PALETTE.md](COLOR_PALETTE.md): dark (deep blue-black ground, near-white fg, blue accent, magenta-red `--neg` so it doesn't compete with `--bid`) and light (cool gray paper, true blue accent, desaturated red bid). Single set of CSS custom properties on `:root[data-theme]`; every component now reads from these tokens — no hex/rgb literals outside the theme file other than per-symbol identity colours (BTC orange, ETH purple, Notes grey). Fonts switched to `Inter` (chrome) + `Commit Mono` (data) with `JetBrains Mono` / `ui-monospace` fallbacks. Toggle button (`☾ dark` / `☀ light`) lives next to the StatusPill in the shell header; persists in `localStorage` under `deribit-smile:theme`. An inline `<script>` in `index.html` reads the stored value before paint to avoid a flash of the wrong palette on reload. Theme state lives in a single `ThemeProvider` context so all components re-render together. Dockview's theme is set via the `theme={themeLight | themeAbyss}` prop — passing a className on `DockviewReact` accumulates classes across renders, but the `theme` prop swaps cleanly. ChainTable's per-cell tick-flash colours read `--flash-up` / `--flash-down` from `getComputedStyle` at the moment of the flash so they adapt to the active theme without a re-render. Browser-verified: body bg switches `rgb(7,10,16)` ↔ `rgb(244,246,250)`, dv-groupview switches `rgb(0,12,24)` ↔ `rgb(255,255,255)`, currency-identity accents persist across modes, no console errors.
5. **M3.5 — Quick Pricer + cross-widget bus.** ✅ **Complete (2026-04-30).** Delivered:
   - `worker/busService.ts` — first cross-widget interaction primitive. Generic `busPublish(topic, payload)` / `busSubscribe(topic)` (fire-and-forget, no replay) plus a presence channel for the QuickPricer singleton (`registerQuickPricer(instanceId)` returning a release fn, `quickPricerStatusStream()` for late-mount replay). Topic catalog as a const object so consumers don't drift on strings — currently one topic, `quickPricer.addLeg`, with signed `side: ±1` qty 1; signed-add covers what an explicit `removeLeg` topic would have done. Oracle-side state (subscribers Set per topic, open instance Set, status listener Set) lives entirely in the oracle context per HRT principle 1; tabs are pure clients. **Refcount-vs-replay quirk fixed twice in the design:**
     - `quickPricerRegister`/`Unregister` are split into two one-shot service calls instead of "one suspended-await conversation": `acquireSharedStream`'s abort signal can't break a forever-await inside a factory generator, so closing the QuickPricer panel via the dock tab × leaked the registration forever in the suspended-await design. Each call carries a unique `_tag` to defeat the oracle's refcount dedup so rapid mount/unmount/mount cycles (StrictMode) don't collapse into one.
     - `quickPricerStatusStream()` also tags each call uniquely so a second `useQuickPricerOpen` subscriber (e.g. a second ChainTable that mounts after a pricer is already open) gets its own factory invocation and the "replay current state on subscribe" push fires for it. Without the tag, late subscribers got dedup'd onto the first stream and sat forever on the stale `false` default until the next change — visible bug: only the first chain's +/− buttons were enabled when multiple chains were open.
   - `shared/black76.ts` — frontend Black-76 pricer + greeks (Δ, Γ, ν, Θ in forward-space) using A&S 7.1.26 erf, plus a `sabrLognormalVol` Hagan-2002 lognormal expansion (β-general, defaults to β=1 to match Deribit). Math runs entirely client-side; backend stays the single Deribit subscriber.
   - `widgets/QuickPricer.tsx` — singleton multi-leg package pricer. Receives leg events from `ChainTable`'s +/− buttons via `busSubscribe(Topics.quickPricerAddLeg)`; signed-adds 1 to the matched leg's quantity, drops the leg when it nets to 0. Per-leg row carries: leg label + remove ×, signed qty (− 1 + stepper + direct edit), four override slots (vol, fwd, spot, fwd-rate) each with an active checkbox + value (greys when off, value preserved across toggles), four read-only live cells, `$LIVE` USD premium, `bps` of forward, optional `$OVR` column when any override is active, and a configurable greek panel. Two-of-three coupling on (spot, fwd, fwdRate): activating a third auto-deactivates the least-recently-touched of the others (`F = S · exp(r · T)` solves the third). Live mode sources vol from `mark_iv` per chain row; interpolated mode samples it from the live SABR fit at the leg's strike with mark_iv fallback. Taker mode swaps `$LIVE` from "Black-76 at mark IV" to the screen fill (long crosses ask, short hits bid) so the column reads realised premium; `bps` follows whichever price source is showing. Greeks always live (overrides freeze SOME inputs, others still tick — taker doesn't re-derive greeks because that'd need an implied-vol solve and risk reports off mark IV anyway). Per-unit toggle normalises totals to "1 unit of the package" using `min(|qty_i|)` as denominator. Bps against package notional `Σ|qty_i|·F_i` so delta-neutral packages don't divide by zero.
   - **Greek column picker.** `GREEK_COL_DEFS` is a single source of truth for all eight column variants (base + dollar for each of Δ, Γ, ν, Θ): label + tooltip describing units (`Base delta = ∂P/∂F  (dimensionless ≈ coin-equivalent per 1 contract)`, `Dollar gamma = Γ · F²  ($ change in $Δ per 100% spot move)`, etc.), display decimals, and a `legValue(greeks, fwd)` function that pulls out the right scaling. The toolbar's `greeks…` button toggles a `GreekPicker` row of eight checkboxes in canonical order. Default columns: `Δ` (base, the trader's coin-delta intuition is the quickest read), `Γ$`, `ν$`, `Θ$/d` (dollar versions are the P&L-impact quantities desks risk-manage off). Picker also has a `default` reset button. Order in the table follows `GREEK_COL_ORDER` regardless of click order — keeps Δ/Γ/ν/Θ visually grouped even after odd subsets.
   - `ChainTable` integration: each option row's bid/ask cells render a `+` / `−` chevron pinned to the cell edge that *faces the MARK column* (so every row reads `bid − mark + ask` regardless of side — calls and puts mirror correctly because the rule depends only on action direction, not row side). Cell padding flips on the same edge so the right-aligned price never collides with the chevron. Both coin- and USD-denominated bid/ask carry the buttons so users on either preset see the same controls. Buttons are gated on `useQuickPricerOpen()` — disabled with a tooltip when no pricer is mounted; re-enable on mount via the presence stream.
   - `Num` rendering tweaked for sub-1 magnitudes: trailing zeros after a significant digit render in primary, not mute, so a bps-mode price like `0.0030` reads as "30 bps" rather than visually shrinking to "3 bps". Genuine zeros (`0.0000`) keep all-mute trailing.
   - `widget` widths adjusted so 4-decimal coin prices ("0.xxxx") fit alongside the 18px chevron padding without clipping (bid/ask/mark/mid bumped from 60/62 → 72px).
   - `useQuickPricerOpen()` hook in `hooks/useQuickPricer.ts` exposes the presence flag for any consumer that wants to gate behaviour on the pricer being mounted.
   - Config v3 with migrator that injects safe defaults for missing fields (`taker: false`, `greekColumns: DEFAULT_GREEK_COLS`); legacy v1/v2 configs preserve their saved legs, mode, and per-unit toggle. Override slot values persist across `active: false` so re-enabling restores the typed number without retyping.
   - Browser-verified end-to-end: + on ask of `BTC-30MAY26-90000-C` adds a long leg, repeated clicks stack qty, − on bid lifts qty toward 0 and drops the row; multiple chains all dispatch correctly (regression for the multi-chain bus bug); taker toggle visibly swaps `$LIVE` per-leg and total, accent-tinted; greek picker toggles live, totals re-aggregate per-leg using each leg's own forward; default reset returns to `Δ Γ$ ν$ Θ$/d` exactly. No console errors after the hygiene pass (LegButton `cellSide` prop dropped, `TotalsRow` `perUnit` dropped, `fireOneShot` rejection-safe, dead `quickPricerRemoveLeg` topic removed).
6. **M3.6 — Vol-time / working-day calendar.** ✅ **Complete (2026-05-04).** Delivered:
   - `backend/vol_time.py` — `Calendar` dataclass (`holiday_weights: dict[date, float]` so each holiday carries its own weight rather than a single global sentinel; `holiday_names` for cosmetic UI labels; `sat_weight` / `sun_weight` for weekday defaults). Active default is `(sat=0.4, sun=0.6, no holidays)` — crypto trades 24/7, so the weekday rail dampens weekends rather than zeroing them. `cal_yte(expiry_ms, as_of_ms)` is calendar-independent (`Δms / (365·86400·1000)`). `vol_yte(expiry_ms, as_of_ms, calendar)` integrates day-weight × fraction-of-day for the partial first/last days plus full-weight whole days in between, divided by 365 — so a `(sat=1, sun=1, no holidays)` calendar reduces to `cal_yte` exactly. `calendar_rev(c)` is a 12-char SHA-1 prefix of `(holiday_weights, sat_weight, sun_weight)` — names are deliberately excluded so renaming a holiday while the user is mid-typing doesn't invalidate every cached fit. Module-level `_active_calendar` is the FastAPI singleton's source of truth, accessed via `get_active_calendar` / `set_active_calendar`. Every existing `t_years` site in `backend/venues/deribit/adapter.py` (`smile_fit`, `historic_smile_fit`, the `iv_from_price` invert path) now routes through `vol_yte(..., get_active_calendar())`.
   - HTTP routes on `backend/main.py`: `GET /api/calendar`, `POST /api/calendar`, `POST /api/calendar/recalibrate`. The PUT replaces the active calendar in-place; the recalibrate stub returns `{rev, recalibrated: 0}` since the bucketed wkg-basis fit cache it'll walk lands in M3.7/M3.9.
   - `worker/calendarService.ts` — dual-mode service following the existing `isOracleContext` / `registerService` / `subscribeRemote` pattern (HRT principle 2). Tabs never hit `/api/calendar` directly (HRT principle 1) — every write and recalibrate goes through the SharedWorker oracle. Surface: `putCalendar(c)` POSTs and fans the response out to all `calendarStream()` listeners; `recalibrate()` POSTs and re-emits the cached calendar so consumers can refresh derived views; `calendarStream()` yields the current calendar on subscribe and re-yields on every put/recalibrate. Each one-shot/stream call carries a unique `_tag` to defeat the oracle's refcount-based dedup — rapid edits (debounced typing) and multiple late subscribers each need their own factory invocation so neither collapses into a single shared one-shot generator. Wire format is plain data only — `Record<string, number>` for weights, ISO-date strings for keys; no `Date` objects ever cross the port (HRT principle 4).
   - **Refetch-on-subscribe**, not cached-replay. The oracle's `_cached` survives tab reloads (the SharedWorker outlives the page) and backend restarts, so `calendarStream` does an HTTP GET on every fresh subscribe — coalesced via `_inflight` promise dedup so a burst of subscribers shares one fetch. Without this, a stale oracle cache could trump the server's current view on widget mount.
   - `frontend/src/shared/volTime.ts` — frontend mirror of the backend math (`calYte`, `volYte`, `totalVolDaysPerYear`) so the VolCalendar widget can compute live diagnostics in response to keystrokes without an HTTP round-trip per edit. ISO-date strings throughout (no `Date` objects on hot paths) so timezone semantics match the backend exactly. The two implementations agree by construction — algorithm small enough to mirror, default-calendar `t_years` byte-identical with the pre-M3.6 hard-coded `(ex_ms - now) / (365 · 86400 · 1000)` (verified: BTC-29MAY26 historic fit returns `t_years=0.067647` matching the calendar-independent formula).
   - `frontend/src/shared/calendarPresets.ts` — `[{label: "Full holiday", weight: 0.1}, {label: "Half day", weight: 0.5}, {label: "Custom", weight: null}]`. User picks from the list every time per spec; user-extended presets are a future improvement.
   - `widgets/VolCalendar.tsx` — manual entry surface. Toolbar: rev pill (`rev 748393038c58`) + total vol days/yr (`313.0` for default = `261·1 + 52·0.4 + 52·0.6`) + `recalibrate` button with confirm prompt. Weekday weights section: two numeric inputs (Sat / Sun); Mon–Fri implicit 1.0. Holiday section: date + name + preset-dropdown-or-custom + delete, sorted lexically by ISO date. Diagnostics rail: per-expiry `dte` vs `dte_wkg` + ratio across BTC + ETH (merged so the widget covers both currencies the system polls today; expiries pulled from `chainService.fetchExpiries`). Widget config is intentionally empty — the calendar is global, not per-widget. Calendar mirrored to `localStorage` under `deribit-smile:calendar:v1` (global, NOT inside a Dockview profile per spec — switching profiles must not secretly swap calendars). localStorage is a paint-cache only; the stream's first envelope always overwrites whatever was painted from local, so a stale local copy never trumps the server (an earlier auto-push-to-backend on rev mismatch was deliberately removed — it caused a fresh backend boot's defaults to be silently overwritten by stale browser state).
   - **No `subscribe_smile` re-emit on calendar change yet** — the live SABR fit is recomputed every 2 s chain poll, so the next poll naturally reflects the new calendar's `vol_yte` (≤ 2 s latency). The wkg-basis bucketed-cache invalidation path lands with the M3.7/M3.9 engine. Conversation IDs / dedup keys for live `smile` / `chain` streams are unchanged by recalibrate (HRT principle 6) — the only change is that subsequent envelopes' `t_years` reflect the new weights.
   - Browser-verified end-to-end: fresh boot displays `(sat=0.4, sun=0.6, rev=748393038c58, 313.0 vol days/yr)`; long-dated expiry ratios asymptote to ~0.86 (`313/365`) reflecting weekend dampening, short-dated ratios depend on how many weekend days the period crosses. Stale localStorage seeded to `(sat=1, sun=1)` does NOT override the backend's view on reload — widget adopts backend's actual current weights. Setting Sat back to 1.0 with Sun=1.0 (identity calendar) gives all 24 expiries ratio=1.0000 — confirms `vol_yte` reduces to `cal_yte` exactly. Editing Sat to 0.5 bumps rev to `93ef4463d49d` and ratios shift visibly. Renaming a holiday (without changing weights) does NOT bump the rev (verified via curl). Adding a Christmas 2026 holiday at weight 0.1 bumps the rev again; expiries crossing 25 Dec show `0.9972`–`0.9987` ratios. Recalibrate fires `POST /api/calendar/recalibrate` → 200 OK, returns `recalibrated: 0` (M3.6 stub). Live SmileChart historic fit returns `t_years=0.067647` for BTC-29MAY26 under identity calendar, byte-identical with the pre-M3.6 hard-coded `(ex_ms - now) / (365 · 86400 · 1000)`. No console errors after the cleanup pass.
7. **M3.7 — Methodology engine refactor.** ✅ **Complete (2026-05-04).** Delivered:
   - `backend/calibration/` ships the engine: `types.py` (FitResult tagged-union + FitContext), `calibrator.py` (`Calibrator` Protocol — methodology id, the four registry axes, `fit(ctx) → FitResult | None`), `sabr_naive.py` (the `freeze=none, weights=uniform` calibrator wrapping `backend.fit.fit_smile`), `registry.py` (Cartesian-product builder over `family × freeze × weights × time_basis` — only `(sabr, none, uniform)` is implemented today, so the registry materializes exactly two cells: `sabr_none_uniform_cal` and `sabr_none_uniform_wkg`; the loop structure means M3.8 lands additional cells by registering factories without touching the build code). `backend/curves/` ships the `CurveBuilder` Protocol + `TermStructureSnapshot` shape so `FitContext.ts_snapshot` has a real type to point at; concrete builders land in M3.8.
   - **Methodology id format**: `<family>_<freeze>_<weights>_<time_basis>` (snake-case, basis as suffix — explicit decision). Legacy `sabr-naive` resolves to `sabr_none_uniform_cal` via `resolve_alias`, keeping pre-M3.7 byte-identical behavior for any caller still passing the alias.
   - **`FitResult` is plain-data tagged union** (HRT principle 4): `{kind, methodology, params: dict[str, float], forward, t_years, t_years_cal, t_years_wkg, calendar_rev, strikes, fitted_iv, market_strikes, market_iv, weights_used, residual_rms, weighted_residual_rms, frozen}`. `kind` is the discriminator that defines the `params` schema (SABR ships `{alpha, rho, volvol, beta}`); the methodology's `family` axis is conceptually the same value but lives on the catalog row, not on every fit (deliberately deduplicated during the review pass). Both `t_years_cal` and `t_years_wkg` are stamped on every fit so the frontend axis-toggle is free and M3.99 can pick its basis per-leg without a re-fetch.
   - **Two-layer dedup, both honoring HRT principle 1.** (a) **Backend per-snapshot cache** `{(currency, expiry, methodology, ts_method, snapshot_ts, calendar_rev): FitResult}` lives on the `DeribitAdapter` singleton; pruned on every insert to the latest snapshot's ts so size stays bounded by `expiries × methodologies × subscribers`, not by uptime. Multiple WS subscribers at the same key hit one `fit(ctx)` per chain poll. (b) **Frontend SharedWorker oracle** refcount-dedups WS conversations via `acquireSharedStream` keyed on the `subscribeRemote` params object `{currency, expiry, methodology, termStructure}`; `calendar_rev` is intentionally NOT in the params object so a recalibrate doesn't churn open subscriptions (HRT principle 6) — the new revision rides on every snapshot envelope and the next chain poll naturally reflects it.
   - **WS envelope**: `subscribe_smile {currency, expiry, methodology?, termStructure?}` (methodology defaults to `sabr-naive`, termStructure defaults to null). Validation rejects unknown methodology ids and `requires_ts && !termStructure` pairings up front so typos fail loudly rather than silently emit `null` forever. Smile snapshots ship `calendar_rev` at envelope level too (not just inside the fit) so a recalibrate is legible without opening the fit blob.
   - `GET /api/methodologies` ships the catalog (sorted by id for deterministic dropdown order). Wrapped by `worker/methodologyService.ts` — a one-shot oracle-routed service following the `isOracleContext` / `registerService` / `subscribeRemote` pattern (HRT principles 1, 2). Refcount-shared so all dropdowns across all tabs hit one fetch per session.
   - `worker/smileService.ts` widened: `SmileFit` interface mirrors the FitResult tagged-union; `smileStream(currency, expiry, methodology, termStructure)` and `fetchHistoricSmile(...)` accept the new params. Pre-M3.7 callers reading `fit.alpha` etc. now read `fit.params.alpha`.
   - `frontend/src/calibration/` ships the per-`kind` evaluator table: `index.ts` exposes `evaluate(kind, params, strikes, forward, t)`, `sabr.ts` is a thin wrapper over `shared/black76.ts:sabrLognormalVol` (the existing math kernel) plus an array path with ATM-fallback semantics matching the Python implementation. M3.7 lands the table without consumer; M3.99's fair-curve readout will use it.
   - `SmileChart` toolbar: methodology dropdown enabled with the two registered cells (default `sabr_none_uniform_cal`); TS dropdown disabled with hover hint pointing at M3.8. Config v6 with v5→v6 migration that normalizes the legacy alias to the canonical id so the dropdown doesn't render duplicate entries. Toolbar parameter readout reads from `fit.params.*`.
   - `QuickPricer` migrated to the canonical methodology id so it shares the oracle's WS conversation refcount with any open SmileChart on the same `(currency, expiry)` — both widgets end up on one backend fit. Interpolated-mode SABR vol read narrows on `fit.kind === 'sabr'` first, then reads `params.*` typesafely.
   - Browser-verified end-to-end: dropdown shows exactly two options; switching cal↔wkg on BTC-29MAY26 flips `T=0.068y, α=0.359` ↔ `T=0.059y, α=0.360` (same forward + market quotes, different t basis) — basis change is live, not cosmetic. Front-month expiries give nearly-identical fits because the cal/wkg gap collapses to noise on sub-day periods. Unknown methodology on the historic route returns `fit: None` rather than crashing. `tsc --noEmit` clean, no console errors, no failed network requests, backend imports clean.
   - **No user-visible behavior change from M3.6.** The dropdowns are the only visible delta; live SmileChart readouts on the default methodology are byte-identical to pre-M3.7.
8. **M3.8 — DMR term-structure curves + dependent smile presets.** ✅ **Complete (2026-05-04).** Delivered:
   - **Math kernel.** `backend/curves/dmr.py` — `fit_dmr` ports the original `dmr_util_functions.py` two-stage forward-variance fit: stage 1 SMR on the back end (`yte ≥ back_end_yte`) anchors `(v_final, λ_short)`; stage 2 full DMR uses those as a warm start. Bounds are constructed in vol-space and clipped strictly interior so the trust-region solver doesn't start on a face; SLSQP with `v0 + w0 ≥ 0` falls back when `curve_fit` fails. Negative forward variances are intentionally NOT clamped (would bias the fit) — they surface via logger warnings instead. `_fwd_var.py` factors out the `vols_to_fwd_var` / `fwd_var_to_vols` round-trip (midpoint-rule integrator that's exact at the original grid by construction — verified in tests).
   - **`backend/calibration/_smr.py`** — `fit_smr` is a single SMR kernel parameterized by a `Transform` (IDENTITY / ATANH / LOG); the original three near-duplicate fitters collapse onto one code path that differs only in (a) data → z-space mapping, (b) inverse, (c) z-bounds. `rho_smr.py` is now a thin wrapper around `fit_smr(transform=ATANH)` with rho-domain std-error key remapping. Constants (`TOTAL_WKG_D=252`, `BIDASK_SMA_WINDOW=30`) live in `backend/calibration/constants.py` so neither math module imports from a peer file.
   - **`CurveBuilder` registry.** `backend/curves/registry.py` is a Cartesian product over `(family, time_basis)` — only `dmr × {cal, wkg}` is implemented today, so `ts_atm_dmr_cal` and `ts_atm_dmr_wkg` are the two registered methods. The single `TsAtmDmrBuilder` in `dmr_builders.py` reads ATM IV per expiry via a 3-strike log-moneyness quadratic (`IV(K) = a + b·log(K/F) + c·log(K/F)²` evaluated at K=F), with a 2-strike linear fallback. **The prior path is intentionally model-free** — a previous `ts_alpha_dmr` design fed naive-SABR α(T) into the prior, which let the prior inherit the dependent fit's weight scheme and double-counted the ATM region. Replacing α(T) with a chain-direct quadratic kills that cycle. Old saved profiles' `ts_alpha_dmr_*` and `ts_atm_linear_dmr_*` ids resolve to `ts_atm_dmr_*` via `resolve_curve_alias` (and the frontend's v1→v2 migrator).
   - **Methodology axis widening (`backend/calibration/registry.py`).** Pre-M3.8 had 2 cells (the freeze=none uniform pair); M3.8 ships **16 cells** = `{freeze: none, alpha-from-ts} × {weights: uniform, atm-manual, bidask-spread, bidask-spread-sma} × {basis: cal, wkg}`. The retired `volvol-and-alpha-from-ts` freeze axis (dropped for the same SABR→TS→SABR weight-coupling reason as `ts_alpha_dmr`) collapses every legacy `sabr_volvol-and-alpha-from-ts_<weights>_<basis>` id to the equivalent `alpha-from-ts` cell — both via `resolve_alias` on the backend and the SmileChart v6→v7 migrator on the frontend.
   - **`SabrAlphaFrozenCalibrator`** (`backend/calibration/sabr_alpha_frozen.py`) — pins α from `ctx.ts_snapshot.alpha_grid` interpolated at the leg's t_years (in the **curve's** basis, not the calibrator's; see code comment for why), then runs `fit_smile_frozen` with α fixed and (ρ, ν) free. `fit_smile_frozen` (new in `backend/fit.py`) generalizes the standard fit to allow any subset of (alpha, rho, volvol) pinned externally with optional per-strike weights via `sigma=1/w, absolute_sigma=True`. The unweighted/uniform freeze=none path still routes through `fit_smile` so the M3.5/M3.6 byte-for-byte default is preserved.
   - **Per-strike weights (`backend/calibration/weights.py`)** — uniform (1.0s), `atm-manual` (Gaussian bump centered at K=F, σ = 0.15·F), `bidask-spread` (1/spread from the current snapshot), `bidask-spread-sma` (1/spread averaged over the last `BIDASK_SMA_WINDOW=30` samples from `HistoryStore.series(name, "spread")`). Strikes missing a spread fall back to the median spread rather than dropping (avoids silently shrinking the fit set on the wings); weights are renormalized so the largest = 1.0 for optimizer scaling.
   - **Two-layer dedup extends to TS (HRT principle 1).** Backend: `_ts_cache: dict[(currency, method, snapshot_ts, calendar_rev) → TermStructureSnapshot | None]` lives on `DeribitAdapter` alongside `_fit_cache`; both are pruned by `_prune_caches(currency, latest_ts)` on every insert so size stays bounded by `expiries × methodologies × subscribers`, not by uptime. Multiple SmileCharts on the same `(curve, basis)` and any `alpha-from-ts` calibrator they all consume produce **one** DMR build per chain poll. Frontend: oracle dedup key for the TS stream is `(currency, method)`; `calendar_rev` rides on the envelope (HRT principle 6) so a recalibrate doesn't churn open subscriptions.
   - **WS protocol + HTTP routes.** `subscribe_termstructure {currency, method}` emits `termstructure_snapshot {currency, method, timestamp_ms, calendar_rev, snapshot}` on every chain poll. `GET /api/term-structure/methods` ships the catalog. `GET /api/term-structure/historic?currency&method&as_of_ms` mirrors `historic_smile_fit`'s synthetic-snapshot approach — walks every option's `mark_iv` history, snaps each instrument to the closest sample to `as_of_ms`, builds a `ChainSnapshot` at that moment, and runs the requested builder on it. Returns `{snapped_ms, earliest_ms, latest_ms, calendar_rev, snapshot}`; the frontend uses the timestamps to label the as-of and warn when the buffer doesn't span the request.
   - **`worker/termstructureService.ts`** — dual-mode service following the `isOracleContext` / `registerService` / `subscribeRemote` pattern (HRT principle 2). Surface: `termStructureStream(currency, method)` conversation, `fetchHistoricTermStructure(currency, method, asOfMs)` one-shot, `fetchCurveMethods()` one-shot for the catalog. All flows route through the oracle so tabs never hit FastAPI directly (HRT principle 1). Wire shape mirrors `TermStructureSnapshot`'s plain-data fields exactly — pre-sampled `(t_years_cal_grid, t_years_wkg_grid, atm_vol_grid, alpha_grid, fwd_var_grid)` plus the fitted `params` and the market dots in both bases (so the y-axis-quantity toggle and the x-axis-basis toggle are both pure render-time flips, no re-fetch — HRT principle 4).
   - **`TermStructureChart` widget** — SVG plot with method dropdown (default `ts_atm_dmr_cal`), currency picker (BTC/ETH), x-axis toggle (cal/wkg), y-axis toggle (`σ_atm` / `α` / `fwd_var` / `total_var`), parameter readout (`v_final`, `v0`, `w0`, `lambda_short`, `lambda_long`), RMSE, market dots with hover tooltips showing both bases, click-through frozen overlay (dashed `--fg-dim`), session-local as-of override with a reset-to-mount-time-minus-24h button (matches SmileChart's pattern; not persisted because a stale absolute timestamp would sit outside the 24h buffer). Hover overlay shows nearest-grid-point values in both bases plus the date the cursor's tenor maps to. Config v2 with v1→v2 migrator that renames `ts_alpha_dmr_*`/`ts_atm_linear_dmr_*` → `ts_atm_dmr_*`.
   - **`SmileChart` toolbar redesign — three orthogonal axis pickers.** The single methodology dropdown becomes three (freeze · weights · basis) so the 16-cell catalog is navigable without scrolling a flat list. The methodology id stays the source of truth in the saved config; the toolbar resolves `(freeze, weights, basis)` → id via the catalog. **TS curve auto-link**: when the selected methodology has `requires_ts=true`, `config.termStructure` is auto-set to `ts_atm_dmr_${basis}` (and cleared back to null when freeze flips to `none`). Keeping curve+calibrator on the same basis is the only well-defined pairing — the α prior is sampled in the curve's basis, so a mismatched lookup pairs values with the wrong x-grid. Done as a config sync (one round-trip) rather than a derived value so the rest of the pipeline (smileService, historic) stays untouched. Toolbar also shows a `prior: DMR · ATM · wkg` chip when a TS curve is in the loop. Config v6→v7 migrator drops the retired freeze axis and renames stale TS ids.
   - **Tests.** `tests/test_calibration_math.py` — 14 round-trip tests covering the SMR kernel under all three transforms (IDENTITY / ATANH / LOG), `vols_to_fwd_var ∘ fwd_var_to_vols` exactness at the input grid, DMR known-parameter recovery (recovers v_final within 10%, λ_short within 0.02, reconstructed vol curve within 5e-3), input validation (too few points, non-positive vols, non-strictly-increasing tenors, ρ at the (-1,1) boundary), and `fit_rho_smr`'s atanh-space recovery. All pass under Python 3.14 / pytest 9.
   - **Browser-verified end-to-end.** `GET /api/methodologies` returns 16 ids, `GET /api/term-structure/methods` returns 2. SmileChart on BTC default profile (`alpha-from-ts · uniform · wkg`) reports `α=0.399 ρ=-0.318 ν=2.058 · F=80439.38 · T=0.124y · rms=3.85%` with the auto-linked `prior: DMR · ATM · wkg` chip visible. TermStructureChart spawns from the header, renders 12 market dots + the fitted curve, params readout `v_final=0.221 v0=0.207 w0=-0.077 λ_short=0.079 λ_long=0.198 · rms=0.72%`. Switching y-axis cal→fwd-var and x-axis cal→wkg redraws synchronously (label "fwd variance" appears, max x-tick goes from ~2.0y to ~1.43y reflecting the wkg compression). Frozen-overlay toggle fires `GET /api/term-structure/historic`, returns a synthetic-snapshot fit (`rmse=0.0057` over 12 historic dots), dashed path renders behind the live one with `· frozen @ 5/4/2026, 5:37:05 PM` in the toolbar. No console errors, no failed network requests, `tsc --noEmit` clean, `pytest tests/ → 14/14`.
   - **No M3.6/M3.7 behavior change on the legacy path.** `sabr-naive` alias still resolves to `sabr_none_uniform_cal`; the fast-path freeze=none + uniform-weights branch in `SabrNaiveCalibrator` still routes through `fit_smile` (not the new weighted-fit code), preserving the byte-for-byte default.
9. **M3.9 — History overlays + cross-methodology comparison + bucketed fit cache.** ✅ **Complete (2026-05-05).** Delivered:
   - **Bucketed-fit caches on `DeribitAdapter`** (`backend/calibration/buckets.py` — pure bucket-math + key shapes — and the four caches living on the adapter singleton). `_smile_bucket_cache: dict[(currency, expiry, methodology, ts_method, bucket_ts, calendar_rev), FitResult | None]` and `_ts_bucket_cache: dict[(currency, method, bucket_ts, calendar_rev), TermStructureSnapshot | None]`, seeded on first touch per `(currency, expiry, methodology, ts_method)` via `_replay_chain_at(currency, bucket_ts, expiry_filter)` — a synthetic `ChainSnapshot` whose marks come from each option's nearest `mark_iv` sample to `bucket_ts`. Hourly boundaries via `bucket_floor` (UTC wall-clock); 24h eviction via `evict_old_smile_buckets` / `evict_old_ts_buckets` keyed on `bucket_ts < bucket_floor(now − 24h)` so cache size stays bounded by the 24h `HistoryStore` cap. **`requires_ts` calibrators recursively pull `term_structure_bucket_fit` at the same `bucket_ts`** so the historic α prior comes from the same point in time as the historic smile — no live-vs-historic basis mixing. **The retrofit also patched `historic_smile_fit`'s `requires_ts` path the same way** (was returning `None` early; now reuses `term_structure_bucket_fit` for the snapped TS prior), so the frozen-overlay's α-from-ts methodologies actually fit instead of silently dropping out.
   - **WS envelopes**: `subscribe_smile_buckets {currency, expiry, methodology, termStructure, lookbackMs}` and `subscribe_termstructure_buckets {currency, method, lookbackMs}`. Each emits a `*_buckets_snapshot` on open, then a `*_bucket_append {bucket_ts, fit|snapshot, is_new_bucket, calendar_rev}` on every chain poll — the head-bucket re-fit covers in-progress hour updates, and `is_new_bucket=true` fires on the first poll past an hour boundary. **Calendar-rev invalidation rides the existing conversation, not a separate `buckets_invalidated` envelope**: wkg-basis subscriptions detect `current_rev != last_rev` on the next chain poll and re-emit a fresh `*_buckets_snapshot` under the new rev (cal-basis subscriptions skip — their cache key doesn't depend on rev). Functionally equivalent to PLAN's original "buckets_invalidated" wording but simpler — one envelope shape instead of two, and the consumer's snapshot-handling code path was already there.
   - **Frontend dual-mode service** (`frontend/src/worker/bucketsService.ts`) — registers `smileBuckets` and `termStructureBuckets` factories, exposes `smileBucketsStream(currency, expiry, methodology, termStructure, lookbackMs)` and `termStructureBucketsStream(currency, method, lookbackMs)`. Refcount-shared via the oracle's `acquireSharedStream` (HRT principle 1) — params object is plain data with stable key order so the JSON-stringify dedup key collides cleanly across widgets. `calendar_rev` rides the envelope (HRT principle 6) — recalibrate doesn't churn open subscriptions.
   - **`SmileChart` overlays** (`frontend/src/widgets/SmileChart.tsx`): config v8→v9 adds `historyOverlayHours: 0|3|6|12|24` (HISTORY select) and `compareMethodologies: string[]` (capped at 4, COMPARE multi-select). The bucket effect clears state synchronously on every methodology/termStructure/expiry switch so previous-selection curves don't bleed through until the next chain poll. Hourly overlay paths drawn dotted in `var(--fg)` with age-based opacity (oldest 0.15 → newest 0.65 linear) — head bucket is dropped because the live curve already covers it. Cross-methodology overlays draw solid 1px lines in a 4-color palette; auto-link of `ts_atm_dmr_${basis}` for `requires_ts` methodologies happens inside the effect, not as config sync, so the comparison TS is purely derived. SVG legend pinned top-right when comparisons are active. Bounds computation walks both overlay layers + market dots so the y-range tightens to whatever's visible.
   - **`TermStructureChart` overlays** (`frontend/src/widgets/TermStructureChart.tsx`): config v2→v3 adds the same two fields (`historyOverlayHours`, `compareMethods`). Same bucket-replace-or-push logic, same age-fade rule, same legend. Uses the existing `pickGrid(snapshot, xAxis)` / `pickYGrid(snapshot, yAxis)` helpers so the overlay axis-toggle (cal/wkg, σ/α/fwd-var/total-var) stays free.
   - **Recalibrate cleanup endpoint** (`POST /api/calendar/recalibrate`). The M3.6 stub returning `recalibrated: 0` is replaced by `DeribitAdapter.recalibrate_wkg_caches(current_rev)` which walks all four caches (per-snapshot fit + per-snapshot TS + bucket fit + bucket TS), drops every wkg-basis entry whose `calendar_rev` is stale, returns the count. Cal-basis entries don't depend on rev so they're skipped. Lazy recompute: live bucket pumps detect the rev change on their next chain poll and re-emit fresh snapshots, so subscribers don't lose state.
   - **Boot-order fix** (`DeribitAdapter.start`). Live polls used to spawn alongside backfill; the `HistoryStore`'s out-of-order rejection meant a stale-mid-backfill live poll would seed the head, then 24h-old backfill samples (correctly stamped at past timestamps) would all be silently rejected. Fixed by running backfill first, then spawning live loops — costs ~5s of empty chain at startup (StatusPill's `history NN%` already covers this window) but means the frozen-overlay actually has historic data to snap to.
   - **REST paging direction fix** (`DeribitRestClient.get_last_trades_by_currency`). Original implementation walked `cursor_end` backwards from `end_timestamp`. With Deribit returning oldest-first under `include_old=true`, every page chased its own tail and the loop broke after one page — silently capping backfill at ~1k trades, plus per-instrument `append_series` rejected the 999 oldest as out-of-order against the newest one already in the buffer. Now pages forward via `cursor_start = max(page_ts) + 1`, so per-instrument samples land in chronological order. Verified: `BTC trades: 14014 prints across 542 instruments` (was ~1k newest); `ETH trades: 3922 prints across 311 instruments`.
   - **Hygiene pass.** `frontend/src/shared/overlayUi.ts` extracts the duplicated `formatRelativeTime` / `CLAMP_WARN_MS` / `COMPARE_PALETTE` / `COMPARE_CAP` from both widgets — single source of truth for the cross-widget overlay UI tokens. The frozen-overlay timestamp now reads `· @ 2h 30m ago` (relative) instead of an absolute clock, with a hover tooltip showing both the snapped and requested absolute times. A `(clamped)` annotation in `var(--neg)` appears when the snap is more than 5 minutes off the request — covers the cold-buffer case where a request hits before the 24h window has filled.
   - **Browser-verified end-to-end.** Backfill completes in 7.2s with 14014 BTC + 3922 ETH prints across 542+311 instruments. SmileChart with `historyOverlayHours=6` renders 6 dotted hourly overlays (head dropped), age-faded; cross-methodology toggle (`sabr_alpha-from-ts_uniform_cal` against the default primary) draws a `#5fb8ff` palette line + legend `[SABR · cal, SABR · alpha-from-ts · cal]`. TermStructureChart at `last 6h` renders 6 overlays + the live curve; cross-method toggle (`ts_atm_dmr_wkg` against `ts_atm_dmr_cal`) draws palette line + legend `[DMR · ATM · cal, DMR · ATM · wkg]`. Recalibrate flow: `sat_weight 0.4 → 0.5` POST, wait one chain poll for bucket pumps to detect rev change, recalibrate POST returns `{rev: "da37659904a0", recalibrated: 7}` — 7 stale wkg-basis entries dropped across the four caches. `tsc --noEmit` clean, `pytest tests/ → 14/14`, no console errors.
10. **M3.95 — `ModelHealth` widget.** ✅ **Complete (2026-05-05).** Delivered:
    - **Widget shell** (`frontend/src/widgets/ModelHealth.tsx`): tabbed container with three internal tabs and persistent per-tab state nested under `config.tabs.{rmse,paramStability,volTime}` — switching tabs is `setState({activeTab})` only; a profile-restored widget remembers each tab's last-viewed sub-state independently. Tab panes use `display:none` rather than conditional render so each tab's WS subscriptions stay alive across switches and don't re-poll when the user flips back. Top-level toolbar (currency picker, `MethodologyMultiSelect` grouped by `freeze` axis) feeds all three tabs in lockstep.
    - **Tab 1 — RMSE matrix** (`modelHealth/RmseTab.tsx`): heatmap of `(methodology × expiry)` live residuals via `smileStream`; corner surface-summary cell + right-hand row-total column (weighting `equal | by_quotes`); diverging OKLCH ramp (cool=low, warm=high). `WEIGHTING` and `SCALE` (`absolute | per_row`) are persisted per-tab. Methodologies whose cells haven't landed yet (heavier weighted calibrators can lag a 2s chain poll on first subscribe) are hidden with a footer "N methodologies not shown — fits still computing" so the catalog isn't silently filtered.
    - **Tab 2 — Parameter stability** (`modelHealth/ParamStabilityTab.tsx`): small-multiples grid `(methodology × param)` of sparklines over the trailing 6/12/24h, sourced from M3.9's bucketed fit cache via `smileBucketsStream`. Each cell shows the path + mean dashed line + ±σ shaded band, with `n / μ / σ` readouts. Single expiry per spec (selectable in this tab's settings row); per-column shared y-domain so methodologies in the same param column align.
    - **Tab 3 — Vol-time diagnostics** (`modelHealth/VolTimeTab.tsx`): two views switchable in the tab toolbar.
      - `pair_residual` — auto-pairs methodologies by their non-`time_basis` axes (`autoPairMethodologies` in `aggregations.ts`). For each `(freeze × weights × family)` pair where both `_cal` and `_wkg` variants exist, renders ΔRMSE = wkg − cal per expiry with a diverging color (cool = wkg better, warm = cal better) plus the per-pair mean Δ readout.
      - `holidays_in_life` — bucket each expiry by the holiday count inside `(now → expiry)` from the active calendar; mean wkg-basis RMSE per `(methodology × bucket)` cell. Bucket columns with zero expiries are auto-dropped (the default calendar with no holidays naturally collapses to a single column with a friendly "add holidays in VolCalendar to populate" hint).
    - **Pure aggregation module** (`modelHealth/aggregations.ts`): `basisStrip` / `autoPairMethodologies` / `rowSummary` / `surfaceSummary` / `extractParamSeries` / `pairResiduals` / `holidaysInLife` / `bucketHolidays` / `holidaysHeatmap`. Plain-data in/out — no React, no network — so the tabs are pure renderers of derived state.
    - **No new backend compute** — every panel reads existing oracle services (`methodologyService`, `chainService`, `smileService`, `bucketsService`, `calendarService`). Cross-widget oracle dedup means a SmileChart open on the same `(currency, expiry, methodology, ts_method)` shares its upstream conversation with the matching ModelHealth cell (HRT principle 1).
    - **Backend parallelism floor** (`backend/venues/deribit/adapter.py`). Selecting all 16 methodologies fans out ~200 concurrent `smile_fit` calls per chain poll; on the original synchronous path, a single 200ms SLSQP fit blocked the event loop and stalled every other WS conversation (chain, history, ping). Fix: `calibrator.fit(ctx)` and `builder.build(ctx)` now dispatch via `asyncio.to_thread` so CPU-bound math runs on the default thread pool. Per-key `asyncio.Future` dedup maps (`_fit_inflight`, `_ts_inflight`, `_smile_bucket_inflight`, `_ts_bucket_inflight`) preserve the M3.7 "compute at most once per `(key, snapshot)`" guarantee under cooperative interleaving — without them, the new `await` between cache miss and cache write would let two concurrent callers on the same key both miss, both compute. Throughput ceiling is the GIL — option 2 (process pool) and option 3 (snapshot driver) are deferred and documented in `BUGS_AND_IMPROVEMENTS.md §6`.
    - **Backend cancellation hygiene fix** (post-review). Original implementation set `future.set_exception(CancelledError)` on the in-flight `Future` when the awaiting pump task was cancelled (e.g. on widget unmount or page reload). With no consumer awaiting the orphan future, asyncio fired `Future exception was never retrieved` warnings — log spam scaled with the number of subscriptions × cancellation events. Patched all four sites to special-case `CancelledError`: `future.cancel()` cleanly (no traceback) instead of polluting it with an exception that nobody will ever consume. Verified zero warnings across multiple page reloads under load.
    - **In-flight `Future` race fix** (post-review). In `smile_fit` and `smile_bucket_fit` the future was registered AFTER the inner `await self.term_structure_fit(...)`, opening a window where two concurrent callers could both pass the in-flight check, both await the TS fit, and both compute the smile. Moved the `_inflight[key] = future` registration to immediately after the cache-miss check, so concurrent callers see the dedup slot during *every* await on the path.
    - **Frontend subscription hygiene fix** (post-review). Original `RmseTab` / `VolTimeTab` / `ParamStabilityTab` used `useEffect` over a `cellKeys` array dep, aborting *all* AbortControllers on every config edit and re-subscribing the whole cross-product — toggling one expiry filter flashed every cell back to "·" until the next chain poll, and `ParamStabilityTab` discarded its already-streamed bucket history on every methodology toggle. Replaced with a stable `useRef<Map<string, AbortController>>` and a diff loop that only spawns/tears down the *delta* (HRT principle 6: stable conversation IDs across config edits). `symbol` is part of every dedup key so a BTC↔ETH switch tears down cleanly through the same diff.
    - **Methodology catalog fetch dedup** (`frontend/src/worker/methodologyService.ts`, post-review). `subscribeRemote('methodologyCatalog', {})` only refcount-shares while the generator is open, and one-shot generators close immediately after yielding — so concurrent widget mounts each spun up a fresh `/api/methodologies` request (3× per page load with three open Model Health / SmileChart / TermStructureChart panels). Wrapped the registered factory in a session-long `Promise<MethodologySpec[]>` cache: first caller starts the fetch, subsequent callers await the cached promise. Failed fetches clear the cache so retries work. Verified 1 fetch per session regardless of widget count (HRT principle 1).
    - **Persistent state migration** (config v1 → v2). The original `VolTimeTabState` carried a `lookbackHours` field with a UI selector that read "Reserved for the M3.95 vol-time bucketed cache pull. Live snapshots ignore this." — i.e. user-facing dead control. Removed both the field and the selector; `ModelHealth.tsx` ships a v1→v2 migrator that strips the field from saved profiles. ParamStability's lookback selector remains (it does drive the bucketed subscription).
    - **`Heatmap.colorFor` accepts `rowIndex`**, so per-row scales work without tunneling state. RmseTab's `colorScale === 'per_row'` now actually computes per-row `[min, max]` mappers and dispatches by row at render time (the previous implementation's comment promised this but fell through to the global `[0, max]` mapper, making the option indistinguishable from `absolute`).
    - **Browser-verified end-to-end.** RMSE matrix populates 4 default methodologies × 12 expiries (48 cells), updates at chain-poll cadence (~2 s, verified 5/6 sampled cells moved bps over 51 s); ParamStability seeds 12 sparklines (4 methodologies × 3 default params) within ~10 s with `n=26 / μ / σ` readouts; vol-time pair view shows two `_cal/_wkg` pair cards with mean Δ ≈ 0 (calendar has no holidays so cal == wkg by construction); holidays-in-life view collapses to the single "0 holidays" column with the populate hint. Dark/light theme round-trip clean. Profile chrome (save-as → switch → delete → export → import) all functional. Status pill shows live `bucket 100% · history ✓` with the right dot color for fill threshold. Backend logs clean — zero `Future exception was never retrieved` warnings across multiple page reloads under load. `tsc --noEmit` clean, `pytest tests/ → 14/14`.
11. **M3.99 — Pricer fair-curve interface.** Per-leg "fair curve" dropdown in `QuickPricer` enumerating registered methodology presets that have produced a fit for the leg's `(currency, expiry)` on the current snapshot (default `screen`). Live cross-curve readout next to the leg's vol cell when a fair curve is selected, showing each available methodology's vol at the leg's strike (`screen 76.2% / sabr-naive 75.8% / sabr-α-frozen 75.3% / dmr-atm 75.5%`); hover tooltip surfaces each methodology's local residual at that strike. Package-level "use fair curve: …" toggle in the QuickPricer header switches every leg in one click. Per-leg overrides remain available afterward. Each preset's `time_basis` is honored end-to-end — wkg-time presets use wkg `t` for both Black-76 price and greek computation. Theta is computed in whichever basis the chosen methodology declares; toolbar surfaces the basis so the user knows what `Θ$/d` means per leg.
12. **M4 — Click-through.** `InstrumentDetail` widget for quick-look. `ChainTable` row-click opens it as a new dock panel (with "pop out" button). Trade-IV history chart and spread ring buffer chart both read from the M2.5 data layer — no extra Deribit calls beyond the one new `public/ticker` poll for the open instrument.
13. **M4.5 — Analysis Mode.** `AnalysisService` in oracle computes analysis-specific derivatives on top of the M2.5 data layer: `fitHistory` reads from M3.9's bucketed fit cache (no separate bucketing pass), `greeksHistory` from historical fit + spot, `decayDecomposition` (theoretical θ vs actual P&L). Six analysis widgets. Layout-template-with-parameter-binding mechanism in the shell. "Open Analysis" action on `ChainTable` and `InstrumentDetail` spawns a tab group bound to the clicked instrument.
14. **M5 — Surface, forwards, DVOL, pricer, smile grid.** `SurfaceHeatmap`, `ForwardCurve`, `DvolPanel`, `SmileGrid` (small-multiples of all expiries; thin wrapper around `smileService`, no new oracle service needed), `Pricer` (the "full" pricer — multi-leg with strategy templates, scenario sliders, P&L diagrams; inherits the M3.99 fair-curve plumbing; the M3.5 Quick Pricer is the input-shaping precursor).
15. **M6 — Bloomberg.** Bloomberg `VenueAdapter` via `xbbg`. `IbitArb` and `EthaArb` cross-venue widgets. Bloomberg also fills the spot-index gap deferred in M2.5: subscribes to `XBTUSD Curncy` / `XETUSD Curncy` and writes per-currency `spot` aggregates into the same `HistoryStore`, unlocking ETF↔synthetic basis math and (optionally) sharper decay decomposition in M4.5. If TradFi instruments need a different vol-time calendar, the M3.6 `Calendar` is keyed by venue at this point (default shared calendar remains for crypto).
16. **M7 — Open-ended.** Additional venues (OKX, Bybit, Paradigm) as adapters; existing widgets pick them up automatically.

## M3.5 — Quick Pricer

A single-instance, multi-leg package pricer that takes its leg list from `ChainTable` (and any future widget that wants to publish trades). Designed as a focused input-shaping tool, not the full M5 pricer — fewer modes, no P&L diagrams, no strategy templates. The M5 `Pricer` will be the larger, persistent, multi-instance follow-up.

### Cross-widget primitive: `busService`

First widget-to-widget interaction in the app, so the primitive is general — not Quick-Pricer-specific.

- New dual-mode service `busService` in the oracle (HRT principles 1, 4, 6 apply: structured-clone-safe payloads, conversation-id'd subscriptions, drop on widget unmount).
- Surface:
  - `publish(topic, payload)` — fire-and-forget event.
  - `subscribe(topic) → AsyncGenerator<event>` — events from the moment subscription opens (no replay).
- Topic naming convention: `<consumer>.<verb>.<scope>`. M4.75 uses exactly two topics:
  - `quickPricer.addLeg` — payload `{ venue, instrumentName, side: 1 | -1, qty: 1 }` (qty is always 1 per click; the pricer stacks repeated clicks into the leg's quantity, see §4 below).
  - `quickPricer.removeLeg` — payload `{ venue, instrumentName, side: 1 | -1, qty: 1 }`. Mirror of `addLeg` — decrements; if the resulting quantity is zero the leg is dropped.
- Singleton enforcement: oracle tracks open Quick Pricer instances by a registration message on the bus; the widget shell's "+ Quick Pricer" registry entry is gated so only one can be open at a time. Header button greys out when one exists; closing the panel re-enables it. (Multi-instance pricing is the M5 `Pricer`'s job.)
- Bus events go nowhere if no Quick Pricer is open — clicking a chain button with no pricer mounted is a silent no-op (consider a one-shot toast "Open Quick Pricer to receive legs" later if it's confusing in practice).

### `ChainTable` integration

- Two new per-row controls in `ChainTable`: small `+` (buy / +1) and `−` (sell / −1) buttons, one each on the bid and ask side of every option row. Clicking publishes `quickPricer.addLeg` for that instrument.
- `+` on the ask = buy 1, `−` on the bid = sell 1. Matches the visual convention where the user is "lifting offers" or "hitting bids."
- Repeated clicks stack into the leg's quantity (handled by the pricer; see §4). `+` then `−` on the same leg cancels out via `removeLeg`.
- Buttons are visually subtle (small chevrons in `--fg-mute`, hover-only background) so they don't fight the existing tick-flash and ITM-shading layers.
- Buttons are gated on `is a Quick Pricer open?` — when none is open, they render disabled with a tooltip pointing to the header button.

### `QuickPricer` widget

Layout: a compact table — one row per leg, plus a totals row. Header carries the global controls. Singleton (only one instance at a time, per §busService).

#### Header controls (apply to all legs)

- **Mode toggle** — single checkbox `interpolated`:
  - **off (default)**: each leg's vol is the chain's quoted `mark_iv` for that exact strike (the "screen" / non-interpolated mode).
  - **on**: each leg's vol is sampled from the live SABR curve at the leg's strike (interpolated). Sourced from `smileService.smileStream(currency, expiry)` — already a shared computation per HRT principle, so multiple legs on the same expiry hit one fit.
- **Per-unit / per-package toggle** — checkbox `perUnit`:
  - **off**: P&L columns (premium, $-greeks) show the *package* value, summed across legs with sign and quantity.
  - **on**: columns are normalised to "1 unit of the package" using the **smallest-leg quantity as the denominator**. E.g. a `100×200` call spread (long 100, short 200) shows as `1×2` (long 1, short 2 per unit). Implementation: `unitDenominator = min(|qty_i|)` across legs; per-unit values = package values / `unitDenominator`. Single-leg packages: per-unit and per-package are identical, but the toggle is still respected for display consistency.
- **Clear all** button (drops all legs).

#### Per-leg row

Columns left-to-right:

1. **Leg label** — `BTC-30MAY25-90000-C` style. Trailing `×` removes the leg.
2. **Side / qty** — signed integer entry. `+` button increments, `−` button decrements (so an external chain click and a manual click are the same op). Direct numeric edit allowed; sign denotes side. Reaching 0 drops the leg.
3. **Vol override** — numeric input + adjacent `useOverride` checkbox. Disabling the checkbox **greys** the input but **preserves the value** (re-enabling restores it without retyping). When the checkbox is unchecked, the leg uses the live vol from the active mode (screen vs SABR).
4. **Spot override** / **Forward override** / **Forward-rate override** — three inputs, each with a `useOverride` checkbox identical to vol's. **At most two of these three can be active at once**; the third auto-disables (and greys) because spot, forward, and forward-rate are linked via `F = S · exp(r · T)`. The widget computes the third from the other two — when the user toggles a third on, the *least recently changed* of the others auto-toggles off (last-touched stays).
5. **Live vol / live spot / live fwd / live fwd rate** — four read-only display columns, one per overridable input, showing the *live* value sourced from the chain / smile / forward services regardless of override state. This makes "the price moved because vol moved" vs "because spot moved" legible at a glance — important per §requirement 4 (overrides freeze one input but the others still tick).
6. **Live price (coin / $)** — what the leg costs *right now* using all live inputs (no overrides applied). Always shown.
7. **Override price (coin / $)** — what the leg costs using the leg's overrides applied on top of remaining live inputs. Hidden if no overrides are active on this leg; visually distinguished (e.g. boxed) when shown.
8. **Greeks (live)** — Δ, $Δ, Γ, $Γ, $ν, $Θ. Always live, recomputed every tick from current inputs (overrides + live). Per §requirement 4: greeks must keep ticking even on legs with overrides, because a vol override doesn't freeze spot and vice versa.

`$` columns multiply by the leg's underlying spot in USD (matches `ChainTable`'s USD preset convention — each leg uses *its own* expiry's underlying so multi-expiry packages are correct).

#### Totals row

- Sum across legs of: live price ($, bps), override price ($, bps if applicable), Δ, $Δ, Γ, $Γ, $ν, $Θ.
- Respects the `perUnit` toggle: when on, totals divide by `unitDenominator` per the rule above.
- Bps is computed against the **package notional** = Σ |qty_i| · F_i (sum of absolute leg notionals at each leg's forward); avoids the degenerate `0` denominator that plain net-notional gives on a delta-neutral package.

#### Math sourcing

- All pricing/greeks via `BSMerton` from `sabr_greeks.py` (per the existing `Pricer` plan in M5 — same library, same conventions). Black-76 wrapper in `backend/iv.py` is already there from M3 if needed.
- Live inputs (per leg per tick):
  - **Spot / forward** — from `historyService` aggregates (`forward_opt:{expiry}` for option-implied F, `index` for spot), live-streamed.
  - **Forward rate** — derived as `r = ln(F/S) / T`. Not a separate feed.
  - **Vol** — screen mode: `mark_iv` from the active `chainStream`. SABR mode: evaluated from the active `smileStream`'s `{alpha, rho, volvol, beta}` at the leg's strike.
- All four feeds are pre-existing oracle services; the pricer is purely a consumer + calculator. No new backend endpoints.

### Config (persisted with layout)

```ts
type QuickPricerConfig = {
  legs: Array<{
    venue: string;            // 'deribit'
    instrumentName: string;   // 'BTC-30MAY25-90000-C'
    qty: number;              // signed; sign = side
    overrides: {
      vol?:     { value: number; active: boolean };
      spot?:    { value: number; active: boolean };
      fwd?:     { value: number; active: boolean };
      fwdRate?: { value: number; active: boolean };
    };
  }>;
  mode: 'screen' | 'interpolated';
  perUnit: boolean;
  configVersion: number;
};
```

Override values persist in the saved profile even when `active: false` — re-enabling the checkbox restores the old number (per §requirement 2).

### Open items (M4.75-specific)

- Whether `removeLeg` from the chain (the `−` button on a row that already has a position in the pricer) should decrement, drop, or always net (e.g., does `−` on a leg I'm already long sell against the long, or just go shorter?). Default: signed-add — a `−` always adds `−1` to that leg's qty, so it nets. Multi-click on the bid side of an already-long leg gets you flat then short.
- Whether the `+`/`−` buttons should be on every row regardless of pricer state (greyed) or only appear when a pricer is open. Lean: always-rendered + greyed, so layout doesn't shift on widget mount.
- Bps denominator alternatives if `Σ|qty_i|·F_i` proves confusing (e.g., for vertical spreads where the sum over-counts). Could specialise per-strategy later.

## M3.6–M3.99 — Methodology engine, term-structure curves, model health, fair-curve pricer

These six milestones land the multi-methodology calibration stack: a vol-time calendar foundation, a registry-driven smile/term-structure engine, two display widgets (term structure + model health), a bucketed historic-fit cache (also feeding M4.5), and the pricer hook that lets the user select which fair curve to mark a leg against.

### Architecture summary

- **Methodologies factor along four axes**, not as N hand-rolled subclasses. Smile presets are `(family, freeze, weights, time_basis)` quadruples; term-structure builders are `(method, dependencies, time_basis)` triples. The methodology registry enumerates the full Cartesian product (or the curated subset that's analytically meaningful) so each `(family, freeze, weights)` combination automatically ships in *both* a `_cal` and a `_wkg` variant — no per-preset boilerplate, and cal-vs-wkg A/B comparisons fall out of the existing multi-methodology overlay (M3.9) and `ModelHealth` matrix (M3.7) for free.
  - `family ∈ {sabr}` at launch (SVI deferred to BUGS_AND_IMPROVEMENTS § Future improvements; the architecture keeps `family` as an open enum so adding it later is module-drop, not refactor).
  - `freeze ∈ {none, alpha-from-ts, volvol-and-alpha-from-ts}` — controls which params the term-structure pins before the per-expiry optimizer runs.
  - `weights ∈ {uniform, atm-manual, bidask-spread, bidask-spread-sma}` — controls residual weighting in the SABR objective. SMA-of-bid/ask-spread weighting needs a small per-`(currency, expiry)` ring buffer of spreads keyed by strike, sourced from the chain stream that's already running.
  - `time_basis ∈ {cal, wkg}` — selects whether `t_years_cal` or `t_years_wkg` is fed to the calibrator (and consumed by the pricer for that leg). Cal-basis presets do NOT depend on `calendar_rev`; wkg-basis presets do. Methodology IDs encode the basis as a suffix (e.g. `sabr_alpha-from-ts_bidask-sma_wkg` vs `..._cal`).
- **Term-structure curves** are first-class `CurveBuilder`s independent of smiles. Two ship in M3.8: `ts_alpha_dmr` (depends on naive-SABR α(T), runs `fit_double_mean_reversion` from `dmr_util.py`) and `ts_atm_linear_dmr` (depends on chain ATM IV directly). Both emit a uniform `TermStructureSnapshot {atm_vol_at_T, alpha_at_T, fwd_var_at_T, params}` so smile presets that consume them never branch on which TS produced the snapshot. The `volvol-and-alpha-from-ts` freeze additionally reads a `volvol_smr` companion fit (`backend/calibration/volvol_smr.py`); ρ-smoothing via `rho_smr.py` is available for any preset that wants it but is not on the freeze axis (ρ stays per-expiry by default — see `dmr_util_functions.py` comment on why DMR doesn't apply to ρ).
- **Variance-swap term-structure parameterization** is deferred to BUGS_AND_IMPROVEMENTS § Future improvements; the two DMR methods cover the immediate term-structure needs and share the same math module.
- **Per-snapshot dependency-resolved compute pipeline** in the backend `DeribitAdapter` (FastAPI singleton): `chain_snapshot → sabr_naive_perexpiry (if any consumer needs it) → CurveBuilders (topo-sorted) → Smile calibrators (per subscribed expiry × preset)`. Each layer caches by `(... , snapshot_ts, calendar_rev)` and is computed at most once per chain poll regardless of how many subscribers want it. **Two-layer dedup honoring HRT principle 1:** the *backend engine* dedups compute via the snapshot-keyed cache; the *frontend SharedWorker oracle* dedups WS conversations via `acquireSharedStream` keyed on `(currency, expiry, methodology, ts_method)` — `calendar_rev` rides on the envelope, not the conversation key, so recalibrate doesn't churn open subscriptions (HRT principle 6). Two SmileCharts on the same `(expiry, methodology, ts_method)` produce one backend fit AND one WS conversation; switching the methodology dropdown adds a new key without disturbing the others.
- **New dual-mode services land alongside the existing ones (HRT principle 2).** All follow the `isOracleContext` / `registerService` / `subscribeRemote` pattern from `worker/hrtWorker.ts` and ship structured-clone-safe payloads only:
  - `worker/calendarService.ts` — `getCalendar()`, `putCalendar(c)`, `recalibrate()` one-shots plus a `calendarStream()` conversation. Wraps `/api/calendar` and `/api/calendar/recalibrate`. Tabs never reach the HTTP routes directly.
  - `worker/methodologyService.ts` — `methodologyCatalog()` one-shot. Wraps `/api/methodologies`. Refcount-shared so all dropdowns across all tabs hit one fetch.
  - `worker/termstructureService.ts` — `termStructureStream(currency, method)` conversation, plus `fetchHistoricTermStructure(currency, method, asOfMs)` one-shot mirroring `fetchHistoricSmile`.
  - `worker/bucketsService.ts` — `bucketsStream(currency, expiry, methodology, ts_method, lookback_ms)` conversation. Same shape as `historyService`'s `seriesStream` / `aggregateStream`.
- **Calendar revision propagates through existing conversations, not replays** (HRT principle 3). A recalibrate triggers backend cache invalidation + recompute; every open `subscribe_smile` / `subscribe_termstructure` / `subscribe_methodology_buckets` conversation re-emits the affected envelopes with the new `calendar_rev`. Clients learn through the conversations they already subscribe to. The `calendar.updated` bus topic is informational only (e.g., for a "calendar changed" toast) and does not carry fit data.
- **Vol-time / wkg-time runs through every layer.** `backend/vol_time.py` exposes `vol_yte(expiry_ms, as_of_ms, calendar)` and `cal_yte(expiry_ms, as_of_ms)`. The wrappers in `backend/curves/` route `t_years_cal` or `t_years_wkg` to the calibrator based on the preset's `time_basis` axis (`dmr_util` already accepts arbitrary `yte` arrays). Every fit envelope ships both `t_years_cal` and `t_years_wkg` so the frontend axis-toggle is free, and the pricer respects each leg's preset basis when computing decay / mark.

### Calendar revision and recalibration

- Calendar revision is a hash of `(holiday_weights, sat_weight, sun_weight)` only — name edits do NOT bump the revision (avoids invalidating fits for cosmetic edits while a user is mid-typing).
- **No automatic refit on calendar edit.** A `recalibrate` button on `VolCalendar` is the single trigger. On click: walk the cached fits **filtered to wkg-basis methodologies only** (cal-basis presets have no `calendar_rev` dependency and are skipped), compute the diff vs current revision, surface a confirmation count that reflects the actually-stale subset ("recalibrate 71 cached wkg-basis fits across 14 expiries × 4 methodologies × 24h history?" — cal-basis fits are not in the count), and on confirm recompute every stale entry. This handles both directions — every previously cached wkg-basis historic-bucket fit is refitted under the new calendar, and every snapshot from this point forward uses the new revision in its wkg-basis cache keys. Cal-basis fits remain bit-identical across recalibrate. Frozen-overlay subscribers get fresh envelopes carrying the new `cal rev: N` annotation in the toolbar (wkg-basis subscriptions only).
- **Single shared calendar across BTC + ETH** for now. Crypto trades 24/7 so all "holidays" are weight adjustments rather than closures. Per-venue / per-currency calendars wait until M6 Bloomberg surfaces a real need (TradFi instruments closing on different days than crypto). Architecture: `Calendar` keyed by `currency_or_venue` with a default-shared calendar; do not pre-build the multi-calendar UI.
- **Calendar presets** for the manual weight entry live in `frontend/src/shared/calendarPresets.ts` (`[{label: "Full holiday", weight: 0.1}, {label: "Half day", weight: 0.5}, {label: "Custom", weight: null}]`). User-extended presets are a future improvement.

### `ModelHealth` widget — single tabbed widget, persistent per-tab state

One widget with three internal tabs (RMSE matrix · parameter stability · vol-time diagnostics). **State is persistent across tab switches** — current methodology selection, expiry filter, time-window, scroll position, sort orders all live in the widget config so:
1. Switching tabs is seamless (no re-mount, no reset to defaults).
2. A widget restored from a saved profile remembers its last-viewed sub-state per tab.
3. Each tab's state is independently scoped (changing the methodology filter on the RMSE tab doesn't disturb the parameter-stability tab's expiry selection).

Implementation: `ModelHealthConfig` carries a discriminated `tabs: {rmse: RmseTabState, paramStability: ParamStabilityTabState, volTime: VolTimeTabState}` block plus a top-level `activeTab` pointer. Each tab component reads/writes its own slice via the existing `onConfigChange` plumbing; switching tabs is a `setState({activeTab})` only.

**Vol-time tab — cal-vs-wkg A/B view.** Auto-pairs presets by their non-`time_basis` axes (i.e. matches `sabr_alpha-from-ts_bidask-sma_cal` ↔ `sabr_alpha-from-ts_bidask-sma_wkg`) and renders, per pair: ΔRMSE per expiry, Δα, Δν, Δρ, with a "wkg better here / cal better here" colorbar driven by sign of ΔRMSE. Powered by the same M3.9 bucketed cache the other tabs read from — A/B is just a `groupBy(non-time-basis-axes)` reduction over the matrix, no new compute path. Settings panel: pair-selector multi-select (default: all pairs where both variants are catalog entries), expiry filter, lookback window. This is the v1 answer to "did wkg actually help this model?" — the recalibrate-and-eyeball loop on individual charts is supplementary, not the primary analysis surface.

### Bucketed fit cache (M3.9) — built here, consumed by M4.5

The bucketed cache `{(currency, expiry, methodology, ts_method, bucket_ts, calendar_rev): FitResult}` is the deliverable in M3.9 (powers history overlays in `SmileChart` / `TermStructureChart` and the parameter-stability tab in `ModelHealth`). M4.5's `AnalysisService.fitHistory` becomes a lookup over this cache rather than its own bucketing pass — keeping the bucketing logic in one place and letting M4.5 ship as a thin adapter. Cache lives in `DeribitAdapter`, keyed at hourly boundaries for the trailing 24h, seeded on first subscription per `(currency, expiry, methodology, ts_method)` from `HistoryStore` chain replay. Eviction follows the 24h `HistoryStore` cap (a bucket falls out when its underlying chain samples fall out). Calendar-revision invalidation hooks into the same cache: stale-revision entries are recomputed by the recalibrate button.

### Open items

- Whether the cross-methodology comparison overlay in `SmileChart` should cap at N concurrent comparisons (compute is O(N) per chain poll; visual clutter past 3–4 lines is real). Lean: cap at 4 by default, configurable.
- ν-smoothing fitter (`backend/calibration/volvol_smr.py`) is the analog of `fit_rho_smr` for SABR's ν parameter; the existing math file doesn't ship it. Easiest path: copy `fit_rho_smr` and adapt (ν is positive so no atanh transform needed; fit in log-ν or fit ν directly with positive-bound `_smr_model`). One small new function landing in M3.8 alongside the curve builders.
- Theta basis in the pricer: when a leg's chosen methodology declares `time_basis: "wkg"`, decay-per-real-day vs decay-per-vol-day differ by the holiday weight. Display two thetas (`Θ_cal/d`, `Θ_wkg/d`) when relevant, or pick the wkg-time one as canonical and document. Lean: wkg canonical with a tooltip showing the cal equivalent.
- Whether `ModelHealth`'s vol-time tab should also show a "calendar diff" view comparing residuals at calendar revision N vs N-1 (would let the user A/B-test holiday weight tweaks across revisions of the same calendar). Probably not v1 — the cal-vs-wkg pair view (above) covers the more important "did wkg help this model?" question, and the recalibrate-and-look loop on individual charts covers iteration on weight values within wkg-basis. Revisit once a real workflow surfaces a need to compare two non-default calendars side-by-side.

## Defaults locked in

- SABR: β = 1, per-expiry independent fits via `sabr_greeks.SABRfit`.
- Data transport: **REST throughout, polled at 2s.** No WS in the production path. Sub-1s fidelity is a non-goal for this screener at every level (chain, per-instrument, forwards, trades).
- Chain-level: `get_book_summary_by_currency` per currency every 2s. Sizes are *not* shown in `ChainTable` by default (require per-instrument calls — see [data strategy](#rate-limits--data-strategy)).
- Per-instrument: `public/ticker` per open `InstrumentDetail` every 2s; `get_last_trades_by_instrument_and_time` delta-fetched at 2s for the trade-print panel.
- Frozen historic-fit overlay: user-pinned timestamp from the 24h `HistoryStore`; default as-of is `(mount_time − 24h)` captured in a session-local ref (not persisted, since a stale absolute timestamp would sit outside the 24h buffer on next session).
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
