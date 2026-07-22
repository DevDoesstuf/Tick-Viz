import { describe, expect, it } from 'vitest';
import { TickBuffer } from './TickBuffer';
import type { OhlcBar, RawTick } from '../types';

function tick(symbol: string, price: number, seq: number, ts = seq): RawTick {
  return { symbol, price, ts, seq };
}

describe('TickBuffer - drop-oldest strategy', () => {
  it('starts empty: depth 0, drain returns []', () => {
    const buf = new TickBuffer(4, 'drop-oldest');
    expect(buf.depth).toBe(0);
    expect(buf.drain()).toEqual([]);
  });

  it('single push then drain returns exactly that tick, buffer empties', () => {
    const buf = new TickBuffer(4, 'drop-oldest');
    buf.push(tick('AAPL', 100, 1));
    expect(buf.depth).toBe(1);
    const drained = buf.drain();
    expect(drained).toEqual([tick('AAPL', 100, 1)]);
    expect(buf.depth).toBe(0);
    // draining again immediately yields nothing new
    expect(buf.drain()).toEqual([]);
  });

  it('preserves FIFO order for ticks under capacity', () => {
    const buf = new TickBuffer(5, 'drop-oldest');
    for (let i = 1; i <= 3; i++) buf.push(tick('AAPL', 100 + i, i));
    const drained = buf.drain() as RawTick[];
    expect(drained.map((t) => t.seq)).toEqual([1, 2, 3]);
  });

  it('drops the oldest tick once capacity is exceeded, keeping the newest N', () => {
    const buf = new TickBuffer(3, 'drop-oldest');
    for (let i = 1; i <= 5; i++) buf.push(tick('AAPL', 100 + i, i));
    // capacity 3, pushed 5 -> should have dropped 2 oldest (seq 1, 2), kept 3,4,5
    const drained = buf.drain() as RawTick[];
    expect(drained.map((t) => t.seq)).toEqual([3, 4, 5]);
    expect(buf.getMetrics().droppedCount).toBe(2);
  });

  it('handles rapid threshold flapping: many pushes far beyond capacity in one burst', () => {
    const buf = new TickBuffer(10, 'drop-oldest');
    const burst = 10_000;
    for (let i = 1; i <= burst; i++) buf.push(tick('X', i, i));
    const drained = buf.drain() as RawTick[];
    expect(drained).toHaveLength(10);
    // last 10 seqs pushed should be exactly what's retained, in order
    const expectedSeqs = Array.from({ length: 10 }, (_, i) => burst - 9 + i);
    expect(drained.map((t) => t.seq)).toEqual(expectedSeqs);
    expect(buf.getMetrics().droppedCount).toBe(burst - 10);
  });

  it('ring buffer correctly wraps across multiple fill/drain cycles', () => {
    const buf = new TickBuffer(3, 'drop-oldest');
    // fill, drain, fill again -- exercises head/size wraparound logic
    buf.push(tick('A', 1, 1));
    buf.push(tick('A', 2, 2));
    expect(buf.drain()).toEqual([tick('A', 1, 1), tick('A', 2, 2)]);

    buf.push(tick('A', 3, 3));
    buf.push(tick('A', 4, 4));
    buf.push(tick('A', 5, 5));
    buf.push(tick('A', 6, 6)); // overflows capacity 3, drops seq 3
    const drained = buf.drain() as RawTick[];
    expect(drained.map((t) => t.seq)).toEqual([4, 5, 6]);
  });

  it('does not accumulate droppedCount when never over capacity', () => {
    const buf = new TickBuffer(100, 'drop-oldest');
    for (let i = 1; i <= 50; i++) buf.push(tick('A', i, i));
    expect(buf.getMetrics().droppedCount).toBe(0);
  });
});

