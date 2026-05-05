import asyncio
import logging
import time
from collections import defaultdict
from collections.abc import AsyncIterator
from dataclasses import dataclass, field

from backend.backfill import Backfill
from backend.chain import (
    BookSummary, ChainRow, ChainSnapshot, OptionMark,
    expiry_ms, parse_expiry, parse_option_type, parse_strike,
)
from backend.calibration import (
    FitContext, FitResult, SmileBucketKey, TsBucketKey,
    bucket_boundaries, bucket_floor, evict_old_smile_buckets,
    evict_old_ts_buckets, get_calibrator, resolve_alias,
)
from backend.curves import (
    BuildContext, TermStructureSnapshot, get_curve_builder,
)
from backend.fit import average_iv_by_strike
from backend.history import HistoryStore, Sample
from backend.iv import iv_from_price
from backend.ratelimit import RateLimitStatus
from backend.venues.base import VenueAdapter
from backend.vol_time import cal_yte, calendar_rev, get_active_calendar, vol_yte
from .auth import load_credentials
from .rest_client import DeribitRestClient

log = logging.getLogger(__name__)

_SUPPORTED_CURRENCIES = ["BTC", "ETH"]
_POLL_INTERVAL = 2.0  # seconds between book-summary polls
_HOUR_MS = 60 * 60 * 1000
_DAY_MS = 24 * _HOUR_MS


@dataclass
class HistoricSmileFit:
    """One-shot SABR fit replayed from `HistoryStore` at a chosen `as_of_ms`.

    `snapped_ms` is the per-instrument-nearest-sample stamp that the fit
    actually used; outside the 24h buffer it collapses to the boundary.
    `earliest_ms` / `latest_ms` describe the window the caller can pick
    from for the requested expiry — used by the UI to surface "no data".
    """
    fit: FitResult | None = None
    market_points: list[tuple[float, float]] = field(default_factory=list)
    snapped_ms: int | None = None
    earliest_ms: int | None = None
    latest_ms: int | None = None
    forward: float | None = None


