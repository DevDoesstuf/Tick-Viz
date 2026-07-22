import { useEffect, useRef } from 'react';

/**
 * Drives `callback` once per animation frame (typically ~60Hz, throttled
 * by the browser to the display's refresh rate and to 0 when the tab is
 * backgrounded).
 *
 * THIS is the other half of the decoupling story alongside TickBuffer:
 * WebSocket `onmessage` fires however often the network delivers data
 * (up to tens of thousands of times/sec in this demo); this hook fires
 * however often the browser wants to paint, completely independently.
 * Ticks get pushed into a TickBuffer as they arrive; this loop pulls
 * (drains) from that buffer once per frame, regardless of how many
 * messages arrived (zero, one, or ten thousand) since the last frame.
 * Network I/O and rendering are never coupled 1:1.
 */
export function useAnimationFrame(callback: (deltaMs: number) => void): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    let rafId = 0;
    let lastTime = performance.now();

    const loop = (time: number) => {
      const delta = time - lastTime;
      lastTime = time;
      callbackRef.current(delta);
      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, []);
}
