import asyncio
import dataclasses
import json
import logging
from contextlib import asynccontextmanager
from typing import Callable

import truststore
truststore.inject_into_ssl()

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware

from backend.calibration import FitResult, get_calibrator, list_methodologies
from backend.chain import ChainRow
from backend.curves import TermStructureSnapshot, get_curve_builder, list_curve_methods
from backend.history import HistoryStore, Sample, TradePrint
from backend.venues.deribit.adapter import DeribitAdapter
from backend.venues import registry
from backend import vol_time

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    adapter = DeribitAdapter()
    registry.register("deribit", adapter)
    await adapter.start()
    yield
    await adapter.stop()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------- HTTP ----------


@app.get("/api/rate-limit-status")
async def rate_limit_status():
    adapter = registry.get("deribit")
    return dataclasses.asdict(adapter.rate_limit_status)


# ---------- vol-time calendar (M3.6) ----------


@app.get("/api/calendar")
async def get_calendar():
    """Return the active vol-time calendar plus its revision hash."""
    cal = vol_time.get_active_calendar()
    return {
        **vol_time.calendar_to_dict(cal),
        "rev": vol_time.calendar_rev(cal),
    }


@app.post("/api/calendar")
async def put_calendar(payload: dict):
    """Replace the active calendar. Does NOT trigger refits — that's
    `recalibrate`'s job (separate button) so the user can stage edits
    without burning compute on every keystroke.
    """
    try:
        cal = vol_time.calendar_from_dict(payload)
    except (ValueError, TypeError, KeyError) as exc:
        raise HTTPException(status_code=400, detail=f"invalid calendar payload: {exc}")
    vol_time.set_active_calendar(cal)
    return {
        **vol_time.calendar_to_dict(cal),
        "rev": vol_time.calendar_rev(cal),
    }


@app.get("/api/methodologies")
async def get_methodologies():
    """Catalog of registered smile-calibration methodologies (M3.7).

    One-shot — the catalog is build-time-constant. Frontend fetches once at
    oracle boot via `worker/methodologyService.ts` and refcount-shares
    across all tabs.
    """
    return {"methodologies": [dataclasses.asdict(m) for m in list_methodologies()]}


@app.get("/api/term-structure/methods")
async def get_term_structure_methods():
    """Catalog of registered curve-builder methods (M3.8).

    One-shot, mirrors `/api/methodologies`. The TermStructureChart's method
    dropdown reads from this; the SmileChart's TS dropdown also filters by
    this catalog (gated on the selected smile methodology's `requires_ts`).
    """
    return {"methods": [dataclasses.asdict(m) for m in list_curve_methods()]}


@app.get("/api/term-structure/historic")
async def term_structure_historic(currency: str, method: str, as_of_ms: int):
    """One-shot historic term-structure rebuild from `mark_iv` history at
    `as_of_ms`. Frozen-overlay path for `TermStructureChart`."""
    adapter: DeribitAdapter = registry.get("deribit")
    snap, snapped_ms, earliest_ms, latest_ms = await adapter.historic_term_structure_fit(
        currency, method, as_of_ms,
    )
    return {
        "currency": currency,
        "method": method,
        "as_of_ms": as_of_ms,
        "snapped_ms": snapped_ms,
        "earliest_ms": earliest_ms,
        "latest_ms": latest_ms,
        "calendar_rev": vol_time.calendar_rev(vol_time.get_active_calendar()),
        "snapshot": _ts_dict(snap) if snap else None,
    }


@app.post("/api/calendar/recalibrate")
async def recalibrate_calendar():
    """Drop every wkg-basis cached entry whose `calendar_rev` is stale.

    Walks the per-snapshot fit/TS caches AND the M3.9 bucketed caches.
    Cal-basis entries are skipped (their key doesn't depend on rev).
    Dropped entries are recomputed lazily on next access — live bucket
    pumps detect the rev change on their next chain poll and re-emit a
    fresh `*_buckets_snapshot` so subscribers redraw without remount.
    """
    adapter: DeribitAdapter = registry.get("deribit")
    cal = vol_time.get_active_calendar()
    rev = vol_time.calendar_rev(cal)
    n = adapter.recalibrate_wkg_caches(rev)
    return {"rev": rev, "recalibrated": n}


