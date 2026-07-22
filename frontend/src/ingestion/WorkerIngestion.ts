import { RateCounter } from '../metrics/MetricsTracker';
import type { BackpressureStrategy, BufferMetricsSnapshot, OhlcBar, RawTick } from '../types';

interface FrameMessage {
  type: 'frame';
  drained: RawTick[] | OhlcBar[];
  strategy: BackpressureStrategy;
  incomingSinceLastFlush: number;
  metrics: BufferMetricsSnapshot;
}

interface ConnectionMessage {
  type: 'connection';
  connected: boolean;
}

type OutboundMessage = FrameMessage | ConnectionMessage;

/**
 * Main-thread counterpart to worker/ingestWorker.ts.
 *
 * The worker posts a drained frame roughly every 16ms on its own timer;
 * this class just remembers the *most recent* posted frame ("mailbox",
 * last-value-wins) and hands it to the render loop whenever `drainFrame()`
 * is called. If the main thread's rAF happens to run faster than the
 * worker's timer, the same frame may be read twice (harmless -- redrawing
 * identical data is a no-op visually). If the main thread falls behind
 * (a slow frame), multiple worker postMessages may arrive before the next
 * `drainFrame()` call; we intentionally keep only the latest rather than
 * queueing every one, since queuing frames-of-frames here would just
 * reintroduce the same unbounded-backlog problem the TickBuffer already
 * solves -- one more coalescing point, at the IPC boundary.
 */
export class WorkerIngestion {
  private worker: Worker;
  private mailbox: RawTick[] | OhlcBar[] = [];
  private latestMetrics: BufferMetricsSnapshot = { depth: 0, capacity: 0, droppedCount: 0, coalescedCount: 0 };
  private incomingRate = new RateCounter();
  private _connected = false;

  constructor(capacity: number, strategy: BackpressureStrategy) {
    this.worker = new Worker(new URL('../worker/ingestWorker.ts', import.meta.url), { type: 'module' });
    this.worker.postMessage({ cmd: 'set-capacity', capacity });
    this.worker.postMessage({ cmd: 'set-strategy', strategy });
    this.worker.onmessage = (event: MessageEvent<OutboundMessage>) => {
      const msg = event.data;
      if (msg.type === 'frame') {
        this.mailbox = msg.drained;
        this.latestMetrics = msg.metrics;
        this.incomingRate.tick(msg.incomingSinceLastFlush);
      } else if (msg.type === 'connection') {
        this._connected = msg.connected;
      }
    };
  }

  connect(url: string): void {
    this.worker.postMessage({ cmd: 'connect', url });
  }

  disconnect(): void {
    this.worker.postMessage({ cmd: 'disconnect' });
  }

  setStrategy(strategy: BackpressureStrategy): void {
    this.worker.postMessage({ cmd: 'set-strategy', strategy });
  }

  /** Called once per rAF frame by the render loop. Returns (and clears)
   * whatever the worker most recently posted -- see class docstring. */
  drainFrame(): RawTick[] | OhlcBar[] {
    const frame = this.mailbox;
    this.mailbox = [];
    return frame;
  }

  getBufferMetrics(): BufferMetricsSnapshot {
    return this.latestMetrics;
  }

  getIncomingRate(): number {
    return this.incomingRate.currentRate();
  }

  get connected(): boolean {
    return this._connected;
  }

  terminate(): void {
    this.worker.terminate();
  }
}
