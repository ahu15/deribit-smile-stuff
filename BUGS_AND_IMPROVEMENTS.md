# Bugs and Improvements

Open issues, triage notes, and improvement ideas. Each entry: short title, status, complexity, repro / observed behaviour, hypothesis (if any), suggested next step.

Status legend: `open` (not started) · `triage` (need to reproduce / scope before estimating) · `in-progress` · `fixed`.
Complexity legend: `S` (afternoon) · `M` (a day or two) · `L` (multi-day, possibly architectural) · `?` (not yet sized — triage required).

Sections below: **Bugs** → **Improvements** → **Future improvements (deferred)**.

---

## Bugs

---

## #1 — Saved layouts/views break on every feature push

**Status:** open
**Complexity:** L
**First observed:** ongoing — surfaces every time a new widget feature lands.

**Symptom.** Saving a Dockview profile (named layout + per-widget config) and then reloading after a feature merge often yields a broken view: missing panels, panels that render empty, stale config that doesn't match the new schema, or — worst case — a layout that fails to mount entirely and falls back to default.

**What's already in place.**
- `WidgetSpec.configVersion` + per-widget `migrate(old, oldVersion) → new`. Bumping `configVersion` and registering a migrator works *for one widget at a time*.
- `WidgetPanel` runs the registered migrator on load, then writes the migrated config back via `api.updateParameters`.
- `ProfileBundle` has a top-level `version: 1`.

**Why it still breaks.**
- The discipline isn't enforced — adding a config field without bumping `configVersion` silently corrupts saved layouts.
- Cross-widget concerns aren't versioned at all: layout-template references, per-widget instance IDs, the widget registry itself. If a widget is renamed or unregistered, the saved layout has no migration path.
- The `ProfileBundle` schema version hasn't been incremented even when its shape changes have been considered, so import-side validation can't catch a shape drift.
- No CI / dev-time guard that flags "this PR added a config field but didn't bump configVersion."

**Why this is `L` and not `M`.**
- The fix isn't one bug — it's a versioning + migration discipline that needs to be designed. Candidates:
  - A `validate(config)` slot on `WidgetSpec` that runs alongside `migrate` and rejects invalid loads cleanly (panel renders an "unsupported config" placeholder rather than corrupting the layout).
  - A registry-level version (bumped when widgets are added / renamed / removed) so the bundle import can refuse to load layouts from a future or incompatible registry.
  - A schema-test harness: lint that diffs the inline `defaultConfig` shape against the previous commit's and fails the build if `configVersion` didn't change.
  - A clearer separation between "user-authored" config (what the user typed) and "derived" config (filled in from defaults) so missing fields are filled rather than treated as breaking.
- Decision wanted: do we treat the saved layout as authoritative (and migrate aggressively forward), or as advisory (and fall back to defaults silently)? Today it's somewhere in between.

**Next step.** Spec a layout-persistence redesign as its own milestone-sized doc before fixing piecemeal. Don't apply ad-hoc patches that defer the underlying versioning gap.

---

## #2 — Frozen historic-fit overlay broken: as-of input does nothing, freezes from session start

**Status:** triage
**Complexity:** ? (size after repro)
**First observed:** during M3+ verification round; needs re-verification on current `main`.

**Symptom (as reported).**
- The frozen-curve overlay in `SmileChart` appears to freeze from the *onset* of the current session, not from a previous day's data — implying the `as_of_ms` request isn't reaching the backend, or `historic_smile_fit` is finding no pre-session samples in the `HistoryStore` and silently snapping forward.
- The settings-panel buttons that move the as-of timestamp (override, reset) appear non-functional — user changes are not reflected on the chart.