@app.get("/api/history/change")
async def history_change(instrument: str, field: str, lookback_ms: int = Query(..., gt=0)):
    store = _store()
    return {"value": store.change(instrument, field, lookback_ms)}


@app.get("/api/history/session-open")
async def history_session_open(instrument: str, field: str, session_start_ms: int):
    store = _store()
    return {"value": store.session_open(instrument, field, session_start_ms)}


@app.get("/api/history/range")
async def history_range(instrument: str, field: str, t0_ms: int, t1_ms: int):
    if t1_ms < t0_ms:
        raise HTTPException(status_code=400, detail="t1_ms must be >= t0_ms")
    store = _store()
    return {"samples": [_sample_dict(s) for s in store.range(instrument, field, t0_ms, t1_ms)]}


@app.get("/api/chain/expiries")
async def chain_expiries(currency: str):
    adapter: DeribitAdapter = registry.get("deribit")
    return {"currency": currency, "expiries": adapter.expiries(currency)}


@app.get("/api/smile/historic")
async def smile_historic(
    currency: str,
    expiry: str,
    as_of_ms: int,
    methodology: str = "sabr-naive",
    term_structure: str | None = None,
):
    """One-shot historic SABR fit. Replays mark_iv from each instrument's
    HistoryStore series, snaps to the closest sample to `as_of_ms` (clamping
    to the 24h buffer boundary), fits under the chosen methodology, returns
    the frozen curve. The frontend calls this once per as-of change.
    """
    adapter: DeribitAdapter = registry.get("deribit")
    res = await adapter.historic_smile_fit(
        currency, expiry, as_of_ms,
        methodology=methodology, ts_method=term_structure,
    )
    return {
        "currency": currency,
        "expiry": expiry,
        "as_of_ms": as_of_ms,
        "snapped_ms": res.snapped_ms,
        "earliest_ms": res.earliest_ms,
        "latest_ms": res.latest_ms,
        "forward": res.forward,
        "calendar_rev": vol_time.calendar_rev(vol_time.get_active_calendar()),
        "fit": _fit_dict(res.fit) if res.fit else None,
        "market_points": [{"strike": k, "iv": v} for k, v in res.market_points],
    }


def _store() -> HistoryStore:
    adapter: DeribitAdapter = registry.get("deribit")
    return adapter.history


def _sample_dict(s: Sample) -> dict:
    return {"ts_ms": s.ts_ms, "value": s.value}


def _trade_dict(t: TradePrint) -> dict:
    return {
        "instrument_name": t.instrument_name,
        "ts_ms": t.ts_ms,
        "price": t.price,
        "iv": t.iv,
        "direction": t.direction,
        "amount": t.amount,
        "trade_id": t.trade_id,
    }


# ---------- WS oracle endpoint ----------


