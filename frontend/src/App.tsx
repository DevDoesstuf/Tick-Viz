import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './styles.css';
import { fetchSymbols, setServerTickRate, WS_URL } from './api';
import { ControlPanel } from './components/ControlPanel';
import { MetricsPanel } from './components/MetricsPanel';
import { SymbolTicker } from './components/SymbolTicker';
import { TickChart } from './components/TickChart';
import { useTickStream, type IngestionMode } from './hooks/useTickStream';
import { RateCounter } from './metrics/MetricsTracker';
import type { BackpressureStrategy, LiveMetricsSnapshot, OhlcBar, RawTick } from './types';

const FALLBACK_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'TSLA', 'GOOG', 'AMZN', 'RTYF', 'NDXF', 'SPYF', 'BTCF', 'XAUF', 'VOLX'];

// Buffer capacity for drop-oldest mode (how many raw ticks it can hold
// before overwriting the oldest). Coalesce mode's effective size is
// bounded by symbol count regardless of this number -- see TickBuffer.
const BUFFER_CAPACITY = 2_000;

// How often the UI polls buffer/rate metrics for the dashboard, and how
// often the sidebar's displayed prices refresh. Deliberately *not* tied to
// the render loop: a human can't usefully read numbers changing 60x/sec,
// and re-rendering React state at that rate would itself be wasted work.
const METRICS_POLL_MS = 200;

interface PriceEntry {
  price: number;
  direction: 'up' | 'down' | 'flat';
}

export default function App(): JSX.Element {
  const [symbols, setSymbols] = useState<string[]>(FALLBACK_SYMBOLS);
  const [selectedSymbol, setSelectedSymbol] = useState<string>(FALLBACK_SYMBOLS[0]);
  const [rate, setRate] = useState(500);
  const [strategy, setStrategy] = useState<BackpressureStrategy>('drop-oldest');
  const [ingestionMode, setIngestionMode] = useState<IngestionMode>('main-thread');
  const [displayPrices, setDisplayPrices] = useState<Map<string, PriceEntry>>(new Map());
  const [liveMetrics, setLiveMetrics] = useState<LiveMetricsSnapshot>({
    depth: 0,
    capacity: BUFFER_CAPACITY,
    droppedCount: 0,
    coalescedCount: 0,
    incomingTicksPerSec: 0,
    renderedFramesPerSec: 0,
    strategy: 'drop-oldest',
    ingestionMode: 'main-thread',
    connected: false,
  });

  const latestPricesRef = useRef<Map<string, PriceEntry>>(new Map());
  const renderedFpsRef = useRef(new RateCounter());

  useEffect(() => {
    fetchSymbols().then((fetched) => {
      if (fetched.length > 0) {
        setSymbols(fetched);
        setSelectedSymbol((current) => (fetched.includes(current) ? current : fetched[0]));
      }
    });
  }, []);

  const controllerRef = useTickStream({
    wsUrl: WS_URL,
    capacity: BUFFER_CAPACITY,
    strategy,
    ingestionMode,
  });

  const handleRateChange = useCallback((newRate: number) => {
    setRate(newRate);
    void setServerTickRate(newRate);
  }, []);

  const handleItemsDrained = useCallback((items: (RawTick | OhlcBar)[]) => {
    for (const item of items) {
      const price = 'close' in item ? item.close : item.price;
      const prev = latestPricesRef.current.get(item.symbol)?.price;
      const direction: PriceEntry['direction'] = prev === undefined || price === prev ? 'flat' : price > prev ? 'up' : 'down';
      latestPricesRef.current.set(item.symbol, { price, direction });
    }
  }, []);

  const handleFrameRendered = useCallback(() => {
    renderedFpsRef.current.tick();
  }, []);

  // Poll for dashboard updates at a human-readable rate, independent of
  // the 60fps render loop and the potentially 50,000/sec tick rate.
  useEffect(() => {
    const interval = setInterval(() => {
      setDisplayPrices(new Map(latestPricesRef.current));
      const controller = controllerRef.current;
      const bufferMetrics = controller?.getBufferMetrics() ?? { depth: 0, capacity: BUFFER_CAPACITY, droppedCount: 0, coalescedCount: 0 };
      setLiveMetrics({
        ...bufferMetrics,
        incomingTicksPerSec: controller?.getIncomingRate() ?? 0,
        renderedFramesPerSec: renderedFpsRef.current.currentRate(),
        strategy,
        ingestionMode,
        connected: controller?.connected ?? false,
      });
    }, METRICS_POLL_MS);
    return () => clearInterval(interval);
  }, [controllerRef, strategy, ingestionMode]);

  const tickerPrices = useMemo(() => displayPrices, [displayPrices]);
  const selectedPrice = tickerPrices.get(selectedSymbol);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          <span className="glyph">◆</span> tick-viz
        </div>
        <div className="connection-pill">
          <span className={`status-dot${liveMetrics.connected ? ' live' : ''}`} />
          {liveMetrics.connected ? 'streaming' : 'disconnected'}
        </div>
      </header>

      <div className="app-body">
        <div className="panel">
          <div className="panel-label">Symbols</div>
          <SymbolTicker symbols={symbols} prices={tickerPrices} selected={selectedSymbol} onSelect={setSelectedSymbol} />
        </div>

        <div className="chart-area">
          <div className="chart-header">
            <span className="chart-symbol">{selectedSymbol}</span>
            <span
              className="chart-price"
              style={{
                color:
                  selectedPrice?.direction === 'up'
                    ? 'var(--signal-up)'
                    : selectedPrice?.direction === 'down'
                      ? 'var(--signal-down)'
                      : 'var(--text-dim)',
              }}
            >
              {selectedPrice ? selectedPrice.price.toFixed(2) : '--'}
            </span>
          </div>
          <TickChart
            selectedSymbol={selectedSymbol}
            controllerRef={controllerRef}
            onItemsDrained={handleItemsDrained}
            onFrameRendered={handleFrameRendered}
          />
        </div>

        <div className="panel">
          <ControlPanel
            rate={rate}
            onRateChange={handleRateChange}
            strategy={strategy}
            onStrategyChange={setStrategy}
            ingestionMode={ingestionMode}
            onIngestionModeChange={setIngestionMode}
          />
          <div className="control-group">
            <MetricsPanel metrics={liveMetrics} />
          </div>
        </div>
      </div>
    </div>
  );
}