**Suspected root causes (to verify during triage).**
- `HistoryStore` rolling 24h buffer is populated *only* by the M2.5 backfill + live polling — at session start, the 24h window technically covers the previous day, but the buffer may be empty for older timestamps until backfill completes. If the user opens `SmileChart` before backfill finishes, the as-of clamps to the earliest sample (which is "now-ish") and stays there.
- The default as-of is captured as `(mountTime − 24h)` in a ref *at first mount*. If that ref isn't recomputed when the user explicitly changes the input, edits could be silently overwritten.
- `fetchHistoricSmile` is an oracle-routed one-shot service — verify the conversation id is being threaded through correctly and the backend response carries the expected `snappedTs`. A stale cache key on the oracle side would cause repeated requests with different `as_of_ms` to all return the first cached result.
- `datetime-local` input value parsing — local-time vs UTC mismatch on submission could send the same timestamp regardless of what the user typed.
- The "reset" button may be re-using the original mount-time ref (now stale) instead of recomputing `(now − 24h)`.

**Triage steps.**
1. Reproduce on current `main`: open `SmileChart`, wait for backfill to complete (status pill `history ✓`), then change the as-of input to `(now − 6h)`. Inspect the network tab for the `historic_smile` request and the rendered `frozen @ HH:MM:SS` label.
2. Confirm whether `HistoryStore.range(name, "mark_iv", t0, t1)` returns samples at the expected pre-session timestamps (HTTP helper `GET /api/history/range` is already in place).
3. Diff the wired-up `as_of_ms` between (a) initial mount, (b) after override edit, (c) after reset.
4. Check `oracle.ts`'s one-shot service caching — confirm distinct `as_of_ms` values produce distinct upstream calls.

**Complexity sizing — pending triage.** Likely `S` if the cause is one of the smaller hypotheses (input parsing, ref staleness, cache key); could escalate to `M` if backfill ordering or `HistoryStore` range semantics need revisiting.

**Next step.** Reproduce + isolate one hypothesis at a time before patching. Don't ship a "fix" that just re-renders the chart on input change without identifying which layer is dropping the request.

---

## #3 — New `SmileChart` waits for the next chain poll before rendering anything

**Status:** open
**Complexity:** S
**First observed:** routine use — open a second `SmileChart` on a new `(currency, expiry)` and the curve doesn't draw until the next 2s chain poll arrives.

**Symptom.** A freshly mounted `SmileChart` (or any new subscription to `smileService.smileStream`) sits empty for up to ~2s after mount. The fit only computes when the *next* chain poll fires — even though the adapter already holds a perfectly recent `ChainSnapshot` in memory from the most recent poll.

**Why.** `_subscribe_smile` in `backend/main.py` pumps via `async for snap in adapter.chain_stream(currency)`. `chain_stream` is a live generator over future polls; it doesn't replay the last snapshot. New subscribers therefore have to wait for tick N+1 before they see anything, even though tick N is sitting in the adapter.

**Fix sketch.** On subscribe, before entering the live `async for` loop:
- Grab the most recent `ChainSnapshot` for the currency from the adapter (`adapter.latest_snapshot(currency)` — needs reintroducing; was dropped in M3 hygiene).
- Compute the smile fit for the requested `(currency, expiry)` against that snapshot and emit one `smile_snapshot` envelope immediately.
- Then enter the existing live loop.

Same fix applies to `_subscribe_chain` — new chains also wait a tick to render.

**Cache reuse.** Once methodology+TS calibration lands per the smile-architecture redesign, the cached `(currency, expiry, methodology, ts_method, snapshot_ts)` fit can be hit directly without re-running the optimizer for the replay frame — so the "render last poll instantly" path becomes free if another widget already calibrated this configuration.

**Watch-out.** Don't replay if the snapshot is older than some threshold (e.g. > 10s) — better to render the empty state than ship a stale-looking curve as if it were live. Toolbar timestamp already shows snapshot age, so a single stale frame is benign, but worth a sanity bound.

**Next step.** Add `latest_snapshot(currency) -> ChainSnapshot | None` back to `DeribitAdapter`, prepend a one-shot replay emit in `_subscribe_chain` and `_subscribe_smile`, verify a second `SmileChart` paints inside ~50ms instead of waiting up to 2s.

