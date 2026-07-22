/** Wire format from the backend. One WS message may bundle many ticks --
 * see backend/app/simulator.py for why the server batches instead of
 * sending one frame per tick. */
export interface RawTick {
  symbol: string;
  price: number;
  ts: number; // ms since epoch
  seq: number;
}

export interface TickBatchMessage {
  type: 'ticks';
  batch_ts: number;
  ticks: RawTick[];
}

/** Coalesced OHLC-style bar produced when multiple ticks for the same
 * symbol arrive within a buffered window and get merged into a single
 * render update instead of being individually rendered (or dropped). */
export interface OhlcBar {
  symbol: string;
  open: number;
  high: number;
  low: number;
  close: number;
  count: number;
  firstTs: number;
  lastTs: number;
}

export type BackpressureStrategy = 'drop-oldest' | 'coalesce';

export interface BufferMetricsSnapshot {
  /** items currently sitting in the buffer, awaiting the next render frame */
  depth: number;
  capacity: number;
  /** cumulative ticks discarded outright (drop-oldest mode only) */
  droppedCount: number;
  /** cumulative ticks absorbed into an already-pending bar instead of occupying a new slot (coalesce mode only) */
  coalescedCount: number;
}

export interface LiveMetricsSnapshot extends BufferMetricsSnapshot {
  incomingTicksPerSec: number;
  renderedFramesPerSec: number;
  strategy: BackpressureStrategy;
  ingestionMode: 'main-thread' | 'worker';
  connected: boolean;
}