@app.websocket("/ws/oracle")
async def oracle_ws(websocket: WebSocket):
    await websocket.accept()
    log.info("oracle client connected")

    adapter: DeribitAdapter = registry.get("deribit")

    status_task = asyncio.create_task(_stream_rate_limit(websocket, adapter))
    backfill_task = asyncio.create_task(_stream_backfill_progress(websocket, adapter))

    # conversationId -> cancel function (cancels the pump task and unsubscribes)
    subs: dict[str, Callable[[], None]] = {}

    try:
        while True:
            raw = await websocket.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue

            mtype = msg.get("type")

            if mtype == "ping":
                await _handle_ping(websocket, adapter, msg)

            elif mtype == "subscribe_history":
                conv = str(msg.get("conversationId") or "")
                if conv:
                    subs[conv] = await _subscribe_history(websocket, adapter, msg, conv)

            elif mtype == "subscribe_aggregate":
                conv = str(msg.get("conversationId") or "")
                if conv:
                    subs[conv] = await _subscribe_aggregate(websocket, adapter, msg, conv)

            elif mtype == "subscribe_trades":
                conv = str(msg.get("conversationId") or "")
                if conv:
                    subs[conv] = await _subscribe_trades(websocket, adapter, msg, conv)

            elif mtype == "subscribe_chain":
                conv = str(msg.get("conversationId") or "")
                if conv:
                    subs[conv] = await _subscribe_chain(websocket, adapter, msg, conv)

            elif mtype == "subscribe_smile":
                conv = str(msg.get("conversationId") or "")
                if conv:
                    subs[conv] = await _subscribe_smile(websocket, adapter, msg, conv)

            elif mtype == "subscribe_termstructure":
                conv = str(msg.get("conversationId") or "")
                if conv:
                    subs[conv] = await _subscribe_termstructure(websocket, adapter, msg, conv)

            elif mtype == "subscribe_smile_buckets":
                conv = str(msg.get("conversationId") or "")
                if conv:
                    subs[conv] = await _subscribe_smile_buckets(websocket, adapter, msg, conv)

            elif mtype == "subscribe_termstructure_buckets":
                conv = str(msg.get("conversationId") or "")
                if conv:
                    subs[conv] = await _subscribe_termstructure_buckets(websocket, adapter, msg, conv)

            elif mtype == "unsubscribe":
                conv = str(msg.get("conversationId") or "")
                cancel = subs.pop(conv, None)
                if cancel:
                    cancel()

    except WebSocketDisconnect:
        log.info("oracle client disconnected")
    except Exception as exc:
        log.warning("oracle ws error: %s", exc)
    finally:
        for cancel in subs.values():
            cancel()
        status_task.cancel()
        backfill_task.cancel()


# ---------- WS handlers ----------


async def _handle_ping(ws: WebSocket, adapter: DeribitAdapter, msg: dict) -> None:
    req_id = msg.get("id")
    try:
        pong = await adapter.ping_deribit()
        await ws.send_text(json.dumps({"type": "pong", "id": req_id, "data": pong}))
    except Exception as exc:
        await ws.send_text(json.dumps({"type": "pong", "id": req_id, "error": str(exc)}))


async def _subscribe_history(
    ws: WebSocket, adapter: DeribitAdapter, msg: dict, conversation_id: str,
) -> Callable[[], None]:
    instrument = str(msg.get("instrument") or "")
    field = str(msg.get("field") or "")
    if not instrument or not field:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": "subscribe_history requires instrument and field",
        }))
        return lambda: None

    store = adapter.history

    # Snapshot first.
    samples = store.series(instrument, field)
    await ws.send_text(json.dumps({
        "type": "history_snapshot",
        "conversationId": conversation_id,
        "data": {
            "instrument": instrument,
            "field": field,
            "samples": [_sample_dict(s) for s in samples],
        },
    }))

    # Live appends — bridge the sync listener to async send via a bounded queue.
    queue: asyncio.Queue[Sample] = asyncio.Queue(maxsize=1000)

    def listener(s: Sample) -> None:
        try:
            queue.put_nowait(s)
        except asyncio.QueueFull:
            pass  # backpressure: drop on overflow rather than block the writer

    unsub = store.subscribe_series(instrument, field, listener)

    async def pump() -> None:
        try:
            while True:
                s = await queue.get()
                await ws.send_text(json.dumps({
                    "type": "history_append",
                    "conversationId": conversation_id,
                    "data": _sample_dict(s),
                }))
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass

    task = asyncio.create_task(pump())

    def cancel() -> None:
        unsub()
        task.cancel()

    return cancel


