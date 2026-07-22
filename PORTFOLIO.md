# Portfolio note: tick-viz

**What this is:** a small end-to-end system — an asyncio backend
simulating a configurable-rate tick feed (1 to 100,000 ticks/sec across 12
symbols, mixing trending and mean-reverting price models) and a
TypeScript/React frontend that renders it on a hand-rolled canvas render
loop — built specifically to demonstrate one problem: **what happens when
a data producer outpaces the consumer, and how you make that an explicit,
bounded, observable decision instead of an unbounded queue that eventually
falls over.**

**Why this problem, specifically:** any low-latency trading system's
internal tooling — a market-data monitor, a fills/PnL dashboard, a risk
view — faces the same shape of problem a matching engine faces, just one
layer up the stack: a fast producer (market data, fills, internal events)
and a consumer (a human, or a UI thread) that cannot and should not try to
process every single update individually once volume gets high enough.
The "right" answer isn't "make the consumer faster" — it's "decide,
explicitly, what to do when the consumer falls behind," the same way a
matching engine has explicit, tested rules for what happens at every
boundary condition rather than hoping the fast path always holds.

This project makes that decision visible and demoable: a bounded buffer
with two switchable strategies (drop-oldest vs. coalesce-to-OHLC), a
render loop that's structurally decoupled from network arrival via
`requestAnimationFrame`, and a live dashboard showing incoming ticks/sec,
rendered frames/sec, buffer depth against capacity, and running
dropped/coalesced counts — so the tradeoff isn't just asserted, it's
something you can watch happen while cranking the simulated rate from 100
to 100,000 ticks/sec live.

**What I'd point to specifically:**

- [`TickBuffer.ts`](./frontend/src/buffer/TickBuffer.ts) — the
  correctness-critical piece, tested like I'd want a matching engine's
  edge cases tested: empty buffer, single-tick coalescing, ring-buffer
  wraparound, rapid strategy flapping, and depth staying bounded by symbol
  count (not tick volume) under a 10,000-tick burst.
- [`simulator.py`](./backend/app/simulator.py) — the reasoning for why
  asyncio should batch ticks into fixed-frequency scheduler wakeups rather
  than sleep once per tick, and why per-symbol price steps are computed
  from real elapsed wall-clock time rather than derived from batch size
  (so statistical correctness doesn't depend on how the scheduler happens
  to interleave symbols).
- The **README's concurrency-model section** — where I think the
  single-threaded event loop and single-threaded browser JS would each
  start to bottleneck as rate/client count grows, and specifically what
  I'd change (process-per-symbol-shard, binary wire format, Web Worker
  ingestion) if this had to scale past a single machine or a single
  low-power laptop's main thread.

**What this deliberately doesn't try to be:** a production trading UI, a
general-purpose charting library, or a scaled multi-process system. It's
sized to make one specific engineering tradeoff — backpressure under a
producer/consumer speed mismatch — as clear, tested, and demoable as
possible in isolation.
