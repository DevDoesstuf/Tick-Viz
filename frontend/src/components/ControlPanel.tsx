import type { BackpressureStrategy } from '../types';
import type { IngestionMode } from '../hooks/useTickStream';

const MIN_RATE = 1;
const MAX_RATE = 100_000;
const SLIDER_MAX = 1000;

// Log-scale mapping: tick rate spans 5 orders of magnitude (1 -> 100,000),
// so a linear slider would waste most of its range on rates nobody wants
// to demo at (a linear slider putting "50,000" at 50% would make "100" and
// "1,000" indistinguishable at the low end). Log scale gives every decade
// (1-10, 10-100, ... 10k-100k) roughly equal slider real estate.
function sliderToRate(sliderValue: number): number {
  const t = sliderValue / SLIDER_MAX;
  const logMin = Math.log(MIN_RATE);
  const logMax = Math.log(MAX_RATE);
  return Math.round(Math.exp(logMin + t * (logMax - logMin)));
}

function rateToSlider(rate: number): number {
  const clamped = Math.max(MIN_RATE, Math.min(MAX_RATE, rate));
  const logMin = Math.log(MIN_RATE);
  const logMax = Math.log(MAX_RATE);
  const t = (Math.log(clamped) - logMin) / (logMax - logMin);
  return Math.round(t * SLIDER_MAX);
}

const PRESETS: { label: string; rate: number; stress?: boolean }[] = [
  { label: '100', rate: 100 },
  { label: '1K', rate: 1_000 },
  { label: '10K', rate: 10_000 },
  { label: '50K', rate: 50_000, stress: true },
  { label: '100K', rate: 100_000, stress: true },
];

interface ControlPanelProps {
  rate: number;
  onRateChange: (rate: number) => void;
  strategy: BackpressureStrategy;
  onStrategyChange: (strategy: BackpressureStrategy) => void;
  ingestionMode: IngestionMode;
  onIngestionModeChange: (mode: IngestionMode) => void;
}

export function ControlPanel({
  rate,
  onRateChange,
  strategy,
  onStrategyChange,
  ingestionMode,
  onIngestionModeChange,
}: ControlPanelProps): JSX.Element {
  return (
    <div>
      <div className="control-group">
        <div className="control-title">Simulated tick rate</div>
        <div className="rate-readout">
          {rate.toLocaleString()}
          <span className="unit">ticks/sec</span>
        </div>
        <input
          type="range"
          min={0}
          max={SLIDER_MAX}
          value={rateToSlider(rate)}
          onChange={(e) => onRateChange(sliderToRate(Number(e.target.value)))}
          aria-label="Simulated tick rate"
        />
        <div className="preset-row">
          {PRESETS.map((p) => (
            <button
              key={p.label}
              className={`preset-btn${p.stress ? ' stress' : ''}`}
              onClick={() => onRateChange(p.rate)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="control-group">
        <div className="control-title">Backpressure strategy</div>
        <div className="toggle-row">
          <button
            className={`toggle-option${strategy === 'drop-oldest' ? ' active' : ''}`}
            onClick={() => onStrategyChange('drop-oldest')}
          >
            Drop-oldest
          </button>
          <button
            className={`toggle-option${strategy === 'coalesce' ? ' active strategy-coalesce' : ''}`}
            onClick={() => onStrategyChange('coalesce')}
          >
            Coalesce
          </button>
        </div>
      </div>

      <div className="control-group">
        <div className="control-title">Ingestion mode</div>
        <div className="toggle-row">
          <button
            className={`toggle-option${ingestionMode === 'main-thread' ? ' active' : ''}`}
            onClick={() => onIngestionModeChange('main-thread')}
          >
            Main thread
          </button>
          <button
            className={`toggle-option${ingestionMode === 'worker' ? ' active' : ''}`}
            onClick={() => onIngestionModeChange('worker')}
          >
            Web worker
          </button>
        </div>
      </div>
    </div>
  );
}