async def _subscribe_aggregate(
    ws: WebSocket, adapter: DeribitAdapter, msg: dict, conversation_id: str,
) -> Callable[[], None]:
    currency = str(msg.get("currency") or "")
    field = str(msg.get("field") or "")
    if not currency or not field:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": "subscribe_aggregate requires currency and field",
        }))
        return lambda: None

    store = adapter.history

    samples = store.aggregate(currency, field)
    await ws.send_text(json.dumps({
        "type": "aggregate_snapshot",
        "conversationId": conversation_id,
        "data": {
            "currency": currency,
            "field": field,
            "samples": [_sample_dict(s) for s in samples],
        },
    }))

    queue: asyncio.Queue[Sample] = asyncio.Queue(maxsize=1000)

    def listener(s: Sample) -> None:
        try:
            queue.put_nowait(s)
        except asyncio.QueueFull:
            pass

    unsub = store.subscribe_aggregate(currency, field, listener)

    async def pump() -> None:
        try:
            while True:
                s = await queue.get()
                await ws.send_text(json.dumps({
                    "type": "aggregate_append",
                    "conversationId": conversation_id,
                    "data": _sample_dict(s),
                }))
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass

    task = asyncio.create_task(pump())

    def cancel() -> None:
        unsub()
        task.cancel()

    return cancel


async def _subscribe_trades(
    ws: WebSocket, adapter: DeribitAdapter, msg: dict, conversation_id: str,
) -> Callable[[], None]:
    instrument = str(msg.get("instrument") or "")
    if not instrument:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": "subscribe_trades requires instrument",
        }))
        return lambda: None

    store = adapter.history

    trades = store.trades(instrument)
    await ws.send_text(json.dumps({
        "type": "trades_snapshot",
        "conversationId": conversation_id,
        "data": {"instrument": instrument, "trades": [_trade_dict(t) for t in trades]},
    }))

    queue: asyncio.Queue[TradePrint] = asyncio.Queue(maxsize=1000)

    def listener(t: TradePrint) -> None:
        try:
            queue.put_nowait(t)
        except asyncio.QueueFull:
            pass

    unsub = store.subscribe_trades(instrument, listener)

    async def pump() -> None:
        try:
            while True:
                t = await queue.get()
                await ws.send_text(json.dumps({
                    "type": "trade_append",
                    "conversationId": conversation_id,
                    "data": _trade_dict(t),
                }))
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass

    task = asyncio.create_task(pump())

    def cancel() -> None:
        unsub()
        task.cancel()

    return cancel


# ---------- chain & smile conversations + serializers ----------


def _row_dict(r: ChainRow) -> dict:
    return {
        "instrument_name": r.instrument_name,
        "expiry": r.expiry,
        "strike": r.strike,
        "option_type": r.option_type,
        "mark_iv": r.mark_iv,
        "bid_iv": r.bid_iv,
        "ask_iv": r.ask_iv,
        "mark_price": r.mark_price,
        "bid_price": r.bid_price,
        "ask_price": r.ask_price,
        "mid_price": r.mid_price,
        "spread": r.spread,
        "open_interest": r.open_interest,
        "volume_24h": r.volume_24h,
        "underlying_price": r.underlying_price,
        "change_1h": r.change_1h,
        "change_24h": r.change_24h,
        "change_iv_1h": r.change_iv_1h,
        "timestamp_ms": r.timestamp_ms,
    }


