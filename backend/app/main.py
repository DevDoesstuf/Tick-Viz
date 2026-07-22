"""
FastAPI application: HTTP control endpoints + WebSocket tick stream.

Design note: control (set tick rate) is plain REST, not messages sent over
the tick WebSocket. Keeping the WS strictly one-directional (server ->
client, ticks only) keeps the wire protocol trivial to reason about, and
means the control plane and data plane can be scaled/secured/rate-limited
independently later (e.g. auth on POST /control/rate without touching the
public tick feed).
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from .config import DEFAULT_SYMBOLS, MAX_TICK_RATE, MIN_TICK_RATE
from .connection_manager import ConnectionManager
from .simulator import TickSimulator

logging.basicConfig(level=logging.INFO)

manager = ConnectionManager()
simulator = TickSimulator(DEFAULT_SYMBOLS, broadcast_fn=manager.broadcast)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    simulator.start()
    yield
    await simulator.stop()


app = FastAPI(title="tick-viz backend", lifespan=lifespan)

# Demo-only: wide open CORS so the Vite dev server (any localhost port) can
# always reach this API. Lock this down to specific origins in production.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class RateRequest(BaseModel):
    rate: int = Field(ge=MIN_TICK_RATE, le=MAX_TICK_RATE)


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "status": "ok",
        "rate": simulator.rate,
        "clients": manager.client_count,
        "total_ticks_emitted": simulator.total_ticks_emitted,
    }


@app.get("/symbols")
async def symbols() -> dict[str, list[str]]:
    return {"symbols": [s.symbol for s in DEFAULT_SYMBOLS]}


@app.post("/control/rate")
async def set_rate(req: RateRequest) -> dict[str, int]:
    simulator.set_rate(req.rate)
    return {"rate": simulator.rate}


@app.websocket("/ws/ticks")
async def ws_ticks(websocket: WebSocket) -> None:
    await manager.connect(websocket)
    try:
        while True:
            # This socket is intentionally one-directional in practice (see
            # module docstring), but we still need to `await` something so
            # this coroutine notices a client disconnect -- a blocking
            # receive costs nothing while idle on a single-threaded event
            # loop and is the standard way to detect a closed connection.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        await manager.disconnect(websocket)
