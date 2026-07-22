"""
Tick simulator: a single asyncio task that periodically wakes up, decides
how many ticks to emit this period, generates them, and hands a *batch* to
the connection manager for broadcast.

Why batch instead of `await asyncio.sleep(1/rate)` once per tick?
-------------------------------------------------------------------
At low rates (say, 100/sec) sleeping once per tick and sending one small
WS frame per tick would be fine. But asyncio.sleep() carries real
scheduling overhead (a timer registration + an event-loop wakeup), and
that overhead becomes the bottleneck long before you reach 50,000
wakeups/sec on a single OS thread -- most platforms can't reliably hit
that call rate, and even if they could, it would leave near-zero CPU
budget for the actual work (RNG draws, dataclass construction, JSON
encoding) that has to happen between wakeups. Real market data feeds solve
this the same way: bucket ticks into small time windows and ship them as a
batch.

So here, one scheduler wakeup (every SCHEDULER_INTERVAL_SECONDS, i.e. 100
times/sec) computes `n` = however many ticks the *configured rate* implies
for that window, generates all `n`, and broadcasts one JSON message
containing the batch. This pins the number of asyncio.sleep()/wakeup
cycles to a fixed 100/sec regardless of tick rate; scaling rate up means
growing *batch size*, not *wakeup frequency* -- far cheaper on a single
thread, and it mirrors how a real feed handler would coalesce updates
before writing to a socket.

Where this still bottlenecks (see README "Concurrency model" section for
the full discussion): JSON-encoding a batch of thousands of ticks is CPU
work that runs synchronously on the event loop thread, so very large
batches (very high tick rates) do delay other coroutines on this process --
this is exactly the kind of CPU-bound work asyncio does *not* parallelize,
and is the argument for moving generation+encoding to separate processes
if this had to scale past a single machine's needs.
"""
from __future__ import annotations

import asyncio
import itertools
import json
import random
import time
from typing import Awaitable, Callable

from .config import (
    DEFAULT_TICK_RATE,
    MAX_TICK_RATE,
    MIN_TICK_RATE,
    SCHEDULER_INTERVAL_SECONDS,
    SymbolConfig,
)
from .models import Tick
from .price_models import GbmPriceModel, OuPriceModel

BroadcastFn = Callable[[str], Awaitable[None]]


class SymbolState:
    """Owns one symbol's price model plus enough bookkeeping to compute a
    correct dt for its *own* process regardless of how the outer scheduler
    happens to batch or interleave ticks across symbols.

    dt is measured from real wall-clock time since this symbol's last
    update (via time.monotonic()), not derived from the scheduler's batch
    size. This keeps each symbol's stochastic process statistically
    correct (right variance per unit time) independent of tick rate,
    symbol count, or how often this particular symbol gets randomly
    selected in a given scheduler period.
    """

    def __init__(self, cfg: SymbolConfig) -> None:
        self.symbol = cfg.symbol
        self.model = (
            GbmPriceModel(cfg.start_price, cfg.mu, cfg.sigma)
            if cfg.model == "gbm"
            else OuPriceModel(cfg.start_price, cfg.theta, cfg.sigma, cfg.long_term_mean)
        )
        self._seq_counter = itertools.count(1)
        self._last_update = time.monotonic()

    def next_tick(self) -> Tick:
        now = time.monotonic()
        dt = max(now - self._last_update, 1e-9)
        self._last_update = now
        price = self.model.step(dt)
        return Tick(
            symbol=self.symbol,
            price=round(price, 4),
            ts=time.time() * 1000.0,
            seq=next(self._seq_counter),
        )


class TickSimulator:
    def __init__(self, symbols: list[SymbolConfig], broadcast_fn: BroadcastFn) -> None:
        if not symbols:
            raise ValueError("TickSimulator requires at least one symbol")
        self._states = [SymbolState(s) for s in symbols]
        self._broadcast_fn = broadcast_fn
        self.rate = DEFAULT_TICK_RATE
        self._task: asyncio.Task[None] | None = None
        self._running = False
        # Fractional-tick accumulator -- see _next_batch_size for why this
        # is needed for long-run rate accuracy.
        self._remainder = 0.0
        self.total_ticks_emitted = 0

    def set_rate(self, rate: int) -> None:
        self.rate = max(MIN_TICK_RATE, min(MAX_TICK_RATE, int(rate)))

    def _next_batch_size(self, dt: float) -> int:
        """How many ticks to emit for a scheduler period of length `dt`.

        rate*dt is rarely an integer (e.g. rate=333, dt=0.01 -> 3.33
        ticks/period). Truncating naively every period would silently
        under-deliver the configured rate over time (each period loses up
        to ~1 tick to rounding). Instead we carry the fractional remainder
        forward and emit an extra tick whenever it crosses 1, so long-run
        average throughput converges to exactly `rate`, not
        floor(rate*dt)/dt.
        """
        exact = self.rate * dt + self._remainder
        n = int(exact)
        self._remainder = exact - n
        return n

    def _emit_one(self) -> Tick:
        state = random.choice(self._states)
        return state.next_tick()

    async def _run(self) -> None:
        self._running = True
        while self._running:
            loop_start = time.monotonic()
            n = self._next_batch_size(SCHEDULER_INTERVAL_SECONDS)
            if n > 0:
                batch = [self._emit_one() for _ in range(n)]
                self.total_ticks_emitted += n
                message = json.dumps(
                    {
                        "type": "ticks",
                        "batch_ts": time.time() * 1000.0,
                        "ticks": [t.to_dict() for t in batch],
                    }
                )
                await self._broadcast_fn(message)
            # Compensate for time spent generating/encoding above so the
            # scheduler period stays close to SCHEDULER_INTERVAL_SECONDS on
            # average instead of drifting slower as batch size grows.
            elapsed = time.monotonic() - loop_start
            await asyncio.sleep(max(0.0, SCHEDULER_INTERVAL_SECONDS - elapsed))

    def start(self) -> None:
        if self._task is None:
            self._task = asyncio.create_task(self._run())

    async def stop(self) -> None:
        self._running = False
        task = self._task
        self._task = None
        if task is not None:
            try:
                await asyncio.wait_for(task, timeout=2.0)
            except asyncio.TimeoutError:
                task.cancel()
