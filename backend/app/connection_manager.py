"""
Per-client outbound queues + dedicated sender tasks.

Why not just `for client in clients: await client.send_text(msg)` from the
simulator's broadcast call?
--------------------------------------------------------------------------
Because a single slow client (bad network, backgrounded tab, whatever)
would stall that loop on `await` while every *other* client -- and the
simulator's own scheduler -- waits behind it. One bad consumer would
degrade service for everyone, since this is all one thread.

Instead, broadcast() does `queue.put_nowait()` into each client's own
bounded asyncio.Queue: O(1), never awaits, never touches the network.
Each client has its own long-running sender task that owns the actual
`await websocket.send_text()` call, so a slow socket only blocks *that*
client's task, not the shared broadcast path. If a client's queue is full
(that client's socket can't drain fast enough to keep up with the current
tick rate), we drop that client's oldest queued batch -- the same
drop-oldest backpressure decision the frontend makes on incoming ticks,
just enforced server-side per-connection so one laggy consumer can't grow
unbounded server memory either.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import WebSocket, WebSocketDisconnect

from .config import CLIENT_QUEUE_MAXSIZE

logger = logging.getLogger("tick_viz.connection_manager")


class ClientConnection:
    def __init__(self, websocket: WebSocket) -> None:
        self.websocket = websocket
        self.queue: asyncio.Queue[str] = asyncio.Queue(maxsize=CLIENT_QUEUE_MAXSIZE)
        self.dropped = 0
        self.sender_task: asyncio.Task[None] | None = None

    def enqueue(self, message: str) -> None:
        try:
            self.queue.put_nowait(message)
            return
        except asyncio.QueueFull:
            pass
        # Server-side drop-oldest: discard the stalest queued batch to make
        # room for the freshest one. For a live tick feed, freshness matters
        # more than completeness -- a consumer that's behind wants to catch
        # up to "now", not slowly replay a backlog of stale prices.
        try:
            self.queue.get_nowait()
        except asyncio.QueueEmpty:
            pass
        self.dropped += 1
        try:
            self.queue.put_nowait(message)
        except asyncio.QueueFull:
            pass  # lost a race with another producer; drop this message silently

    async def sender_loop(self) -> None:
        try:
            while True:
                message = await self.queue.get()
                await self.websocket.send_text(message)
        except (WebSocketDisconnect, RuntimeError, ConnectionResetError):
            pass
        except asyncio.CancelledError:
            pass


class ConnectionManager:
    def __init__(self) -> None:
        self._clients: dict[WebSocket, ClientConnection] = {}
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> ClientConnection:
        await websocket.accept()
        client = ClientConnection(websocket)
        async with self._lock:
            self._clients[websocket] = client
        client.sender_task = asyncio.create_task(client.sender_loop())
        logger.info("client connected; total=%d", len(self._clients))
        return client

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            client = self._clients.pop(websocket, None)
        if client and client.sender_task:
            client.sender_task.cancel()
        logger.info("client disconnected; total=%d", len(self._clients))

    async def broadcast(self, message: str) -> None:
        # Snapshot values() into a list so a concurrent disconnect (which
        # mutates _clients) can't raise "dict changed size during iteration".
        for client in list(self._clients.values()):
            client.enqueue(message)

    @property
    def client_count(self) -> int:
        return len(self._clients)
