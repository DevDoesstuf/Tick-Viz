import { useEffect, useRef, type MutableRefObject } from 'react';
import { useAnimationFrame } from '../hooks/useAnimationFrame';
import type { OhlcBar, RawTick } from '../types';

interface ChartPoint {
  price: number;
  high: number;
  low: number;
  isBar: boolean; // true if this point represents a coalesced OHLC bar spanning >1 tick (draw a wick)
}

const MAX_VISIBLE_POINTS = 300;

interface IngestionLike {
  drainFrame(): RawTick[] | OhlcBar[];
}

interface TickChartProps {
  selectedSymbol: string;
  controllerRef: MutableRefObject<IngestionLike | null>;
  /** Called once per rendered frame with every drained item (all symbols,
   * not just the selected one) -- lets the parent keep the full ticker
   * sidebar's last-known price up to date without a second drain call. */
  onItemsDrained: (items: (RawTick | OhlcBar)[]) => void;
  /** Called once per rAF tick, independent of how much data was in that
   * frame -- this is exactly what "rendered frames/sec" measures. */
  onFrameRendered: () => void;
}

function isOhlcBar(item: RawTick | OhlcBar): item is OhlcBar {
  return (item as OhlcBar).open !== undefined;
}

/**
 * Canvas (not a charting library) so the render loop, coordinate mapping,
 * and per-frame redraw cost are all explicit and directly reasoned about.
 * The whole point of this project is being able to say exactly what work
 * happens on every frame; a chart library's internal render pipeline would
 * hide that.
 *
 * THE DECOUPLING, CONCRETELY: this component's useAnimationFrame callback
 * is the *only* place `drainFrame()` gets called from the render path. It
 * fires once per rAF tick (browser-paced, ~60Hz, paused when backgrounded)
 * -- never once per WebSocket message, never once per tick. Whatever
 * arrived on the network since the last frame (zero items, or ten
 * thousand) is drained and drawn in exactly one pass here.
 */
export function TickChart({ selectedSymbol, controllerRef, onItemsDrained, onFrameRendered }: TickChartProps): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const pointsRef = useRef<ChartPoint[]>([]);

  // Selected symbol changed: start its series fresh rather than showing a
  // misleading continuation from a different instrument's price level.
  useEffect(() => {
    pointsRef.current = [];
  }, [selectedSymbol]);

  useAnimationFrame(() => {
    const controller = controllerRef.current;
    if (!controller) return;

    const items = controller.drainFrame();
    onFrameRendered();
    if (items.length > 0) onItemsDrained(items);

    for (const item of items) {
      if (item.symbol !== selectedSymbol) continue;
      if (isOhlcBar(item)) {
        pointsRef.current.push({ price: item.close, high: item.high, low: item.low, isBar: item.count > 1 });
      } else {
        pointsRef.current.push({ price: item.price, high: item.price, low: item.price, isBar: false });
      }
    }
    if (pointsRef.current.length > MAX_VISIBLE_POINTS) {
      pointsRef.current.splice(0, pointsRef.current.length - MAX_VISIBLE_POINTS);
    }

    const canvas = canvasRef.current;
    if (canvas) draw(canvas, pointsRef.current);
  });

  return (
    <div className="chart-canvas-wrap">
      <canvas ref={canvasRef} />
    </div>
  );
}

function draw(canvas: HTMLCanvasElement, points: ChartPoint[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  if (points.length === 0) {
    ctx.fillStyle = '#4c5566';
    ctx.font = '12px "IBM Plex Mono", monospace';
    ctx.fillText('waiting for ticks...', 16, 24);
    return;
  }

  const padding = { top: 16, right: 12, bottom: 16, left: 12 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;

  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.low < min) min = p.low;
    if (p.high > max) max = p.high;
  }
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const span = max - min;
  const yPad = span * 0.1;
  min -= yPad;
  max += yPad;

  const xStep = points.length > 1 ? plotW / (points.length - 1) : 0;
  const yFor = (price: number) => padding.top + plotH * (1 - (price - min) / (max - min));
  const xFor = (i: number) => padding.left + i * xStep;

  // gridlines
  ctx.strokeStyle = '#1c2430';
  ctx.lineWidth = 1;
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + (plotH * i) / gridLines;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  // price line
  ctx.strokeStyle = '#52c3e8';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xFor(i);
    const y = yFor(p.price);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // Coalesced-bar wicks: a vertical line from low to high wherever this
  // point represents multiple merged ticks. Makes coalescing *visible* on
  // the chart itself -- not just a counter in the metrics panel -- since
  // it shows the intra-bar spread (volatility that would otherwise be
  // invisible) at each rendered point.
  ctx.strokeStyle = '#f0a868';
  ctx.lineWidth = 2;
  points.forEach((p, i) => {
    if (!p.isBar) return;
    const x = xFor(i);
    ctx.beginPath();
    ctx.moveTo(x, yFor(p.high));
    ctx.lineTo(x, yFor(p.low));
    ctx.stroke();
  });

  // latest point marker
  const last = points[points.length - 1];
  const lastX = xFor(points.length - 1);
  const lastY = yFor(last.price);
  ctx.fillStyle = '#3ddc97';
  ctx.beginPath();
  ctx.arc(lastX, lastY, 3, 0, Math.PI * 2);
  ctx.fill();
}