class DeribitAdapter(VenueAdapter):
    def __init__(self) -> None:
        self._creds = load_credentials()
        self._rest = DeribitRestClient(self._creds)
        self._mark_queues: dict[str, list[asyncio.Queue]] = defaultdict(list)
        self._snapshots: dict[str, ChainSnapshot] = {}
        self._tasks: list[asyncio.Task] = []
        self.history = HistoryStore()
        self.backfill = Backfill(self._rest, self.history, _SUPPORTED_CURRENCIES)
        # Per-snapshot fit cache (M3.7): one fit per
        # (currency, expiry, methodology, ts_method, snapshot_ts, calendar_rev)
        # per chain poll. Pruned to the latest snapshot's ts on each insert
        # so size stays bounded by `expiries × methodologies × subscribers`.
        self._fit_cache: dict[
            tuple[str, str, str, str | None, int, str], FitResult | None
        ] = {}
        # Per-snapshot term-structure cache (M3.8): one TS snapshot per
        # (currency, ts_method, snapshot_ts, calendar_rev) per chain poll.
        # Two SmileCharts on the same (curve method, basis) consume the
        # same upstream TS fit (HRT principle 1, backend half).
        self._ts_cache: dict[
            tuple[str, str, int, str], TermStructureSnapshot | None
        ] = {}
        # Bucketed historic-fit cache (M3.9): hourly-boundary fits across
        # the trailing 24h, seeded on first subscription per `(currency,
        # expiry, methodology, ts_method)` from `HistoryStore` chain
        # replay. Powers the history-overlay UI in SmileChart /
        # TermStructureChart and (later) M4.5's `AnalysisService.fitHistory`.
        self._smile_bucket_cache: dict[SmileBucketKey, FitResult | None] = {}
        self._ts_bucket_cache: dict[TsBucketKey, TermStructureSnapshot | None] = {}
        # M3.95+ — in-flight Future maps keyed identically to the caches
        # above. SABR/DMR fits are dispatched via `asyncio.to_thread` so
        # CPU-bound calibrator work doesn't block the event loop; with the
        # await between cache-miss and cache-write, two concurrent callers
        # on the same key would otherwise both miss + both compute. The
        # in-flight Future lets the second caller await the first's result.
        # Preserves the "compute at most once per (key, snapshot)" guarantee
        # under cooperative interleaving.
        self._fit_inflight: dict[
            tuple[str, str, str, str | None, int, str], asyncio.Future
        ] = {}
        self._ts_inflight: dict[
            tuple[str, str, int, str], asyncio.Future
        ] = {}
        self._smile_bucket_inflight: dict[SmileBucketKey, asyncio.Future] = {}
        self._ts_bucket_inflight: dict[TsBucketKey, asyncio.Future] = {}

    async def start(self) -> None:
        await self._rest.start()
        # Run backfill first, THEN spawn the live poll loops. The HistoryStore
        # rejects out-of-order writes (a stale poll mid-backfill mustn't
        # overwrite freshly-seeded data) — but if live polls run first, every
        # 24h-old backfill sample lands "in the past" relative to the live
        # samples already in the buffer and gets silently dropped. Running
        # backfill first costs ~5s of empty chain at startup (the StatusPill
        # already shows `history NN%` during this window), but means the
        # frozen-overlay actually has historic data to snap to.
        self._tasks.append(asyncio.create_task(self._startup_seed_then_live()))
        log.info("DeribitAdapter started — backfill first, then REST polling @ %.0fs", _POLL_INTERVAL)

    async def _startup_seed_then_live(self) -> None:
        try:
            await self.backfill.run()
        except Exception as exc:
            # Even if backfill fails partway, start live polling so the UI
            # isn't permanently empty. Trade-seed coverage will be partial.
            log.warning("backfill failed: %s — starting live polling anyway", exc)
        for ccy in _SUPPORTED_CURRENCIES:
            self._tasks.append(asyncio.create_task(self._poll_loop(ccy)))

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        await self._rest.stop()

    async def _poll_loop(self, currency: str) -> None:
        while True:
            try:
                summaries = await self._rest.get_book_summary_by_currency(currency)
                self._merge(currency, summaries)
                snap = self._snapshots.get(currency)
                if snap:
                    self._emit(currency, snap)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                log.warning("poll error %s: %s", currency, exc)
            await asyncio.sleep(_POLL_INTERVAL)

    def _merge(self, currency: str, summaries: list[dict]) -> None:
        ts = _now_ms()
        snap = self._snapshots.setdefault(
            currency, ChainSnapshot(currency=currency, timestamp_ms=ts)
        )
        snap.timestamp_ms = ts
        # Per-expiry option-implied forward — every option carries its expiry's
        # forward in `underlying_price`. One value per expiry per snapshot;
        # written out once at the end of the loop to avoid 50× redundant appends.
        forward_opt_by_expiry: dict[str, float] = {}
        for s in summaries:
            name = s.get("instrument_name", "")
            if not name:
                continue
            # book_summary IV is quoted in percent — normalise to decimal.
            mark_iv = (s.get("mark_iv") or 0.0) / 100.0
            mark_price = s.get("mark_price") or 0.0
            bid_price = s.get("bid_price")
            ask_price = s.get("ask_price")
            bid_iv = (s["bid_iv"] / 100.0) if s.get("bid_iv") is not None else None
            ask_iv = (s["ask_iv"] / 100.0) if s.get("ask_iv") is not None else None
            underlying = s.get("underlying_price") or 0.0

            expiry = parse_expiry(name)
            if expiry and underlying and expiry not in forward_opt_by_expiry:
                forward_opt_by_expiry[expiry] = underlying

            snap.marks[name] = OptionMark(
                instrument_name=name,
                mark_iv=mark_iv,
                mark_price=mark_price,
                underlying_price=underlying,
                timestamp_ms=ts,
            )
            snap.book_summaries[name] = BookSummary(
                instrument_name=name,
                bid_iv=bid_iv,
                ask_iv=ask_iv,
                bid_price=bid_price,
                ask_price=ask_price,
                open_interest=s.get("open_interest") or 0.0,
                volume_24h=s.get("volume") or 0.0,
                underlying_price=underlying,
                timestamp_ms=ts,
            )

            # Live append into the M2.5 store — same source of truth for the live UI
            # and for any "vs N hours ago" / session-high-low computation.
            self.history.append_series(name, "mark", ts, mark_price)
            self.history.append_series(name, "mark_iv", ts, mark_iv)
            if bid_price is not None:
                self.history.append_series(name, "bid_price", ts, bid_price)
            if ask_price is not None:
                self.history.append_series(name, "ask_price", ts, ask_price)
            if bid_price is not None and ask_price is not None:
                mid = 0.5 * (bid_price + ask_price)
                self.history.append_series(name, "mid", ts, mid)
                self.history.append_series(name, "spread", ts, ask_price - bid_price)

        for expiry, fwd in forward_opt_by_expiry.items():
            self.history.append_aggregate(currency, f"forward_opt:{expiry}", ts, fwd)

    def _emit(self, currency: str, snap: ChainSnapshot) -> None:
        for q in list(self._mark_queues[currency]):
            try:
                q.put_nowait(snap)
            except asyncio.QueueFull:
                pass

    async def chain_stream(self, currency: str) -> AsyncIterator[ChainSnapshot]:
        if currency not in _SUPPORTED_CURRENCIES:
            raise ValueError(f"unsupported currency: {currency}")
        q: asyncio.Queue = asyncio.Queue(maxsize=50)
        self._mark_queues[currency].append(q)
        try:
            while True:
                snap = await q.get()
                yield snap
        finally:
            try:
                self._mark_queues[currency].remove(q)
            except ValueError:
                pass

    # ---------- M3 chain & smile views ----------

    def expiries(self, currency: str) -> list[str]:
        snap = self._snapshots.get(currency)
        return snap.expiries() if snap else []

    def chain_rows(self, currency: str, expiry: str | None) -> list[ChainRow]:
        snap = self._snapshots.get(currency)
        if not snap:
            return []
        rows: list[ChainRow] = []
        for name, mark in snap.marks.items():
            inst_expiry = parse_expiry(name)
            if expiry and inst_expiry != expiry:
                continue
            strike = parse_strike(name)
            opt_type = parse_option_type(name)
            if strike is None or opt_type is None or inst_expiry is None:
                continue
            book = snap.book_summaries.get(name)
            bid = book.bid_price if book else None
            ask = book.ask_price if book else None
            mid = 0.5 * (bid + ask) if (bid is not None and ask is not None) else None
            spread = (ask - bid) if (bid is not None and ask is not None) else None

            # Deribit's get_book_summary_by_currency doesn't return bid_iv /
            # ask_iv for options, so book.* is None in practice. Invert the
            # coin-denominated quote to a vol via BS (forward = mark.underlying_price,
            # which is per-expiry on Deribit), seeded from mark_iv so Newton
            # converges in a couple of iterations.
            bid_iv = book.bid_iv if book else None
            ask_iv = book.ask_iv if book else None
            if (bid_iv is None or ask_iv is None) and mark.mark_iv > 0:
                ex_ms = expiry_ms(inst_expiry)
                if ex_ms is not None:
                    t_years = vol_yte(ex_ms, mark.timestamp_ms, get_active_calendar())
                    is_call = (opt_type == "C")
                    if bid_iv is None and bid is not None and bid > 0:
                        bid_iv = iv_from_price(
                            bid, mark.underlying_price, strike, t_years,
                            is_call=is_call, iv_guess=mark.mark_iv,
                        )
                    if ask_iv is None and ask is not None and ask > 0:
                        ask_iv = iv_from_price(
                            ask, mark.underlying_price, strike, t_years,
                            is_call=is_call, iv_guess=mark.mark_iv,
                        )

            rows.append(ChainRow(
                instrument_name=name,
                expiry=inst_expiry,
                strike=strike,
                option_type=opt_type,
                mark_iv=mark.mark_iv,
                bid_iv=bid_iv,
                ask_iv=ask_iv,
                mark_price=mark.mark_price,
                bid_price=bid,
                ask_price=ask,
                mid_price=mid,
                spread=spread,
                open_interest=book.open_interest if book else 0.0,
                volume_24h=book.volume_24h if book else 0.0,
                underlying_price=mark.underlying_price,
                change_1h=self.history.change(name, "mark", _HOUR_MS),
                change_24h=self.history.change(name, "mark", _DAY_MS),
                change_iv_1h=self.history.change(name, "mark_iv", _HOUR_MS),
                timestamp_ms=mark.timestamp_ms,
            ))
        rows.sort(key=lambda r: (expiry_ms(r.expiry) or 0, r.strike, r.option_type))
        return rows

    async def smile_fit(
        self,
        currency: str,
        expiry: str,
        methodology: str = "sabr-naive",
        ts_method: str | None = None,
    ) -> FitResult | None:
        """Fit one expiry of the latest chain under the given methodology.

        Dispatches through `backend.calibration.REGISTRY`; per-snapshot cache
        ensures multiple subscribers at the same key hit one fit per chain
        poll (HRT principle 1, backend half of the two-layer dedup).
        For `requires_ts` calibrators, populates `ctx.ts_snapshot` from the
        per-snapshot TS cache (computed lazily on first request).

        The actual `calibrator.fit(ctx)` call is dispatched to a worker
        thread via `asyncio.to_thread` so CPU-bound SABR/DMR math doesn't
        block the event loop — without this, a single 200ms SLSQP fit on
        one pump task stalls every other WS conversation for that long
        (chain, history, ping, etc.). See BUGS_AND_IMPROVEMENTS.md
        § Methodology compute throughput for the parallelism floor and the
        deferred process-pool / driver-pattern follow-ups.
        """
        snap = self._snapshots.get(currency)
        if not snap:
            return None
        ex_ms = expiry_ms(expiry)
        if ex_ms is None:
            return None
        cal = get_active_calendar()
        rev = calendar_rev(cal)

        resolved = resolve_alias(methodology)
        calibrator = get_calibrator(resolved)
        if calibrator is None:
            return None
        if calibrator.requires_ts and not ts_method:
            return None

        cache_key = (
            currency, expiry, resolved, ts_method, snap.timestamp_ms, rev,
        )
        if cache_key in self._fit_cache:
            return self._fit_cache[cache_key]
        # Another caller is mid-fit on this key — wait for its result rather
        # than starting a parallel duplicate fit (would defeat the cache).
        in_flight = self._fit_inflight.get(cache_key)
        if in_flight is not None:
            return await in_flight

        # Register the in-flight Future BEFORE any await so concurrent callers
        # see it during the term_structure_fit / to_thread awaits. Without this
        # the dedup window has a hole — two callers could both pass the
        # in-flight check and both compute.
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._fit_inflight[cache_key] = future
        try:
            ts_snapshot: TermStructureSnapshot | None = None
            if calibrator.requires_ts and ts_method:
                ts_snapshot = await self.term_structure_fit(currency, ts_method)

            ctx = FitContext(
                currency=currency,
                expiry=expiry,
                snapshot=snap,
                t_years_cal=cal_yte(ex_ms, snap.timestamp_ms),
                t_years_wkg=vol_yte(ex_ms, snap.timestamp_ms, cal),
                calendar_rev=rev,
                ts_snapshot=ts_snapshot,
                history_store=self.history,
            )
            result = await asyncio.to_thread(calibrator.fit, ctx)
        except asyncio.CancelledError:
            # Cancellation propagates; cancel (don't set_exception) the future
            # so any rare in-flight consumer is notified and Python doesn't
            # log "Future exception was never retrieved" when nobody awaits.
            if not future.done():
                future.cancel()
            self._fit_inflight.pop(cache_key, None)
            raise
        except BaseException as exc:
            if not future.done():
                future.set_exception(exc)
            self._fit_inflight.pop(cache_key, None)
            raise
        # Evict stale-snapshot entries on every insert — keeps the dicts
        # bounded by active subscribers × methodologies, not by uptime.
        self._prune_caches(currency, snap.timestamp_ms)
        self._fit_cache[cache_key] = result
        future.set_result(result)
        self._fit_inflight.pop(cache_key, None)
        return result

    async def term_structure_fit(
        self, currency: str, method: str,
    ) -> TermStructureSnapshot | None:
        """Build (or return cached) term-structure snapshot for the latest chain.

        `method` is a curve-builder id (e.g. `ts_alpha_dmr_cal`). Per-snapshot
        cache shared across all subscribers and across smile calibrators that
        consume the curve via `ctx.ts_snapshot` — one builder run per
        (currency, method, chain poll, calendar_rev). Builder math runs via
        `asyncio.to_thread` so the DMR fit doesn't block the loop.
        """
        snap = self._snapshots.get(currency)
        if not snap:
            return None
        builder = get_curve_builder(method)
        if builder is None:
            return None
        cal = get_active_calendar()
        rev = calendar_rev(cal)
        cache_key = (currency, method, snap.timestamp_ms, rev)
        if cache_key in self._ts_cache:
            return self._ts_cache[cache_key]
        in_flight = self._ts_inflight.get(cache_key)
        if in_flight is not None:
            return await in_flight

        # Per-expiry t_years in both bases. Skip expiries we can't parse.
        t_cal_by_expiry: dict[str, float] = {}
        t_wkg_by_expiry: dict[str, float] = {}
        for ex in snap.expiries():
            ex_ms = expiry_ms(ex)
            if ex_ms is None:
                continue
            t_cal = cal_yte(ex_ms, snap.timestamp_ms)
            t_wkg = vol_yte(ex_ms, snap.timestamp_ms, cal)
            if t_cal <= 0 or t_wkg <= 0:
                continue
            t_cal_by_expiry[ex] = t_cal
            t_wkg_by_expiry[ex] = t_wkg

        ctx = BuildContext(
            currency=currency,
            snapshot=snap,
            t_years_cal_by_expiry=t_cal_by_expiry,
            t_years_wkg_by_expiry=t_wkg_by_expiry,
            calendar_rev=rev,
        )
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._ts_inflight[cache_key] = future
        try:
            result = await asyncio.to_thread(builder.build, ctx)
        except asyncio.CancelledError:
            if not future.done():
                future.cancel()
            self._ts_inflight.pop(cache_key, None)
            raise
        except BaseException as exc:
            if not future.done():
                future.set_exception(exc)
            self._ts_inflight.pop(cache_key, None)
            raise
        self._prune_caches(currency, snap.timestamp_ms)
        self._ts_cache[cache_key] = result
        future.set_result(result)
        self._ts_inflight.pop(cache_key, None)
        return result

    def _prune_caches(self, currency: str, latest_ts: int) -> None:
        """Drop stale-snapshot entries from all per-snapshot caches."""
        stale_fits = [
            k for k in self._fit_cache
            if k[0] == currency and k[4] != latest_ts
        ]
        for k in stale_fits:
            del self._fit_cache[k]
        stale_ts = [
            k for k in self._ts_cache
            if k[0] == currency and k[2] != latest_ts
        ]
        for k in stale_ts:
            del self._ts_cache[k]

    async def historic_smile_fit(
        self,
        currency: str,
        expiry: str,
        as_of_ms: int,
        methodology: str = "sabr-naive",
        ts_method: str | None = None,
    ) -> HistoricSmileFit:
        """One-shot SABR fit from each instrument's closest mark_iv sample to
        `as_of_ms`. Frozen reference curve for the smile chart's "compare-to"
        overlay — outside the 24h buffer the snap collapses to the boundary
        so the user always gets *some* curve back.
        """
        snap = self._snapshots.get(currency)
        if not snap:
            return HistoricSmileFit()

        # Walk the expiry's universe once: capture the available window for
        # the UI's "data range" hint *and* the per-strike samples we'll snap.
        earliest_ms: int | None = None
        latest_ms: int | None = None
        per_inst_samples: list[tuple[float, list[Sample]]] = []
        for name in snap.marks:
            if parse_expiry(name) != expiry:
                continue
            strike = parse_strike(name)
            if strike is None:
                continue
            samples = self.history.series(name, "mark_iv")
            if not samples:
                continue
            if earliest_ms is None or samples[0].ts_ms < earliest_ms:
                earliest_ms = samples[0].ts_ms
            if latest_ms is None or samples[-1].ts_ms > latest_ms:
                latest_ms = samples[-1].ts_ms
            per_inst_samples.append((strike, samples))

        result = HistoricSmileFit(earliest_ms=earliest_ms, latest_ms=latest_ms)
        if not per_inst_samples:
            return result

        # Snap each instrument to its sample closest to `as_of_ms` (not
        # strictly at-or-before): outside the 24h window we clamp to a
        # boundary; inside it we tolerate sparse samples.
        pairs: list[tuple[float, float]] = []
        snapped_ms: int | None = None
        for strike, samples in per_inst_samples:
            best = min(samples, key=lambda s: abs(s.ts_ms - as_of_ms))
            pairs.append((strike, best.value))
            if snapped_ms is None or abs(best.ts_ms - as_of_ms) < abs(snapped_ms - as_of_ms):
                snapped_ms = best.ts_ms

        strikes, ivs = average_iv_by_strike(pairs)
        if not strikes or snapped_ms is None:
            return result

        # Forward at the snapped timestamp from the option-implied series.
        # Fall back to the latest snapshot's value if this expiry has no
        # forward history yet — order-of-magnitude correct for plotting.
        forward = self._forward_at(currency, expiry, snapped_ms)
        if forward is None or forward <= 0:
            return result

        ex_ms = expiry_ms(expiry)
        if ex_ms is None:
            return result
        cal = get_active_calendar()
        rev = calendar_rev(cal)
        t_cal = cal_yte(ex_ms, snapped_ms)
        t_wkg = vol_yte(ex_ms, snapped_ms, cal)
        if t_cal <= 0 and t_wkg <= 0:
            return result

        # Historic fits ride a synthetic ChainSnapshot whose marks are the
        # snapped per-strike samples, so the calibrator's `fit(ctx)` walks
        # the same code path as the live case. Snapshot-keyed caching does
        # NOT apply here (M3.9 owns the bucketed historic cache).
        synth_marks: dict[str, OptionMark] = {}
        for k, v in zip(strikes, ivs):
            # Synthetic instrument name only needs to round-trip through
            # parse_expiry / parse_strike; option type is fixed since marks
            # are already parity-collapsed in `pairs`.
            synth_name = f"{currency}-{expiry}-{k:g}-C"
            synth_marks[synth_name] = OptionMark(
                instrument_name=synth_name,
                mark_iv=float(v),
                mark_price=0.0,
                underlying_price=forward,
                timestamp_ms=snapped_ms,
            )
        synth_snap = ChainSnapshot(
            currency=currency, timestamp_ms=snapped_ms, marks=synth_marks,
        )

        calibrator = get_calibrator(methodology)
        if calibrator is None:
            return result
        # `requires_ts` methodologies need a TS curve at the same snapped
        # timestamp as the smile. `term_structure_bucket_fit` already
        # replays the chain at any ts (cached by `(currency, method, ts,
        # rev)`) — reuse it so the historic α prior comes from the same
        # moment in time as the historic smile data, not the live chain.
        ts_snapshot: TermStructureSnapshot | None = None
        if calibrator.requires_ts:
            if not ts_method:
                return result
            ts_snapshot = await self.term_structure_bucket_fit(
                currency, ts_method, snapped_ms,
            )
            if ts_snapshot is None:
                return result
        ctx = FitContext(
            currency=currency,
            expiry=expiry,
            snapshot=synth_snap,
            t_years_cal=t_cal,
            t_years_wkg=t_wkg,
            calendar_rev=rev,
            ts_snapshot=ts_snapshot,
            history_store=self.history,
        )
        result.fit = await asyncio.to_thread(calibrator.fit, ctx)
        result.market_points = list(zip(strikes, ivs))
        result.snapped_ms = snapped_ms
        result.forward = forward
        return result

    async def historic_term_structure_fit(
        self,
        currency: str,
        method: str,
        as_of_ms: int,
    ) -> tuple[TermStructureSnapshot | None, int | None, int | None, int | None]:
        """One-shot TS rebuild from each instrument's `mark_iv` history at
        `as_of_ms`. Mirrors `historic_smile_fit`'s synthetic-snapshot
        approach: snap each instrument to its closest sample, build a
        synthetic ChainSnapshot, route through the requested builder.

        Returns `(snapshot, snapped_ms, earliest_ms, latest_ms)`. The
        timestamps describe the actual data window the caller's `as_of_ms`
        snapped into.
        """
        snap = self._snapshots.get(currency)
        if not snap:
            return None, None, None, None
        builder = get_curve_builder(method)
        if builder is None:
            return None, None, None, None

        # Walk every option in the latest snapshot, snap its mark_iv to
        # the closest sample to as_of_ms, also snap underlying_price.
        synth_marks: dict[str, OptionMark] = {}
        snapped_ms: int | None = None
        earliest_ms: int | None = None
        latest_ms: int | None = None
        for name, mark in snap.marks.items():
            samples = self.history.series(name, "mark_iv")
            if not samples:
                continue
            if earliest_ms is None or samples[0].ts_ms < earliest_ms:
                earliest_ms = samples[0].ts_ms
            if latest_ms is None or samples[-1].ts_ms > latest_ms:
                latest_ms = samples[-1].ts_ms
            best_iv = min(samples, key=lambda s: abs(s.ts_ms - as_of_ms))
            if snapped_ms is None or abs(best_iv.ts_ms - as_of_ms) < abs(snapped_ms - as_of_ms):
                snapped_ms = best_iv.ts_ms
            # Forward at the snapped timestamp from the option-implied series.
            inst_expiry = parse_expiry(name)
            if inst_expiry is None:
                continue
            fwd = self._forward_at(currency, inst_expiry, best_iv.ts_ms) or mark.underlying_price
            if fwd <= 0:
                continue
            synth_marks[name] = OptionMark(
                instrument_name=name,
                mark_iv=float(best_iv.value),
                mark_price=0.0,
                underlying_price=float(fwd),
                timestamp_ms=best_iv.ts_ms,
            )

        if snapped_ms is None or not synth_marks:
            return None, snapped_ms, earliest_ms, latest_ms

        synth_snap = ChainSnapshot(
            currency=currency, timestamp_ms=snapped_ms, marks=synth_marks,
        )
        cal = get_active_calendar()
        rev = calendar_rev(cal)

        t_cal_by_expiry: dict[str, float] = {}
        t_wkg_by_expiry: dict[str, float] = {}
        for ex in synth_snap.expiries():
            ex_ms = expiry_ms(ex)
            if ex_ms is None:
                continue
            t_cal = cal_yte(ex_ms, snapped_ms)
            t_wkg = vol_yte(ex_ms, snapped_ms, cal)
            if t_cal <= 0 or t_wkg <= 0:
                continue
            t_cal_by_expiry[ex] = t_cal
            t_wkg_by_expiry[ex] = t_wkg

        ctx = BuildContext(
            currency=currency,
            snapshot=synth_snap,
            t_years_cal_by_expiry=t_cal_by_expiry,
            t_years_wkg_by_expiry=t_wkg_by_expiry,
            calendar_rev=rev,
        )
        built = await asyncio.to_thread(builder.build, ctx)
        return built, snapped_ms, earliest_ms, latest_ms

    def _forward_at(self, currency: str, expiry: str, ts_ms: int) -> float | None:
        fwd_samples = self.history.aggregate(currency, f"forward_opt:{expiry}")
        if fwd_samples:
            best = min(fwd_samples, key=lambda s: abs(s.ts_ms - ts_ms))
            if best.value > 0:
                return best.value
        snap = self._snapshots.get(currency)
        if snap:
            for mark in snap.marks.values():
                if parse_expiry(mark.instrument_name) == expiry and mark.underlying_price > 0:
                    return mark.underlying_price
        return None

    # ---------- M3.9 bucketed historic fits ----------

    def _replay_chain_at(
        self,
        currency: str,
        as_of_ms: int,
        expiry_filter: str | None = None,
    ) -> ChainSnapshot | None:
        """Replay `HistoryStore` at `as_of_ms`: snap each option's mark_iv
        and underlying_price to its closest sample, return a synthetic
        `ChainSnapshot` whose marks reflect the chain at that moment.

        Used by the bucket fit machinery; does not touch the legacy
        `historic_smile_fit` / `historic_term_structure_fit` paths so
        their byte-identical behavior is preserved (the M3.9d invalidation
        story leans on this — old historic envelopes shouldn't change
        shape just because buckets started using a shared helper).

        Returns None if there are no samples to snap to (cold cache, or
        the as_of is outside the 24h window for every instrument).
        """
        snap = self._snapshots.get(currency)
        if not snap:
            return None
        synth_marks: dict[str, OptionMark] = {}
        for name in snap.marks:
            inst_expiry = parse_expiry(name)
            if expiry_filter and inst_expiry != expiry_filter:
                continue
            if inst_expiry is None:
                continue
            samples = self.history.series(name, "mark_iv")
            if not samples:
                continue
            best = min(samples, key=lambda s: abs(s.ts_ms - as_of_ms))
            fwd = self._forward_at(currency, inst_expiry, best.ts_ms)
            if fwd is None or fwd <= 0:
                continue
            synth_marks[name] = OptionMark(
                instrument_name=name,
                mark_iv=float(best.value),
                mark_price=0.0,
                underlying_price=float(fwd),
                timestamp_ms=best.ts_ms,
            )
        if not synth_marks:
            return None
        return ChainSnapshot(
            currency=currency,
            timestamp_ms=as_of_ms,
            marks=synth_marks,
        )

    async def smile_bucket_fit(
        self,
        currency: str,
        expiry: str,
        methodology: str,
        ts_method: str | None,
        bucket_ts: int,
    ) -> FitResult | None:
        """Cached historic SABR fit at bucket boundary `bucket_ts`.

        Cache key includes `calendar_rev` so a recalibrate naturally drops
        wkg-basis entries on next access; cal-basis entries don't depend on
        rev but the field rides on the key uniformly (no false collisions
        possible since the rev string is identical for all cal entries
        computed under the same calendar).

        For `requires_ts` calibrators, recursively asks `term_structure_bucket_fit`
        for the curve at the same bucket boundary — so the historic fit and
        its TS prior land in the same point in time. Calibrator math runs
        via `asyncio.to_thread`; in-flight Future dedups concurrent callers
        on the same key.
        """
        ex_ms = expiry_ms(expiry)
        if ex_ms is None:
            return None
        cal = get_active_calendar()
        rev = calendar_rev(cal)
        resolved = resolve_alias(methodology)
        calibrator = get_calibrator(resolved)
        if calibrator is None:
            return None
        if calibrator.requires_ts and not ts_method:
            return None

        key: SmileBucketKey = (currency, expiry, resolved, ts_method, bucket_ts, rev)
        if key in self._smile_bucket_cache:
            return self._smile_bucket_cache[key]
        in_flight = self._smile_bucket_inflight.get(key)
        if in_flight is not None:
            return await in_flight

        synth = self._replay_chain_at(currency, bucket_ts, expiry_filter=expiry)
        if synth is None:
            self._smile_bucket_cache[key] = None
            return None

        # t_years anchored at the bucket boundary, not `now`, so historic
        # buckets see the same time-to-expiry the calibrator would have
        # consumed at that moment.
        t_cal = cal_yte(ex_ms, bucket_ts)
        t_wkg = vol_yte(ex_ms, bucket_ts, cal)
        if t_cal <= 0 and t_wkg <= 0:
            self._smile_bucket_cache[key] = None
            return None

        # Register the in-flight Future BEFORE the term_structure_bucket_fit /
        # to_thread awaits so concurrent callers see the dedup slot.
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._smile_bucket_inflight[key] = future
        try:
            ts_snapshot: TermStructureSnapshot | None = None
            if calibrator.requires_ts and ts_method:
                ts_snapshot = await self.term_structure_bucket_fit(currency, ts_method, bucket_ts)

            ctx = FitContext(
                currency=currency,
                expiry=expiry,
                snapshot=synth,
                t_years_cal=t_cal,
                t_years_wkg=t_wkg,
                calendar_rev=rev,
                ts_snapshot=ts_snapshot,
                history_store=self.history,
            )
            result = await asyncio.to_thread(calibrator.fit, ctx)
        except asyncio.CancelledError:
            if not future.done():
                future.cancel()
            self._smile_bucket_inflight.pop(key, None)
            raise
        except BaseException as exc:
            if not future.done():
                future.set_exception(exc)
            self._smile_bucket_inflight.pop(key, None)
            raise
        evict_old_smile_buckets(self._smile_bucket_cache, _now_ms())
        self._smile_bucket_cache[key] = result
        future.set_result(result)
        self._smile_bucket_inflight.pop(key, None)
        return result

    async def term_structure_bucket_fit(
        self,
        currency: str,
        method: str,
        bucket_ts: int,
    ) -> TermStructureSnapshot | None:
        """Cached historic curve build at bucket boundary `bucket_ts`."""
        builder = get_curve_builder(method)
        if builder is None:
            return None
        cal = get_active_calendar()
        rev = calendar_rev(cal)
        key: TsBucketKey = (currency, method, bucket_ts, rev)
        if key in self._ts_bucket_cache:
            return self._ts_bucket_cache[key]
        in_flight = self._ts_bucket_inflight.get(key)
        if in_flight is not None:
            return await in_flight

        synth = self._replay_chain_at(currency, bucket_ts)
        if synth is None:
            self._ts_bucket_cache[key] = None
            return None

        t_cal_by_expiry: dict[str, float] = {}
        t_wkg_by_expiry: dict[str, float] = {}
        for ex in synth.expiries():
            ex_ms = expiry_ms(ex)
            if ex_ms is None:
                continue
            t_cal = cal_yte(ex_ms, bucket_ts)
            t_wkg = vol_yte(ex_ms, bucket_ts, cal)
            if t_cal <= 0 or t_wkg <= 0:
                continue
            t_cal_by_expiry[ex] = t_cal
            t_wkg_by_expiry[ex] = t_wkg

        ctx = BuildContext(
            currency=currency,
            snapshot=synth,
            t_years_cal_by_expiry=t_cal_by_expiry,
            t_years_wkg_by_expiry=t_wkg_by_expiry,
            calendar_rev=rev,
        )
        future: asyncio.Future = asyncio.get_running_loop().create_future()
        self._ts_bucket_inflight[key] = future
        try:
            result = await asyncio.to_thread(builder.build, ctx)
        except asyncio.CancelledError:
            if not future.done():
                future.cancel()
            self._ts_bucket_inflight.pop(key, None)
            raise
        except BaseException as exc:
            if not future.done():
                future.set_exception(exc)
            self._ts_bucket_inflight.pop(key, None)
            raise
        evict_old_ts_buckets(self._ts_bucket_cache, _now_ms())
        self._ts_bucket_cache[key] = result
        future.set_result(result)
        self._ts_bucket_inflight.pop(key, None)
        return result

    async def smile_buckets(
        self,
        currency: str,
        expiry: str,
        methodology: str,
        ts_method: str | None,
        lookback_ms: int,
        now_ms: int | None = None,
    ) -> list[tuple[int, FitResult | None]]:
        """Hourly-bucket smile fits across the trailing `lookback_ms`.

        Returns ascending-by-time list of (bucket_ts, fit) tuples. Misses
        hit `smile_bucket_fit` (caches first-touch, evicts >24h). The
        most-recent entry is the in-progress current hour and updates on
        subsequent chain polls within that hour.
        """
        if now_ms is None:
            now_ms = _now_ms()
        out: list[tuple[int, FitResult | None]] = []
        for bucket_ts in bucket_boundaries(now_ms, lookback_ms):
            fit = await self.smile_bucket_fit(
                currency, expiry, methodology, ts_method, bucket_ts,
            )
            out.append((bucket_ts, fit))
        return out

    async def term_structure_buckets(
        self,
        currency: str,
        method: str,
        lookback_ms: int,
        now_ms: int | None = None,
    ) -> list[tuple[int, TermStructureSnapshot | None]]:
        """Hourly-bucket TS snapshots across the trailing `lookback_ms`."""
        if now_ms is None:
            now_ms = _now_ms()
        out: list[tuple[int, TermStructureSnapshot | None]] = []
        for bucket_ts in bucket_boundaries(now_ms, lookback_ms):
            ts = await self.term_structure_bucket_fit(currency, method, bucket_ts)
            out.append((bucket_ts, ts))
        return out

    def latest_bucket_floor(self) -> int:
        """Wall-clock-floor of `now` in ms — used by the WS pump to detect
        when a new hour boundary has crossed since the last chain poll."""
        return bucket_floor(_now_ms())

    def recalibrate_wkg_caches(self, current_rev: str) -> int:
        """Drop every wkg-basis cache entry whose `calendar_rev` is stale.

        Cal-basis entries don't depend on `calendar_rev` so they're skipped.
        Returns the count of entries dropped — they'll be lazily recomputed
        on next access (live pumps detect the rev change on their next chain
        poll and re-emit a fresh snapshot, so subscribers don't lose state).
        """
        n = 0

        def _wkg_calibrator(methodology: str) -> bool:
            cal = get_calibrator(methodology)
            return cal is not None and cal.time_basis == "wkg"

        def _wkg_builder(method: str) -> bool:
            b = get_curve_builder(method)
            return b is not None and b.time_basis == "wkg"

        # _fit_cache: (currency, expiry, methodology, ts_method, snapshot_ts, rev)
        stale_fits = [
            k for k in self._fit_cache
            if _wkg_calibrator(k[2]) and k[5] != current_rev
        ]
        for k in stale_fits:
            del self._fit_cache[k]
            n += 1

        # _ts_cache: (currency, ts_method, snapshot_ts, rev)
        stale_ts = [
            k for k in self._ts_cache
            if _wkg_builder(k[1]) and k[3] != current_rev
        ]
        for k in stale_ts:
            del self._ts_cache[k]
            n += 1

        # _smile_bucket_cache: (currency, expiry, methodology, ts_method, bucket_ts, rev)
        stale_smile_buckets = [
            k for k in self._smile_bucket_cache
            if _wkg_calibrator(k[2]) and k[5] != current_rev
        ]
        for k in stale_smile_buckets:
            del self._smile_bucket_cache[k]
            n += 1

        # _ts_bucket_cache: (currency, ts_method, bucket_ts, rev)
        stale_ts_buckets = [
            k for k in self._ts_bucket_cache
            if _wkg_builder(k[1]) and k[3] != current_rev
        ]
        for k in stale_ts_buckets:
            del self._ts_bucket_cache[k]
            n += 1

        return n

    async def ping_deribit(self) -> dict:
        """Round-trip ping that hits Deribit — for end-to-end pingService test."""
        t0 = time.time() * 1000
        server_time = await self._rest.get_time()
        return {
            "client_ts_ms": int(t0),
            "deribit_ts_ms": int(server_time),
            "rtt_ms": int(time.time() * 1000 - t0),
        }

    @property
    def rate_limit_status(self) -> RateLimitStatus:
        return self._rest.rate_limit_status


def _now_ms() -> int:
    return int(time.time() * 1000)
