/// <reference lib="webworker" />

import { TickBuffer } from '../buffer/TickBuffer';
import type { BackpressureStrategy, TickBatchMessage } from '../types';

/**
 * STRETCH GOAL: tick ingestion moved off the main thread.
 *
 * This worker owns the WebSocket connection, the JSON.parse of every
 * incoming batch, and the TickBuffer itself. The main thread's job shrinks
 * to: requestAnimationFrame + canvas drawing + reading whatever this
 * worker last posted. See MainThreadIngestion.ts for the contrasting
 * "everything on the UI thread" path, and README "JS concurrency model"
 * for the full tradeoff writeup.
 *
 * WHY A TIMER INSTEAD OF requestAnimationFrame HERE
 * ---------------------------------------------------
 * Dedicated Web Workers do not have access to requestAnimationFrame (it's
 * a window/rendering-pipeline API). We approximate a 60Hz cadence with
 * `setInterval(16ms)` purely to decide "how often to hand a drained batch
 * to the main thread" -- actual painting still only ever happens in the
 * main thread's own rAF loop. This worker's timer and the main thread's
 * rAF are two independent clocks; see WorkerIngestion.ts for how the main
 * thread reconciles that (last-value-wins on whatever the worker most
 * recently posted, rather than trying to keep the two clocks in lockstep).
 *
 * WHY THIS HELPS, AND WHAT IT COSTS
 * ------------------------------------
 * Helps: JSON.parse of a multi-thousand-tick batch, and all the buffer
 * push() work, now costs *worker* thread time, not main thread time --
 * the UI thread stays free for rAF/paint regardless of tick rate.
 * Costs: every drained batch has to cross a postMessage boundary
 * (structured clone), which is not free, and adds one worker-timer-tick of
 * latency (~16ms) versus draining synchronously in the same frame. For a
 * demo at 100k ticks/sec, that tradeoff is clearly worth it; for a low
 * tick-rate feed it would be needless overhead, which is why this is a
 * runtime-switchable mode rather than the only path.
 */

let buffer = new TickBuffer(50_000, 'drop-oldest');
let ws: WebSocket | null = null;
let incomingSinceLastFlush = 0;

const FLUSH_INTERVAL_MS = 16;

type InboundMessage =
  | { cmd: 'connect'; url: string }
  | { cmd: 'disconnect' }
  | { cmd: 'set-strategy'; strategy: BackpressureStrategy }
  | { cmd: 'set-capacity'; capacity: number };

self.onmessage = (event: MessageEvent<InboundMessage>): void => {
  const msg = event.data;
  switch (msg.cmd) {
    case 'connect':
      connect(msg.url);
      break;
    case 'disconnect':
      ws?.close();
      ws = null;
      break;
    case 'set-strategy':
      buffer.setStrategy(msg.strategy);
      break;
    case 'set-capacity':
      buffer = new TickBuffer(msg.capacity, buffer.getStrategy());
      break;
  }
};

function connect(url: string): void {
  ws?.close();
  const socket = new WebSocket(url);
  ws = socket;
  socket.onopen = () => postMessage({ type: 'connection', connected: true });
  socket.onclose = () => postMessage({ type: 'connection', connected: false });
  socket.onerror = () => postMessage({ type: 'connection', connected: false });
  socket.onmessage = (event: MessageEvent<string>) => {
    const data = JSON.parse(event.data) as TickBatchMessage;
    for (const t of data.ticks) {
      buffer.push(t);
    }
    incomingSinceLastFlush += data.ticks.length;
  };
}

setInterval(() => {
  const drained = buffer.drain();
  const metrics = buffer.getMetrics();
  postMessage({
    type: 'frame',
    drained,
    strategy: buffer.getStrategy(),
    incomingSinceLastFlush,
    metrics,
  });
  incomingSinceLastFlush = 0;
}, FLUSH_INTERVAL_MS);