def _ts_dict(ts: TermStructureSnapshot) -> dict:
    """Wire format for TermStructureSnapshot (M3.8). Plain data only —
    sampled grids + params, no callables (HRT principle 4). The frontend's
    `TermStructureChart` reconstructs whatever curve it needs from these.
    """
    return {
        "method": ts.method,
        "currency": ts.currency,
        "time_basis": ts.time_basis,
        "t_years_cal_grid": list(ts.t_years_cal_grid),
        "t_years_wkg_grid": list(ts.t_years_wkg_grid),
        "atm_vol_grid": list(ts.atm_vol_grid),
        "alpha_grid": list(ts.alpha_grid),
        "fwd_var_grid": list(ts.fwd_var_grid),
        "params": dict(ts.params),
        "rmse": ts.rmse,
        "calendar_rev": ts.calendar_rev,
        "market_t_cal": list(ts.market_t_cal),
        "market_t_wkg": list(ts.market_t_wkg),
        "market_atm_vol": list(ts.market_atm_vol),
        "market_expiries": list(ts.market_expiries),
        "market_fwd_var": list(ts.market_fwd_var),
        "market_fwd_var_t_cal": list(ts.market_fwd_var_t_cal),
        "market_fwd_var_t_wkg": list(ts.market_fwd_var_t_wkg),
    }


def _fit_dict(fit: FitResult) -> dict:
    """Wire format for FitResult (M3.7 tagged-union).

    `params` is the per-kind bag (SABR: alpha/rho/volvol/beta). The frontend's
    `frontend/src/calibration/<kind>.ts` evaluator reconstructs the smile
    from these. `calendar_rev` rides on the envelope as well (see
    `_subscribe_smile`) so a recalibrate is legible without opening the fit.
    """
    return {
        "kind": fit.kind,
        "methodology": fit.methodology,
        "params": dict(fit.params),
        "forward": fit.forward,
        "t_years": fit.t_years,
        "t_years_cal": fit.t_years_cal,
        "t_years_wkg": fit.t_years_wkg,
        "calendar_rev": fit.calendar_rev,
        "strikes": fit.strikes,
        "fitted_iv": fit.fitted_iv,
        "market_strikes": fit.market_strikes,
        "market_iv": fit.market_iv,
        "weights_used": fit.weights_used,
        "residual_rms": fit.residual_rms,
        "weighted_residual_rms": fit.weighted_residual_rms,
        "frozen": list(fit.frozen),
    }


async def _subscribe_chain(
    ws: WebSocket, adapter: DeribitAdapter, msg: dict, conversation_id: str,
) -> Callable[[], None]:
    currency = str(msg.get("currency") or "")
    expiry = msg.get("expiry") or None
    if not currency:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": "subscribe_chain requires currency",
        }))
        return lambda: None

    async def pump() -> None:
        try:
            async for snap in adapter.chain_stream(currency):
                rows = adapter.chain_rows(currency, expiry)
                await ws.send_text(json.dumps({
                    "type": "chain_snapshot",
                    "conversationId": conversation_id,
                    "data": {
                        "currency": snap.currency,
                        "expiry": expiry,
                        "timestamp_ms": snap.timestamp_ms,
                        "rows": [_row_dict(r) for r in rows],
                        "expiries": snap.expiries(),
                    },
                }))
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
        except Exception as exc:
            log.warning("chain pump error: %s", exc)

    task = asyncio.create_task(pump())
    return lambda: task.cancel()


async def _subscribe_smile(
    ws: WebSocket, adapter: DeribitAdapter, msg: dict, conversation_id: str,
) -> Callable[[], None]:
    currency = str(msg.get("currency") or "")
    expiry = str(msg.get("expiry") or "")
    methodology = str(msg.get("methodology") or "sabr-naive")
    raw_ts = msg.get("termStructure")
    ts_method: str | None = str(raw_ts) if raw_ts else None
    if not currency or not expiry:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": "subscribe_smile requires currency and expiry",
        }))
        return lambda: None

    # Validate methodology + ts pairing up front so a typo fails loudly
    # rather than silently emitting None forever.
    calibrator = get_calibrator(methodology)
    if calibrator is None:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": f"unknown methodology: {methodology}",
        }))
        return lambda: None
    if calibrator.requires_ts and not ts_method:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": f"methodology {methodology} requires termStructure",
        }))
        return lambda: None

    async def pump() -> None:
        try:
            async for snap in adapter.chain_stream(currency):
                fit = await adapter.smile_fit(currency, expiry, methodology, ts_method)
                payload = {
                    "currency": currency,
                    "expiry": expiry,
                    "methodology": methodology,
                    "termStructure": ts_method,
                    "timestamp_ms": snap.timestamp_ms,
                    "calendar_rev": vol_time.calendar_rev(vol_time.get_active_calendar()),
                    "fit": _fit_dict(fit) if fit else None,
                }
                await ws.send_text(json.dumps({
                    "type": "smile_snapshot",
                    "conversationId": conversation_id,
                    "data": payload,
                }))
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
        except Exception as exc:
            log.warning("smile pump error: %s", exc)

    task = asyncio.create_task(pump())
    return lambda: task.cancel()


