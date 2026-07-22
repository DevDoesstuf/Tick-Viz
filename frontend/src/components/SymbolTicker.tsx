interface SymbolTickerProps {
  symbols: string[];
  prices: Map<string, { price: number; direction: 'up' | 'down' | 'flat' }>;
  selected: string;
  onSelect: (symbol: string) => void;
}

/**
 * Deliberately updated from throttled React state (see App.tsx), not from
 * the 60fps render loop directly -- twelve text nodes re-rendering at full
 * tick rate would be pure waste; a human can't read numbers changing
 * faster than a few times a second anyway. The canvas chart is the only
 * part of this UI that needs true per-frame updates.
 */
export function SymbolTicker({ symbols, prices, selected, onSelect }: SymbolTickerProps): JSX.Element {
  return (
    <div className="ticker-list">
      {symbols.map((symbol) => {
        const entry = prices.get(symbol);
        return (
          <div
            key={symbol}
            className={`ticker-row${symbol === selected ? ' selected' : ''}`}
            onClick={() => onSelect(symbol)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') onSelect(symbol);
            }}
          >
            <span className="ticker-symbol">{symbol}</span>
            <span className={`ticker-price ${entry?.direction ?? 'flat'}`}>
              {entry ? entry.price.toFixed(2) : '--'}
            </span>
          </div>
        );
      })}
    </div>
  );
}