---

## #4 — Refresh interval appears to degrade after long uptime; need to find the cause and add cache-clear control

**Status:** triage
**Complexity:** ? (probably M; sizing depends on root cause)
**First observed:** anecdotally after the app has been open for several hours — chain polls land at the expected 2s cadence early in a session, but the perceived refresh rate slows over time.

**Symptom.** UI updates feel less frequent the longer the app has been running. Tick flashes thin out; SABR fit toolbar timestamps advance more slowly than wall-clock would suggest.

**Hypotheses to verify (in rough priority).**
1. **`HistoryStore` 24h-capped deques are full and growing append cost.** Each per-`(instrument, field)` deque is `maxlen=24h*polls`. Once full, every new poll triggers a left-pop + listener fan-out. With ~hundreds of instruments × multiple fields × subscriber callbacks, the `_merge`/append path could be bottlenecking. Even though deques are O(1) at both ends, the *listener-callback fan-out* on every append could be the culprit if subscriber sets have grown.
2. **Subscriber-set leaks.** WS reconnects, widget remount cycles, StrictMode double-mounts, or any path that registers a `subscribe_series`/`subscribe_aggregate` listener without an `unsub()` would accumulate dead callbacks. Each new sample fires every leaked callback. The Quick Pricer registration leak (PLAN.md §M3.5) was an analogous bug class.
3. **Tab-side per-cell flash animation refs.** `ChainTable` keeps a per-cell prev-value ref + 700ms `Element.animate` per cell. With many cells × long uptime, the JS heap could be growing if animations aren't being collected. Lower-priority hypothesis but worth checking devtools memory profile.
4. **WS message backlog.** If the oracle's per-conversation pump can't keep up, messages queue. Check `ws.bufferedAmount` over time — sustained growth means the consumer side has fallen behind.
5. **Token-bucket pool exhaustion at long horizons.** `PriorityRestQueue` should refill, but a slow leak in the issued/returned token accounting would gradually starve live polls. Status pill bucket-% over time should show this.

**Repro plan.**
- Leave the app running for 4–8h with one or two `ChainTable` + `SmileChart` widgets open. Capture (a) chain timestamps over time (`snap.timestamp_ms` deltas), (b) status pill bucket% / queue-depth, (c) tab JS heap, (d) backend process memory.
- If the cadence visibly slows, snapshot the `HistoryStore` deque populations and the subscriber-set sizes (worth adding a quick `/api/diagnostics` route during the investigation). A subscriber set with thousands of entries against a single instrument is the smoking gun for hypothesis 2.

**Mitigation: cache-clear control (independent of root cause).**
- Add a "trim cache to last 24h" button next to the StatusPill. Calls a backend `/api/history/trim?keep_ms=86_400_000` (or similar) that walks every deque and pops anything older than `now - keep_ms`. Default param matches the existing 24h cap so the button is idempotent at steady state but useful if/when the cap is later relaxed (e.g. session-long retention experiments). A second variant — "trim to last 1h" — is the sharper instrument when investigating slowdown.
- **Frozen-smile interaction.** Trimming the buffer below the as-of timestamps that any open `SmileChart` is currently freezing on will silently break those overlays — `historic_smile_fit` will clamp the as-of forward to the new earliest sample. Two acceptable behaviors:
  - Block the trim if any open SmileChart's as-of is older than `now - keep_ms`, surface a confirmation dialog listing affected charts.
  - Allow the trim and emit a `historic_overlay_invalidated {reason: "buffer_trimmed", new_earliest_ms}` event on the bus; affected `SmileChart` instances visibly grey their frozen overlay and show "frozen overlay timestamp is no longer in buffer — pick a new as-of."
  - Lean: option 2 (allow + invalidate). The trim button is a debugging tool; blocking it on a frozen overlay is friction without a corresponding safety win, and the invalidation event is a clean signal.
