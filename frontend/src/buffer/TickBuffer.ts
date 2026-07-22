import type { BackpressureStrategy, BufferMetricsSnapshot, OhlcBar, RawTick } from '../types';

/**
 * Bounded, strategy-switchable buffer sitting between tick ingestion
 * (WebSocket onmessage, or a Web Worker relaying parsed ticks) and the
 * rAF-driven render loop.
 *
 * WHY A BOUNDED BUFFER AT ALL
 * ----------------------------
 * The WebSocket can deliver ticks far faster than the browser can, or
 * should, paint frames. At 50,000 ticks/sec the producer issues an update
 * roughly every 20 microseconds, while a 60fps render loop only wants new
 * data every ~16.6 *milliseconds* -- a ~1000x mismatch at the extreme end
 * of the demo's range. Without a bound, an unconsumed backlog would grow
 * every frame the network out-produces rendering, and the tab's memory
 * would grow without limit until the page slows to a crawl or the OS
 * kills it. A bounded buffer forces an explicit, visible choice about what
 * happens when supply exceeds demand, instead of silently queuing forever.
 *
 * TWO STRATEGIES, SWITCHABLE AT RUNTIME
 * --------------------------------------
 * 1. drop-oldest: a fixed-capacity ring buffer of raw ticks. When full,
 *    the oldest queued tick is overwritten by the newest one. O(1) push,
 *    preserves exact tick values for whatever survives, but throws away
 *    information outright -- dropped ticks are simply never seen.
 *
 * 2. coalesce: instead of storing individual ticks, we keep at most one
 *    *pending bar* per symbol (open/high/low/close/count), keyed by
 *    symbol. A tick for a symbol that already has a pending bar updates
 *    that bar in place (O(1)) rather than occupying a new slot. Buffer
 *    depth is therefore bounded by the number of *distinct live symbols*,
 *    not by tick volume: at 50,000 ticks/sec across 12 symbols, the
 *    coalesce buffer never holds more than 12 entries no matter how far
 *    behind the renderer falls, and no tick's *information* is fully
 *    discarded -- high/low/close and a per-symbol tick count are always
 *    preserved, even though the individual intermediate prices aren't.
 *
 * The tradeoff: drop-oldest shows you (a sample of) the truth at full
 * granularity but loses whole ticks; coalesce shows you a lossy summary
 * of *everything* but loses intra-bar path detail. Which is "correct"
 * depends on what the consumer cares about -- this is exactly the kind of
 * decision a real trading UI has to make explicit, which is why it's a
 * runtime-switchable, demoable toggle here rather than a fixed choice.
 */
export class TickBuffer {
  private readonly capacity: number;
  private strategy: BackpressureStrategy;

  // --- drop-oldest storage: fixed-size ring buffer ---
  private ring: (RawTick | undefined)[];
  private ringHead = 0; // index of the oldest element
  private ringSize = 0;

  // --- coalesce storage: at most one bar per symbol ---
  private bars = new Map<string, OhlcBar>();
  private dirtyOrder: string[] = []; // FIFO order of symbols with a pending bar

  private droppedCount = 0;
  private coalescedCount = 0;

  constructor(capacity: number, strategy: BackpressureStrategy = 'drop-oldest') {
    if (!Number.isFinite(capacity) || capacity <= 0) {
      throw new Error('TickBuffer capacity must be a positive number');
    }
    this.capacity = Math.floor(capacity);
    this.strategy = strategy;
    this.ring = new Array(this.capacity);
  }

  /** Switch strategy at runtime. Clears pending (not-yet-rendered) data:
   * the two storage modes aren't directly convertible, and silently
   * reinterpreting one as the other would misrepresent what's actually
   * buffered right now. Cumulative counters (dropped/coalesced) are kept
   * as-is since they describe history, not current contents. */
  setStrategy(strategy: BackpressureStrategy): void {
    if (strategy === this.strategy) return;
    this.clearPending();
    this.strategy = strategy;
  }

  getStrategy(): BackpressureStrategy {
    return this.strategy;
  }

  push(tick: RawTick): void {
    if (this.strategy === 'coalesce') {
      this.pushCoalesce(tick);
    } else {
      this.pushRing(tick);
    }
  }

  private pushRing(tick: RawTick): void {
    if (this.ringSize < this.capacity) {
      const writeIndex = (this.ringHead + this.ringSize) % this.capacity;
      this.ring[writeIndex] = tick;
      this.ringSize++;
      return;
    }
    // Full: overwrite the oldest slot and advance head past it.
    this.ring[this.ringHead] = tick;
    this.ringHead = (this.ringHead + 1) % this.capacity;
    this.droppedCount++;
  }

  private pushCoalesce(tick: RawTick): void {
    const existing = this.bars.get(tick.symbol);
    if (existing === undefined) {
      this.bars.set(tick.symbol, {
        symbol: tick.symbol,
        open: tick.price,
        high: tick.price,
        low: tick.price,
        close: tick.price,
        count: 1,
        firstTs: tick.ts,
        lastTs: tick.ts,
      });
      this.dirtyOrder.push(tick.symbol);
      return;
    }
    existing.high = Math.max(existing.high, tick.price);
    existing.low = Math.min(existing.low, tick.price);
    existing.close = tick.price;
    existing.lastTs = tick.ts;
    existing.count += 1;
    this.coalescedCount++;
  }

  /** Pull everything pending for this render frame; empties the buffer.
   * Returns raw ticks (oldest-first) in drop-oldest mode, or OHLC bars
   * (first-updated-first) in coalesce mode. */
  drain(): RawTick[] | OhlcBar[] {
    if (this.strategy === 'coalesce') {
      const out: OhlcBar[] = [];
      for (const symbol of this.dirtyOrder) {
        const bar = this.bars.get(symbol);
        if (bar) out.push(bar);
      }
      this.bars.clear();
      this.dirtyOrder = [];
      return out;
    }
    const out: RawTick[] = [];
    for (let i = 0; i < this.ringSize; i++) {
      const tick = this.ring[(this.ringHead + i) % this.capacity];
      if (tick) out.push(tick);
    }
    this.ringHead = 0;
    this.ringSize = 0;
    return out;
  }

  private clearPending(): void {
    this.ringHead = 0;
    this.ringSize = 0;
    this.ring = new Array(this.capacity);
    this.bars.clear();
    this.dirtyOrder = [];
  }

  get depth(): number {
    return this.strategy === 'coalesce' ? this.dirtyOrder.length : this.ringSize;
  }

  getMetrics(): BufferMetricsSnapshot {
    return {
      depth: this.depth,
      capacity: this.capacity,
      droppedCount: this.droppedCount,
      coalescedCount: this.coalescedCount,
    };
  }

  resetCounters(): void {
    this.droppedCount = 0;
    this.coalescedCount = 0;
  }
}
