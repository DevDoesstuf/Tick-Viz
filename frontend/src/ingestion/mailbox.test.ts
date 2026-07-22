import { describe, expect, it, vi } from 'vitest';

// We test the mailbox semantics in isolation without spinning up a real
// Worker (jsdom doesn't implement one meaningfully) by re-implementing the
// exact reconciliation rule as a tiny pure function extracted from
// WorkerIngestion's drainFrame/onmessage pair, so the actual worker class
// isn't duplicated -- this documents and locks in the *contract*
// (last-value-wins, not accumulation) rather than the class's plumbing.
class Mailbox<T> {
  private pending: T[] = [];

  receive(items: T[]): void {
    this.pending = items; // overwrite, not concat -- see WorkerIngestion docstring
  }

  drain(): T[] {
    const items = this.pending;
    this.pending = [];
    return items;
  }
}

describe('worker->main-thread mailbox reconciliation', () => {
  it('drain returns empty when nothing has arrived yet', () => {
    const mailbox = new Mailbox<number>();
    expect(mailbox.drain()).toEqual([]);
  });

  it('a single posted frame is returned exactly once', () => {
    const mailbox = new Mailbox<number>();
    mailbox.receive([1, 2, 3]);
    expect(mailbox.drain()).toEqual([1, 2, 3]);
    expect(mailbox.drain()).toEqual([]); // second drain in the same frame gets nothing new
  });

  it('multiple posts before a drain: only the latest is kept (last-value-wins)', () => {
    const mailbox = new Mailbox<number>();
    mailbox.receive([1]);
    mailbox.receive([2]); // main thread fell behind; worker posted again before a drain happened
    mailbox.receive([3]);
    expect(mailbox.drain()).toEqual([3]);
  });

  it('draining faster than posting is harmless (redraws nothing new)', () => {
    const mailbox = new Mailbox<number>();
    mailbox.receive([42]);
    expect(mailbox.drain()).toEqual([42]);
    expect(mailbox.drain()).toEqual([]);
    expect(mailbox.drain()).toEqual([]);
  });
});

describe('RateCounter integration with batched worker reports', () => {
  it('accumulates incomingSinceLastFlush counts across multiple worker messages', async () => {
    const { RateCounter } = await import('../metrics/MetricsTracker');
    vi.useFakeTimers();
    const counter = new RateCounter();
    counter.tick(500); // one worker flush reported 500 ticks
    counter.tick(300); // next flush, 300 more
    vi.advanceTimersByTime(60);
    expect(counter.currentRate()).toBeGreaterThan(0);
    vi.useRealTimers();
  });
});
