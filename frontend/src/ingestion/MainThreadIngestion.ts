import { TickBuffer } from '../buffer/TickBuffer';
import { RateCounter } from '../metrics/MetricsTracker';
import type { BackpressureStrategy, BufferMetricsSnapshot, OhlcBar, RawTick, TickBatchMessage } from '../types';

/**
 * Ingests ticks directly on the main (UI) thread: WebSocket `onmessage`
 * fires here, `JSON.parse` runs here, and pushes into the TickBuffer run
 * here. This is the simple, default path.
 *
 * THE MAIN-THREAD BOTTLENECK THIS DEMONSTRATES
 * ---------------------------------------------
 * The browser's JS execution model is single-threaded: `onmessage`
 * handlers, React re-renders, and the paint/rAF pipeline all compete for
 * the same thread. At low tick rates this is invisible. At high tick
 * rates, JSON.parse-ing large batches (thousands of ticks per message) is
 * real, synchronous CPU work that runs on that same thread -- it can
 * visibly compete with rendering for time, which is precisely why
 * ingestion and rendering being decoupled *within* the buffer (bounded
 * queue + independent rAF drain) isn't the *whole* story: the parsing step
 * itself still costs main-thread time before a tick even reaches the
 * buffer. The Web Worker ingestion mode (WorkerIngestion.ts) moves that
 * parsing off this thread entirely -- flip the "ingestion mode" toggle in
 * the UI to compare frame stability between the two at the same tick rate.
 */
export class MainThreadIngestion {
  private ws: WebSocket | null = null;
  private buffer: TickBuffer;
  private incomingRate = new RateCounter();
  private _connected = false;

  constructor(capacity: number, strategy: BackpressureStrategy) {
    this.buffer = new TickBuffer(capacity, strategy);
  }

  connect(url: string): void {
    this.ws?.close();
    const ws = new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => {
      this._connected = true;
    };
    ws.onclose = () => {
      this._connected = false;
    };
    ws.onerror = () => {
      this._connected = false;
    };
    ws.onmessage = (event: MessageEvent<string>) => {
      const data = JSON.parse(event.data) as TickBatchMessage;
      for (const t of data.ticks) {
        this.buffer.push(t);
      }
      this.incomingRate.tick(data.ticks.length);
    };
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this._connected = false;
  }

  setStrategy(strategy: BackpressureStrategy): void {
    this.buffer.setStrategy(strategy);
  }

  /** Called once per rAF frame by the render loop. */
  drainFrame(): RawTick[] | OhlcBar[] {
    return this.buffer.drain();
  }

  getBufferMetrics(): BufferMetricsSnapshot {
    return this.buffer.getMetrics();
  }

  getIncomingRate(): number {
    return this.incomingRate.currentRate();
  }

  get connected(): boolean {
    return this._connected;
  }
}
