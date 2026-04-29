import asyncio
import dataclasses
import json
import logging
import time
from contextlib import asynccontextmanager

import truststore
truststore.inject_into_ssl()

from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

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


@app.get("/api/rate-limit-status")
async def rate_limit_status():
    adapter = registry.get("deribit")
    return dataclasses.asdict(adapter.rate_limit_status)


@app.websocket("/ws/oracle")
async def oracle_ws(websocket: WebSocket):
    await websocket.accept()
    log.info("oracle client connected")

    currency = "BTC"
    adapter = registry.get("deribit")

    chain_task = asyncio.create_task(_stream_chain(websocket, adapter, currency))
    status_task = asyncio.create_task(_stream_rate_limit(websocket, adapter))

    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)

            if msg.get("type") == "ping":
                # End-to-end ping: round-trips through Deribit (public/get_time)
                req_id = msg.get("id")
                try:
                    pong = await adapter.ping_deribit()
                    await websocket.send_text(json.dumps({
                        "type": "pong",
                        "id": req_id,
                        "data": pong,
                    }))
                except Exception as exc:
                    await websocket.send_text(json.dumps({
                        "type": "pong",
                        "id": req_id,
                        "error": str(exc),
                    }))

            elif msg.get("type") == "subscribe_currency":
                new_ccy = msg.get("currency", "BTC")
                if new_ccy != currency:
                    currency = new_ccy
                    chain_task.cancel()
                    chain_task = asyncio.create_task(_stream_chain(websocket, adapter, currency))

    except WebSocketDisconnect:
        log.info("oracle client disconnected")
    except Exception as exc:
        log.warning("oracle ws error: %s", exc)
    finally:
        chain_task.cancel()
        status_task.cancel()


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
    except asyncio.CancelledError:
        pass
    except WebSocketDisconnect:
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
    except asyncio.CancelledError:
        pass
    except WebSocketDisconnect:
        pass
    except Exception as exc:
        log.warning("rate limit stream error: %s", exc)