describe('TickBuffer - coalesce strategy', () => {
  it('single tick for a symbol produces a pass-through bar (O=H=L=C)', () => {
    const buf = new TickBuffer(4, 'coalesce');
    buf.push(tick('AAPL', 150, 1));
    const drained = buf.drain() as OhlcBar[];
    expect(drained).toHaveLength(1);
    const bar = drained[0];
    expect(bar.symbol).toBe('AAPL');
    expect(bar.open).toBe(150);
    expect(bar.high).toBe(150);
    expect(bar.low).toBe(150);
    expect(bar.close).toBe(150);
    expect(bar.count).toBe(1);
  });

  it('multiple ticks for the same symbol merge into one bar with correct OHLC', () => {
    const buf = new TickBuffer(4, 'coalesce');
    buf.push(tick('AAPL', 100, 1));
    buf.push(tick('AAPL', 105, 2)); // new high
    buf.push(tick('AAPL', 95, 3)); // new low
    buf.push(tick('AAPL', 102, 4)); // final close
    expect(buf.depth).toBe(1); // still just one pending entry for AAPL
    const drained = buf.drain() as OhlcBar[];
    expect(drained).toHaveLength(1);
    const bar = drained[0];
    expect(bar.open).toBe(100); // first tick's price
    expect(bar.high).toBe(105);
    expect(bar.low).toBe(95);
    expect(bar.close).toBe(102); // last tick's price
    expect(bar.count).toBe(4);
  });

  it('tracks coalescedCount as ticks absorbed into an existing bar, not total ticks', () => {
    const buf = new TickBuffer(4, 'coalesce');
    buf.push(tick('AAPL', 100, 1)); // new bar, not coalesced
    buf.push(tick('AAPL', 101, 2)); // coalesced
    buf.push(tick('AAPL', 102, 3)); // coalesced
    expect(buf.getMetrics().coalescedCount).toBe(2);
  });

  it('depth is bounded by distinct symbol count, independent of tick volume', () => {
    const buf = new TickBuffer(4, 'coalesce');
    const symbols = ['AAPL', 'MSFT', 'NVDA'];
    for (let i = 0; i < 10_000; i++) {
      const symbol = symbols[i % symbols.length];
      buf.push(tick(symbol, 100 + i, i));
    }
    // depth should equal the number of distinct symbols seen, not 10,000
    expect(buf.depth).toBe(3);
    const drained = buf.drain() as OhlcBar[];
    expect(drained).toHaveLength(3);
  });

  it('preserves first-updated order across drains', () => {
    const buf = new TickBuffer(4, 'coalesce');
    buf.push(tick('NVDA', 900, 1));
    buf.push(tick('AAPL', 190, 2));
    buf.push(tick('MSFT', 420, 3));
    const drained = buf.drain() as OhlcBar[];
    expect(drained.map((b) => b.symbol)).toEqual(['NVDA', 'AAPL', 'MSFT']);
  });

  it('a fresh bar starts after drain even for a previously-seen symbol', () => {
    const buf = new TickBuffer(4, 'coalesce');
    buf.push(tick('AAPL', 100, 1));
    buf.push(tick('AAPL', 110, 2));
    buf.drain();
    buf.push(tick('AAPL', 200, 3));
    const drained = buf.drain() as OhlcBar[];
    expect(drained).toHaveLength(1);
    expect(drained[0].open).toBe(200);
    expect(drained[0].close).toBe(200);
    expect(drained[0].count).toBe(1);
  });
});

describe('TickBuffer - strategy switching', () => {
  it('switching strategy clears pending (unrendered) data but keeps cumulative counters', () => {
    const buf = new TickBuffer(4, 'drop-oldest');
    buf.push(tick('AAPL', 100, 1));
    buf.push(tick('AAPL', 101, 2));
    expect(buf.depth).toBe(2);

    buf.setStrategy('coalesce');
    expect(buf.depth).toBe(0); // pending raw ticks were cleared, not silently reinterpreted

    buf.push(tick('AAPL', 102, 3));
    buf.push(tick('AAPL', 103, 4));
    const drained = buf.drain() as OhlcBar[];
    expect(drained).toHaveLength(1);
    expect(drained[0].open).toBe(102); // starts fresh, not "100" from before the switch
  });

  it('switching to the same strategy is a no-op (does not clear pending data)', () => {
    const buf = new TickBuffer(4, 'drop-oldest');
    buf.push(tick('AAPL', 100, 1));
    buf.setStrategy('drop-oldest');
    expect(buf.depth).toBe(1);
  });

  it('rapid flapping between strategies never throws and leaves buffer in a valid state', () => {
    const buf = new TickBuffer(4, 'coalesce');
    const strategies: Array<'drop-oldest' | 'coalesce'> = ['drop-oldest', 'coalesce'];
    for (let i = 0; i < 200; i++) {
      buf.setStrategy(strategies[i % 2]);
      buf.push(tick('AAPL', 100 + i, i));
    }
    expect(() => buf.drain()).not.toThrow();
    expect(buf.depth).toBeGreaterThanOrEqual(0);
  });
});

describe('TickBuffer - constructor validation', () => {
  it('throws on zero or negative capacity', () => {
    expect(() => new TickBuffer(0)).toThrow();
    expect(() => new TickBuffer(-1)).toThrow();
  });

  it('defaults to drop-oldest strategy', () => {
    const buf = new TickBuffer(4);
    expect(buf.getStrategy()).toBe('drop-oldest');
  });
});
