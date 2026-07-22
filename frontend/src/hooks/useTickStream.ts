import { useEffect, useRef } from 'react';
import { MainThreadIngestion } from '../ingestion/MainThreadIngestion';
import { WorkerIngestion } from '../ingestion/WorkerIngestion';
import type { BackpressureStrategy, BufferMetricsSnapshot, OhlcBar, RawTick } from '../types';

export type IngestionMode = 'main-thread' | 'worker';

interface IngestionController {
  connect(url: string): void;
  disconnect(): void;
  setStrategy(strategy: BackpressureStrategy): void;
  drainFrame(): RawTick[] | OhlcBar[];
  getBufferMetrics(): BufferMetricsSnapshot;
  getIncomingRate(): number;
  readonly connected: boolean;
}

interface UseTickStreamArgs {
  wsUrl: string;
  capacity: number;
  strategy: BackpressureStrategy;
  ingestionMode: IngestionMode;
}

/**
 * Owns the currently-active ingestion controller (main-thread or worker)
 * and rebuilds it whenever `ingestionMode` or `capacity` changes (those
 * require a fresh buffer/worker; strategy alone can change on the fly
 * without reconnecting -- see TickBuffer.setStrategy).
 *
 * Returns a ref to the controller so the render loop (TickChart) can call
 * `drainFrame()` imperatively on every rAF tick without going through
 * React state/re-renders -- state updates at 50,000 ticks/sec would
 * themselves be a performance problem this project is explicitly trying
 * to avoid.
 */
export function useTickStream({ wsUrl, capacity, strategy, ingestionMode }: UseTickStreamArgs): React.MutableRefObject<IngestionController | null> {
  const controllerRef = useRef<IngestionController | null>(null);
  const strategyRef = useRef(strategy);
  strategyRef.current = strategy;

  useEffect(() => {
    const controller: IngestionController =
      ingestionMode === 'worker'
        ? new WorkerIngestion(capacity, strategyRef.current)
        : new MainThreadIngestion(capacity, strategyRef.current);
    controller.connect(wsUrl);
    controllerRef.current = controller;

    return () => {
      controller.disconnect();
      if (controller instanceof WorkerIngestion) controller.terminate();
      controllerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl, capacity, ingestionMode]);

  useEffect(() => {
    controllerRef.current?.setStrategy(strategy);
  }, [strategy]);

  return controllerRef;
}