async def _subscribe_termstructure(
    ws: WebSocket, adapter: DeribitAdapter, msg: dict, conversation_id: str,
) -> Callable[[], None]:
    currency = str(msg.get("currency") or "")
    method = str(msg.get("method") or "")
    if not currency or not method:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": "subscribe_termstructure requires currency and method",
        }))
        return lambda: None
    if get_curve_builder(method) is None:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": f"unknown term-structure method: {method}",
        }))
        return lambda: None

    async def pump() -> None:
        try:
            async for snap in adapter.chain_stream(currency):
                ts = await adapter.term_structure_fit(currency, method)
                payload = {
                    "currency": currency,
                    "method": method,
                    "timestamp_ms": snap.timestamp_ms,
                    "calendar_rev": vol_time.calendar_rev(vol_time.get_active_calendar()),
                    "snapshot": _ts_dict(ts) if ts else None,
                }
                await ws.send_text(json.dumps({
                    "type": "termstructure_snapshot",
                    "conversationId": conversation_id,
                    "data": payload,
                }))
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
        except Exception as exc:
            log.warning("termstructure pump error: %s", exc)

    task = asyncio.create_task(pump())
    return lambda: task.cancel()


# ---------- M3.9 bucketed historic-fit conversations ----------


async def _subscribe_smile_buckets(
    ws: WebSocket, adapter: DeribitAdapter, msg: dict, conversation_id: str,
) -> Callable[[], None]:
    """Hourly-bucket smile fits across `lookback_ms`. Emits a snapshot at
    open, then a `smile_bucket_append` on every chain poll (re-fits the
    in-progress head bucket and tags `is_new_bucket=True` on the first poll
    past an hour boundary). On calendar-rev change, wkg-basis subscriptions
    re-emit a fresh `smile_buckets_snapshot` under the new rev (M3.9d) so
    the consumer redraws without remount; cal-basis subscriptions don't
    depend on rev and skip the re-emit."""
    currency = str(msg.get("currency") or "")
    expiry = str(msg.get("expiry") or "")
    methodology = str(msg.get("methodology") or "sabr-naive")
    raw_ts = msg.get("termStructure")
    ts_method: str | None = str(raw_ts) if raw_ts else None
    try:
        lookback_ms = int(msg.get("lookbackMs") or 0)
    except (TypeError, ValueError):
        lookback_ms = 0
    if not currency or not expiry or lookback_ms <= 0:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": "subscribe_smile_buckets requires currency, expiry, lookbackMs>0",
        }))
        return lambda: None

    calibrator = get_calibrator(methodology)
    if calibrator is None:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": f"unknown methodology: {methodology}",
        }))
        return lambda: None
    if calibrator.requires_ts and not ts_method:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": f"methodology {methodology} requires termStructure",
        }))
        return lambda: None

    is_wkg = calibrator.time_basis == "wkg"

    async def pump() -> None:
        last_seen_floor: int | None = None
        last_rev: str | None = None
        try:
            # Initial snapshot — full lookback window.
            buckets = await adapter.smile_buckets(
                currency, expiry, methodology, ts_method, lookback_ms,
            )
            last_seen_floor = adapter.latest_bucket_floor()
            last_rev = vol_time.calendar_rev(vol_time.get_active_calendar())
            await ws.send_text(json.dumps({
                "type": "smile_buckets_snapshot",
                "conversationId": conversation_id,
                "data": {
                    "currency": currency,
                    "expiry": expiry,
                    "methodology": methodology,
                    "termStructure": ts_method,
                    "lookbackMs": lookback_ms,
                    "calendar_rev": last_rev,
                    "buckets": [
                        {"bucket_ts": bts, "fit": _fit_dict(f) if f else None}
                        for bts, f in buckets
                    ],
                },
            }))

            async for _snap in adapter.chain_stream(currency):
                current_rev = vol_time.calendar_rev(vol_time.get_active_calendar())
                current_floor = adapter.latest_bucket_floor()

                # Calendar recalibrate detection (M3.9d). Wkg-basis fits
                # depend on calendar_rev, so on rev change re-emit the
                # full snapshot under the new rev; cache misses on the
                # stale entries naturally trigger recompute on access.
                # Cal-basis methodologies don't depend on rev — skip.
                if is_wkg and last_rev is not None and current_rev != last_rev:
                    buckets = await adapter.smile_buckets(
                        currency, expiry, methodology, ts_method, lookback_ms,
                    )
                    await ws.send_text(json.dumps({
                        "type": "smile_buckets_snapshot",
                        "conversationId": conversation_id,
                        "data": {
                            "currency": currency,
                            "expiry": expiry,
                            "methodology": methodology,
                            "termStructure": ts_method,
                            "lookbackMs": lookback_ms,
                            "calendar_rev": current_rev,
                            "buckets": [
                                {"bucket_ts": bts, "fit": _fit_dict(f) if f else None}
                                for bts, f in buckets
                            ],
                        },
                    }))
                    last_rev = current_rev
                    last_seen_floor = current_floor
                    continue

                last_rev = current_rev
                # Re-fit the head bucket on every poll inside the hour
                # (so the in-progress current bucket reflects the latest
                # chain state). Emit a new bucket on the first poll past
                # an hour boundary.
                head_fit = await adapter.smile_bucket_fit(
                    currency, expiry, methodology, ts_method, current_floor,
                )
                payload = {
                    "currency": currency,
                    "expiry": expiry,
                    "methodology": methodology,
                    "termStructure": ts_method,
                    "calendar_rev": current_rev,
                    "bucket_ts": current_floor,
                    "fit": _fit_dict(head_fit) if head_fit else None,
                    "is_new_bucket": last_seen_floor is not None
                                     and current_floor > last_seen_floor,
                }
                last_seen_floor = current_floor
                await ws.send_text(json.dumps({
                    "type": "smile_bucket_append",
                    "conversationId": conversation_id,
                    "data": payload,
                }))
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
        except Exception as exc:
            log.warning("smile_buckets pump error: %s", exc)

    task = asyncio.create_task(pump())
    return lambda: task.cancel()