- Track per-deque `popleft` counters so the trim button reports "trimmed N samples across M series" — tells the user what just happened and helps confirm the trim was real.

**Next step.** Add the `/api/diagnostics` route + status-pill bucket-history sparkline, run the long-uptime repro, isolate one hypothesis, *then* size the fix. Cache-clear control can ship in parallel as a standalone improvement (it's useful even if the underlying cause turns out to be unrelated to deque size).

---

## Improvements

---

## #5 — Color palette pass for dark and light modes (visual clarity)

**Status:** open
**Complexity:** S–M
**First observed:** ongoing usage feedback.

**Goal.** Improve at-a-glance legibility across both palettes, particularly around (a) ITM cell shading vs tick-flash overlap, (b) bid (warm) / ask (cool) separation against the background, (c) the `--neg` magenta-red vs `--bid` warm-orange in dark mode (currently distinct but only by hue, not by lightness — desaturating the dimmer one helps), (d) light-mode SABR fit lines reading as low-contrast against `--paper` for the ETH purple accent specifically.

**Investigations to run.**
- Audit each token in `COLOR_PALETTE.md` against actual painted cells/lines: pull the rendered RGB from a live frame and compute APCA/WCAG contrast against the surrounding background. Anything below ~60 APCA Lc on data text is a candidate to bump.
- Check whether bid/ask hue rotation (currently warm 50° / cool 220°) survives a colorblind sim — protanopia in particular collapses warm-vs-cool. Could swap to a luminance-separated pair (warm bright, cool dim) to give a second non-hue axis.
- Consider swapping the dark-mode background from deep blue-black (`oklch ~0.18 0.02 250`) to a slightly warmer near-black if the blue cast is competing with the blue accent — currently the `--accent` reads muted because it's close to `--bg` in chroma.
- Light mode: the cool-gray paper makes warm bid pop but the ETH purple reads dusty against it — either bump the purple's chroma in light mode specifically (per-symbol identity colors are already allowed to deviate), or pick a slightly different purple anchor for the light palette.
- Switching ITM shading from a tinted background to a one-pixel left/right edge marker on the cell — keeps the cell text on the same contrast as OTM cells, recovers tick-flash visibility on ITM cells (currently flashes are suppressed there per `ChainTable` design).

**Open question.** Whether the two palettes should share token *meanings* (one `--bid` semantically, two values) or each have their own optimization (different hues per palette where the perceptual axis differs). Current setup is the former; the ETH-in-light issue suggests the latter may be needed for accent identity colors at minimum.

**Next step.** A short audit pass with screenshots + APCA numbers before changing tokens. Don't tweak hex values incrementally without a measurement — the palette gets re-tuned every time one cell looks off otherwise.

---

## #6 — Methodology compute throughput: process-pool parallelism + driver pattern

**Status:** open (deferred; option 1 shipped)
**Complexity:** L
**First observed:** during M3.95 ModelHealth verification — selecting all 16 methodologies populates only ~5 rows within the first chain poll; the heavier weighted calibrators (`atm-manual`, `bidask-spread`, `bidask-spread-sma`) lag significantly behind the 2s poll cadence.

**What's already in place (M3.95).**
- **Option 1: `asyncio.to_thread` per fit.** Every `calibrator.fit(ctx)` and `builder.build(ctx)` call now runs on Python's default thread pool via `asyncio.to_thread`, so a 200 ms SLSQP fit no longer blocks the event loop. WS frames, ping/health, chain/history streams all stay responsive while ModelHealth's matrix is filling in.
- **Per-key in-flight `asyncio.Future` dedup.** With the `await` between cache miss and cache write, two concurrent callers on the same key would otherwise both miss + both compute. The new `_fit_inflight` / `_ts_inflight` / `_smile_bucket_inflight` / `_ts_bucket_inflight` maps make the second caller await the first's result, preserving the M3.7 "compute at most once per (key, snapshot)" guarantee.
- **Frontend mitigations** layered on top: ModelHealth hides methodology rows whose first fit hasn't landed, surfaces a "N methodologies not shown — fits still computing" footer, and drops empty holiday-bucket columns. So the lag is legible rather than mysterious.

**Why it's still listed as `open`.**
- Option 1 stops the freeze; it doesn't grow throughput. With ~200 unique fit keys per chain poll and ~150 ms average per heavy calibrator, the per-snapshot CPU floor is still ~30 s of work being chewed through serially across thread-pool workers. The GIL means the thread pool gives roughly 1.2–1.8× speedup on multi-core, not Nx — scipy's wrappers around the C kernels hold the GIL for the wrapper code even though numpy/LAPACK release it in their kernels. The user-visible result is "ModelHealth fills in over 5–10 polls" instead of "instantly," which is acceptable for a diagnostic widget but not free.

**Deferred follow-ups (in rough effort order):**

1. **Option 2 — `ProcessPoolExecutor` for fits.** Sidesteps the GIL for true parallelism. ~Nx speedup on N cores for the math itself, but introduces:
   - `FitContext` / `BuildContext` pickling: today both reference `HistoryStore` (which holds `threading.Lock` instances + deque subscribers, not picklable). Need a "request DTO" that carries only the fields the calibrator actually reads (strikes, IVs, spreads, t, calendar_rev) — clean separation worth doing regardless.
   - Worker startup cost (~0.5–2s for first numpy/scipy import per worker). Mitigated by long-lived workers + small fixed pool; FastAPI lifespan needs explicit shutdown so `--reload` doesn't leak workers.
   - Numerical determinism: scipy is mostly deterministic given same input + version, but `curve_fit`'s LM trust region uses RNG for initial perturbation under some bounds configurations. Pin `np.random.seed(0)` per fit or accept that adjacent-poll output is approximately equal but not byte-identical. The plan's "byte-identical M3.5/M3.6 default" guarantee for the uniform path is at risk and needs a deliberate pin.
   - Worker crashes possible (rare scipy pathologies become process boundary issues). On the upside, isolated — one bad fit doesn't kill the FastAPI process.

2. **Option 3 — Snapshot-driver pattern.** Instead of N pump tasks each independently calling `smile_fit`, have one driver per `(currency, snapshot)` that collects the full set of subscribed `(methodology, expiry, ts_method)` keys, topo-sorts them (TS curves before alpha-from-ts smiles), dispatches the whole batch (sequentially / threadpool / processpool — orthogonal choice), and writes results into the cache. Pump tasks become pure consumers that wake when the driver finishes and serialize their WS frame.
   - Architecturally cleanest: aligns with the M3.7 plan's "compute at most once per chain poll regardless of how many subscribers want it" intent. Today the dedup is *passive* (cache lookup); with a driver it becomes *active* (driver decides what runs).
   - Enables batching: 12 methodologies × 13 expiries that share strike/IV data could be vectorized — build the (strike, IV, weight) arrays once, hand the batch to a worker that does N fits in a tight loop without re-pickling per fit. Compounds with option 2 since IPC becomes per-batch instead of per-fit.
   - Enables priority ordering: live-primary subscribers' fits run before ModelHealth-overlay fits, instead of leaving it to scheduler luck.
   - Enables explicit backpressure: if the driver can't finish before the next snapshot arrives, drop the oldest snapshot's pending fits and start fresh on the new one — instead of letting 50 backlogged snapshots queue per pump.
   - Per-fit timeout (`asyncio.wait_for` around each future) becomes natural here — one pathological calibrator stalling the batch is otherwise the worst-case under any of these designs.
   - Largest refactor: pump task lifecycle splits into "registrar" (declares interest in a key) and "consumer" (awaits driver result for that key on each snapshot). Cancellation, error handling, partial-fit semantics all need redesign.

**Recommended sequencing if/when this becomes load-bearing.** Option 1 → option 3 (driver scaffolding around current sync/threadpool dispatch) → swap option 3's backend from threadpool to processpool. Skipping option 1 and going straight to option 2 leaves the per-fit IPC tax exposed; skipping straight to option 3 is a big refactor with no immediate user-visible win unless option 1 is already in place.

**Other ceilings to keep in mind** (these matter even after options 2 + 3 land):

- **Memory grows quadratically in (subscribers × methodologies × time).** The bucket caches are 24h × hourly × per-(currency, expiry, methodology, ts_method) — already ~80 MB at full ModelHealth fan-out. Pruning is per-snapshot, not size-bounded. A future LRU on bucket count or a total-size limit would matter.
- **WebSocket fan-out becomes the next bottleneck.** Under option 3's batched-emit pattern, 200+ envelopes per chain poll get JSON-serialized and shipped; `json.dumps` is single-threaded (~30–80 ms), per-connection write buffers can backpressure, and the browser-side oracle has to deserialize and dispatch them all on a single SharedWorker thread. Mitigations: drop unused payload fields (ModelHealth doesn't need `fitted_iv`), use orjson, offload serialization with `to_thread`.
- **Term-structure prior is a hard serial dependency.** The DMR fit gates every alpha-from-ts cell at the same basis; can't trivially parallelize the SMR-then-DMR warm-start path. Today ~100 ms per TS — if a future builder is heavier (e.g. variance-swap parameterization), this becomes the dominant serial cost.
- **Cache coherence under recalibrate.** Today's drain happens on the loop thread, synchronous. Under option 2 you can have workers mid-fit on the old rev that finish and write stale-rev entries to cache after the recalibrate completes. Solved cheaply by checking `current_rev` before accepting batch results into the cache (the rev-on-envelope pattern already in place handles the read side).
- **Tail latency from numerical pathologies.** Occasional `curve_fit` non-convergence triggers SLSQP fallback that takes 2 s instead of 200 ms. Under option 3's batched parallel execution this doesn't help — the batch finishes when its slowest fit finishes. Per-fit timeout that returns null on overrun is necessary if you want bounded per-snapshot wall-clock.
- **Dev-loop friction** from process-pool startup costs and pickle audits. Workers spawn fresh interpreters and import scipy from disk; iterating on `backend/calibration/*.py` requires worker restarts. Modest, but not zero.

