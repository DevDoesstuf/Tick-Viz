# tick-viz

A real-time tick chart that stays responsive when the data producer
outpaces the browser — a Python/asyncio backend streaming a simulated
high-frequency tick feed (1 to 100,000 ticks/sec, configurable live) over
WebSocket, and a TypeScript/React frontend that renders it on a
hand-rolled `<canvas>` render loop with explicit, switchable backpressure
handling.

See [`PORTFOLIO.md`](./PORTFOLIO.md) for the "why this matters for a
trading firm" writeup.

```
tick-viz/
├── backend/    Python asyncio tick simulator + FastAPI WebSocket server
└── frontend/   TypeScript/React canvas chart with bounded-buffer backpressure
```

## Running it locally

### Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

Health check: `curl http://localhost:8000/health`

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open the printed local URL (typically `http://localhost:5173`). The
frontend expects the backend at `http://localhost:8000` / `ws://localhost:8000/ws/ticks`
by default; override with `VITE_API_BASE_URL` / `VITE_WS_URL` env vars if
needed.

### Tests

```bash
# backend — pure stdlib, no extra install needed beyond requirements.txt
cd backend && python -m unittest discover -s tests -v

# frontend
cd frontend && npm test
```

CI (`.github/workflows/ci.yml`) runs both suites, plus typecheck/lint/build,
on every push.

## Why canvas, not a charting library

Chart.js/Recharts/etc. are the right choice for most dashboards, but they
each own their own internal render/update pipeline — you tell them "here's
new data" and trust their internals to decide when and how to repaint.
That's exactly the part of this project that needs to be *explicit*: the
whole point is reasoning precisely about what triggers a redraw, how much
work happens per frame, and how that's decoupled from data arrival. Drawing
directly to `<canvas>` means the render loop, the coordinate mapping, and
the redraw cost are all code I wrote and can point to — not library
internals I'd have to guess at under load.

## The backpressure problem, concretely

At the top of the demo's range (50,000–100,000 ticks/sec), the network can
hand the browser a new price update roughly every 10–20 **microseconds**.
A 60fps render loop only wants new data every ~16.6 **milliseconds** — a
three-orders-of-magnitude mismatch at the extreme end. If every incoming
tick triggered a redraw (or even just got pushed into an ever-growing
array), the tab's memory would climb without bound and the render loop
would either fall further and further behind or lock up entirely trying to
keep up.

**The fix has two independent parts:**

1. **A bounded buffer** ([`TickBuffer.ts`](./frontend/src/buffer/TickBuffer.ts))
   sits between ingestion and rendering. It has a fixed capacity and an
   explicit policy for what happens when that capacity is exceeded —
   never "just keep growing".
2. **A render loop that pulls, on its own schedule** ([`useAnimationFrame.ts`](./frontend/src/hooks/useAnimationFrame.ts) +
   [`TickChart.tsx`](./frontend/src/components/TickChart.tsx)) — `requestAnimationFrame`
   fires at the browser's own pace and drains whatever's in the buffer
   *at that moment*, regardless of whether zero or ten thousand
   WebSocket messages arrived since the last frame. Network I/O and
   rendering are never coupled 1:1.

### The two backpressure strategies

| | **Drop-oldest** | **Coalesce** |
|---|---|---|
| Storage | fixed-capacity ring buffer of raw ticks | one OHLC-style bar per symbol (open/high/low/close/count) |
| On overflow | oldest raw tick is overwritten | new tick merges into the pending bar for that symbol |
| Buffer depth bound | fixed capacity (e.g. 2,000 ticks) | number of *distinct live symbols* (e.g. 12) — independent of tick rate |
| What's lost | whole ticks are discarded outright, never seen | intra-bar path detail (individual prices between open and close) |
| What's kept | exact values for whatever survives | every tick's *information* contributes to high/low/close, even if not individually rendered |

Neither is strictly "better" — they represent different answers to "what
matters more, granularity or completeness?", and that's exactly the kind
of tradeoff a real trading UI has to make explicit rather than hide. The
UI toggle switches between them live so you can watch buffer depth,
dropped count, and coalesced count all update in real time as you crank
the tick rate up.

On the canvas itself, coalesced points that merged more than one tick are
drawn with a small high/low wick (see `TickChart.tsx`) — so coalescing is
visible on the chart, not just a number in the metrics panel.

## Concurrency model reasoning

### Python / asyncio side

The simulator batches ticks instead of `await`ing `asyncio.sleep()` once
per tick (see the module docstring in
[`simulator.py`](./backend/app/simulator.py) for the full reasoning) — a
fixed 100Hz scheduler decides how many ticks a given rate implies for that
window and ships them as one message, so wakeup frequency stays constant
while batch size scales with rate.

