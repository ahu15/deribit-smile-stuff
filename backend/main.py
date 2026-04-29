import asyncio
import dataclasses
import json
import logging
import time
from contextlib import asynccontextmanager
from typing import Callable

import truststore
truststore.inject_into_ssl()

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect, Query
from fastapi.middleware.cors import CORSMiddleware

from backend.history import HistoryStore, Sample, TradePrint
from backend.venues.deribit.adapter import DeribitAdapter
from backend.venues import registry

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

    currency = "BTC"
    adapter: DeribitAdapter = registry.get("deribit")

    chain_task = asyncio.create_task(_stream_chain(websocket, adapter, currency))
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

            elif mtype == "subscribe_currency":
                new_ccy = msg.get("currency", "BTC")
                if new_ccy != currency:
                    currency = new_ccy
                    chain_task.cancel()
                    chain_task = asyncio.create_task(_stream_chain(websocket, adapter, currency))

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
        chain_task.cancel()
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


# ---------- streams (broadcast envelopes) ----------


async def _stream_chain(ws: WebSocket, adapter: DeribitAdapter, currency: str) -> None:
    try:
        async for snap in adapter.chain_stream(currency):
            payload = {
                "type": "chain_snapshot",
                "data": {
                    "currency": snap.currency,
                    "timestamp_ms": snap.timestamp_ms,
                    "mark_count": len(snap.marks),
                    "marks": {
                        k: {
                            "mark_iv": v.mark_iv,
                            "mark_price": v.mark_price,
                            "underlying_price": v.underlying_price,
                        }
                        for k, v in list(snap.marks.items())[:100]
                    },
                },
            }
            await ws.send_text(json.dumps(payload))
    except (asyncio.CancelledError, WebSocketDisconnect):
        pass
    except Exception as exc:
        log.warning("chain stream error: %s", exc)


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