async def _subscribe_termstructure_buckets(
    ws: WebSocket, adapter: DeribitAdapter, msg: dict, conversation_id: str,
) -> Callable[[], None]:
    """Hourly-bucket TS snapshots across `lookback_ms`. Same shape as
    `_subscribe_smile_buckets` but for term-structure curves."""
    currency = str(msg.get("currency") or "")
    method = str(msg.get("method") or "")
    try:
        lookback_ms = int(msg.get("lookbackMs") or 0)
    except (TypeError, ValueError):
        lookback_ms = 0
    if not currency or not method or lookback_ms <= 0:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": "subscribe_termstructure_buckets requires currency, method, lookbackMs>0",
        }))
        return lambda: None
    builder = get_curve_builder(method)
    if builder is None:
        await ws.send_text(json.dumps({
            "type": "error", "conversationId": conversation_id,
            "message": f"unknown term-structure method: {method}",
        }))
        return lambda: None

    is_wkg = builder.time_basis == "wkg"

    async def pump() -> None:
        last_seen_floor: int | None = None
        last_rev: str | None = None
        try:
            buckets = await adapter.term_structure_buckets(currency, method, lookback_ms)
            last_seen_floor = adapter.latest_bucket_floor()
            last_rev = vol_time.calendar_rev(vol_time.get_active_calendar())
            await ws.send_text(json.dumps({
                "type": "termstructure_buckets_snapshot",
                "conversationId": conversation_id,
                "data": {
                    "currency": currency,
                    "method": method,
                    "lookbackMs": lookback_ms,
                    "calendar_rev": last_rev,
                    "buckets": [
                        {"bucket_ts": bts, "snapshot": _ts_dict(s) if s else None}
                        for bts, s in buckets
                    ],
                },
            }))

            async for _snap in adapter.chain_stream(currency):
                current_rev = vol_time.calendar_rev(vol_time.get_active_calendar())
                current_floor = adapter.latest_bucket_floor()

                # Wkg-basis curve depends on calendar_rev — on rev change
                # re-emit the full snapshot under the new rev (M3.9d).
                if is_wkg and last_rev is not None and current_rev != last_rev:
                    buckets = await adapter.term_structure_buckets(currency, method, lookback_ms)
                    await ws.send_text(json.dumps({
                        "type": "termstructure_buckets_snapshot",
                        "conversationId": conversation_id,
                        "data": {
                            "currency": currency,
                            "method": method,
                            "lookbackMs": lookback_ms,
                            "calendar_rev": current_rev,
                            "buckets": [
                                {"bucket_ts": bts, "snapshot": _ts_dict(s) if s else None}
                                for bts, s in buckets
                            ],
                        },
                    }))
                    last_rev = current_rev
                    last_seen_floor = current_floor
                    continue

                last_rev = current_rev
                head = await adapter.term_structure_bucket_fit(currency, method, current_floor)
                payload = {
                    "currency": currency,
                    "method": method,
                    "calendar_rev": current_rev,
                    "bucket_ts": current_floor,
                    "snapshot": _ts_dict(head) if head else None,
                    "is_new_bucket": last_seen_floor is not None
                                     and current_floor > last_seen_floor,
                }
                last_seen_floor = current_floor
                await ws.send_text(json.dumps({
                    "type": "termstructure_bucket_append",
                    "conversationId": conversation_id,
                    "data": payload,
                }))
        except (asyncio.CancelledError, WebSocketDisconnect):
            pass
        except Exception as exc:
            log.warning("termstructure_buckets pump error: %s", exc)

    task = asyncio.create_task(pump())
    return lambda: task.cancel()


