import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RateCounter } from './MetricsTracker';

describe('RateCounter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports 0 before any ticks', () => {
    const counter = new RateCounter();
    expect(counter.currentRate()).toBe(0);
  });

  it('computes rate close to actual after a full 1s window', () => {
    const counter = new RateCounter();
    const start = performance.now();
    for (let i = 0; i < 1000; i++) {
      counter.tick();
    }
    vi.setSystemTime(new Date(start + 1000));
    // one more tick to trigger the window-close check
    counter.tick();
    const rate = counter.currentRate();
    expect(rate).toBeGreaterThan(500);
  });

  it('reset() clears accumulated state', () => {
    const counter = new RateCounter();
    for (let i = 0; i < 100; i++) counter.tick();
    counter.reset();
    expect(counter.currentRate()).toBe(0);
  });

  it('tick(count) supports batched increments, not just count=1', () => {
    const counter = new RateCounter();
    counter.tick(500);
    // internal state should reflect the batch; we can't access private
    // fields directly, but currentRate should be non-zero immediately
    // after some elapsed time even from a single batched call once the
    // window's provisional estimate kicks in.
    vi.advanceTimersByTime(60);
    expect(counter.currentRate()).toBeGreaterThan(0);
  });
});
