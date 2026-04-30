# Bug Log

Open issues and triage notes. Each entry: short title, status, complexity, repro / observed behaviour, hypothesis (if any), suggested next step.

Status legend: `open` (not started) · `triage` (need to reproduce / scope before estimating) · `in-progress` · `fixed`.
Complexity legend: `S` (afternoon) · `M` (a day or two) · `L` (multi-day, possibly architectural) · `?` (not yet sized — triage required).

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