**Next step.** No action until a workload actually requires it. The current "diagnostic widget that fills in over a few polls" UX is acceptable for the present scale (one or two analysts, one or two browser tabs). When a user starts wanting the matrix to update at chain cadence on every poll, or M4.5 / M5 surfaces fan-out comparable in scale to ModelHealth, revisit with the sequencing above.

---

## Future improvements (deferred)

These are noted for completeness but explicitly *not* on the near-term roadmap. Revisit if the underlying need changes.

### SVI parameterization for smile fits

Mentioned in the multi-methodology architecture sketch as a peer to SABR; deferred because (a) Deribit's lognormal mark-IV convention pairs naturally with SABR β=1, (b) all cross-methodology comparison value can be obtained from the SABR variants (α-frozen, weighted, smoothed-volvol) before adding a second family, (c) SVI's no-arbitrage constraints (Roger Lee wing bounds, butterfly/calendar) introduce calibration complexity that isn't needed to validate the term-structure work first. Architecture explicitly leaves room for a second `family` value (`svi`) in the `Calibrator` interface — adding it later is a module drop, not a refactor.

### Variance-swap term-structure parameterization

The third TS method in the original sketch (`ts_var_swap`). Deferred in favor of focusing on the two DMR-based methods (α-DMR and ATM-linear-DMR) which share the existing `dmr_util_functions.py` machinery. Variance-swap parameterization is conceptually clean but introduces a separate fitting path; revisit once the DMR methods are validated and there's a reason to compare against an alternate TS form.
