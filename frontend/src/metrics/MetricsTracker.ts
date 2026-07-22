/**
 * Tracks two independent rates using a simple rolling 1-second counter
 * reset (not a full sliding window / histogram -- overkill for a demo
 * dashboard, and this is cheap enough to update on every single tick or
 * frame without itself becoming a performance problem):
 *
 *  - incoming ticks/sec: how fast the network is actually delivering ticks
 *  - rendered frames/sec: how fast the canvas is actually painting
 *
 * These two numbers are the entire point of the dashboard: when incoming
 * ticks/sec vastly outpaces rendered frames/sec, that gap *is* the
 * backpressure problem this project demonstrates, and switching strategy
 * should visibly change buffer depth / dropped / coalesced counts without
 * ever tanking rendered fps.
 */
export class RateCounter {
  private countSinceWindowStart = 0;
  private windowStart = performance.now();
  private lastRate = 0;

  /** Call once per event (one incoming tick, or one rendered frame). */
  tick(count = 1): void {
    this.countSinceWindowStart += count;
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed >= 1000) {
      this.lastRate = (this.countSinceWindowStart * 1000) / elapsed;
      this.countSinceWindowStart = 0;
      this.windowStart = now;
    }
  }

  /** Current best estimate of rate/sec, without waiting for a full window
   * to close (avoids the UI looking frozen for up to a second after a
   * rate change). */
  currentRate(): number {
    const now = performance.now();
    const elapsed = now - this.windowStart;
    if (elapsed < 50) return this.lastRate; // avoid dividing by ~0 right after a reset
    const provisional = (this.countSinceWindowStart * 1000) / elapsed;
    // Blend provisional (this partial window) with the last full window so
    // the number doesn't jitter wildly frame-to-frame.
    return this.lastRate === 0 ? provisional : this.lastRate * 0.5 + provisional * 0.5;
  }

  reset(): void {
    this.countSinceWindowStart = 0;
    this.windowStart = performance.now();
    this.lastRate = 0;
  }
}