async def _stream_rate_limit(ws: WebSocket, adapter: DeribitAdapter) -> None:
    try:
        while True:
            s = adapter.rate_limit_status
            await ws.send_text(json.dumps({
                "type": "rate_limit_status",
                "data": dataclasses.asdict(s),
            }))
            await asyncio.sleep(2)
    except (asyncio.CancelledError, WebSocketDisconnect):
        pass
    except Exception as exc:
        log.warning("rate limit stream error: %s", exc)


async def _stream_backfill_progress(ws: WebSocket, adapter: DeribitAdapter) -> None:
    """Push every progress change. Final 'done' state is the last frame sent —
    the orchestrator stops publishing after that, so the loop just blocks until
    the WS closes (which cancels the task and runs the cleanup).
    """
    queue: asyncio.Queue[dict] = asyncio.Queue(maxsize=64)

    def listener(snapshot: dict) -> None:
        try:
            queue.put_nowait(snapshot)
        except asyncio.QueueFull:
            pass

    unsub = adapter.backfill.subscribe(listener)
    try:
        while True:
            snap = await queue.get()
            await ws.send_text(json.dumps({"type": "backfill_progress", "data": snap}))
    except (asyncio.CancelledError, WebSocketDisconnect):
        pass
    except Exception as exc:
        log.warning("backfill stream error: %s", exc)
    finally:
        unsub()
