import type { LiveMetricsSnapshot } from '../types';

interface MetricsPanelProps {
  metrics: LiveMetricsSnapshot;
}

/**
 * Live dashboard panel, not console.log -- this is what actually lets the
 * backpressure behavior be demoed and explained out loud: incoming vs.
 * rendered rate, current buffer depth against capacity, and running
 * dropped/coalesced totals.
 */
export function MetricsPanel({ metrics }: MetricsPanelProps): JSX.Element {
  const depthRatio = metrics.capacity > 0 ? metrics.depth / metrics.capacity : 0;
  const gaugeCritical = depthRatio > 0.75;
  const backlogged = metrics.incomingTicksPerSec > metrics.renderedFramesPerSec * 50; // rough "network way ahead of render" signal

  return (
    <div>
      <div className="control-title">Live metrics</div>

      <div className="metric-row">
        <span className="metric-label">incoming ticks/sec</span>
        <span className={`metric-value${backlogged ? ' warn' : ''}`}>
          {Math.round(metrics.incomingTicksPerSec).toLocaleString()}
        </span>
      </div>
      <div className="metric-row">
        <span className="metric-label">rendered frames/sec</span>
        <span className="metric-value">{metrics.renderedFramesPerSec.toFixed(1)}</span>
      </div>

      <div className="gauge-wrap">
        <div className="gauge-track">
          <div
            className={`gauge-fill${gaugeCritical ? ' critical' : ''}`}
            style={{ width: `${Math.min(100, depthRatio * 100)}%` }}
          />
        </div>
        <div className="gauge-caption">
          <span>buffer depth</span>
          <span>
            {metrics.depth} / {metrics.capacity}
          </span>
        </div>
      </div>

      <div className="metric-row">
        <span className="metric-label">dropped (cumulative)</span>
        <span className={`metric-value${metrics.droppedCount > 0 ? ' danger' : ''}`}>
          {metrics.droppedCount.toLocaleString()}
        </span>
      </div>
      <div className="metric-row">
        <span className="metric-label">coalesced (cumulative)</span>
        <span className={`metric-value${metrics.coalescedCount > 0 ? ' warn' : ''}`}>
          {metrics.coalescedCount.toLocaleString()}
        </span>
      </div>
      <div className="metric-row">
        <span className="metric-label">strategy</span>
        <span className="metric-value">{metrics.strategy}</span>
      </div>
      <div className="metric-row">
        <span className="metric-label">ingestion</span>
        <span className="metric-value">{metrics.ingestionMode}</span>
      </div>
    </div>
  );
}