**Where this still bottlenecks on a single machine:**

- `asyncio` gives you *concurrency* for I/O-bound work, not *parallelism*
  for CPU-bound work. JSON-encoding a batch of several thousand ticks,
  drawing random numbers, and constructing tick objects are all real CPU
  time spent synchronously on the one event-loop thread. As tick rate (and
  therefore batch size) grows, that encoding step increasingly delays
  everything else scheduled on the loop — other clients' sends, the
  control-plane HTTP handlers, the next scheduler wakeup.
- Broadcasting to *N* clients means *N* enqueue operations (cheap, `O(1)`
  each, non-blocking — see `connection_manager.py`) plus *N* sender-task
  wakeups per batch. That per-client overhead is small but non-zero, so
  throughput degrades as connected-client count grows, even though no
  single slow client can stall the others.

**What I'd change to scale past a single machine:**

1. Move price generation + JSON encoding into one or more separate
   **processes** (via `multiprocessing`), so that CPU-bound work never
   competes with the event loop's I/O scheduling on the same thread. The
   asyncio process's only job becomes reading pre-built frames and writing
   them to sockets — pure I/O, which is exactly what asyncio is good at.
2. **Shard symbols across worker processes** (e.g. one process per N
   symbols) that publish to a shared broker (Redis Streams / Kafka) rather
   than a single process owning every symbol.
3. Switch the wire format from JSON to something **cheaper to
   encode/decode** (e.g. a packed binary struct or FlatBuffers) — this cuts
   both CPU cost and bytes-on-wire, letting a single process serve more
   sockets before hitting a CPU ceiling.
4. For large client counts, run **multiple asyncio worker processes behind
   a load balancer**, each subscribing to the same tick feed via the
   broker rather than every client hitting one Python process directly.

None of this is implemented here — the single-process, single-broker
design is intentional and sufficient for a demo of the *client-side*
backpressure problem, which is this project's actual focus.

### JavaScript / browser side

The browser's JS execution model is single-threaded: `WebSocket.onmessage`
handlers, React re-renders/reconciliation, and the paint pipeline all
compete for the same thread. At low tick rates this is invisible. At high
tick rates, `JSON.parse` of large batches is real, synchronous work that
runs on that thread — which is why decoupling ingestion from rendering
*within* the buffer (bounded queue + independent rAF drain, described
above) isn't the whole story: the parsing step itself still costs
main-thread time before a tick even reaches the buffer.

**Stretch goal (implemented): Web Worker ingestion.** Toggle "ingestion
mode" in the UI to move the WebSocket connection, `JSON.parse`, and the
`TickBuffer` itself into a dedicated Web Worker
([`ingestWorker.ts`](./frontend/src/worker/ingestWorker.ts)). The main
thread's job shrinks to `requestAnimationFrame` + canvas drawing + reading
whatever the worker most recently posted. The two sides reconcile via a
simple **last-value-wins mailbox**
([`WorkerIngestion.ts`](./frontend/src/ingestion/WorkerIngestion.ts)):
since workers have no `requestAnimationFrame`, the worker flushes on a
16ms timer and the main thread just renders whichever flush arrived most
recently.

**The tradeoff, concretely:**
- *Helps:* parsing/buffering CPU cost moves entirely off the UI thread, so
  it can no longer compete with paint — worth it once tick rate gets high
  enough that main-thread ingestion visibly costs frames.
  - *Costs:* every drained batch crosses a `postMessage` boundary
  (structured clone — not free), adds up to one worker-timer-tick (~16ms)
  of latency versus draining synchronously in the same frame, and
  debugging spans two execution contexts instead of one. For a low tick
  rate, this overhead is pure waste, which is why it's a runtime-switchable
  mode rather than the only path.

## What I'd change to make this production-grade

- Binary wire protocol instead of JSON (see above) — biggest single win for
  both server CPU and payload size at high tick rates.
- Server-side symbol sharding / horizontal scaling as described above.
- Real auth + per-connection rate limiting on the control endpoints
  (currently wide-open CORS, intentionally, for local demo convenience).
- Persisted tick history (this demo is intentionally stateless/in-memory —
  a real system would need a time-series store for replay/backtesting).
- A proper virtualized order-book / multi-symbol view rather than one
  chart-at-a-time; today only the selected symbol renders as a chart
  (all symbols still stream and update the sidebar ticker).
- More rigorous frame-timing instrumentation (e.g. `PerformanceObserver`
  long-task tracking) rather than the current simple 1-second-window rate
  counters, for a truer picture of jank under load.
