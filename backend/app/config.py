"""
Central configuration for the tick simulator.

Kept as plain module-level dataclasses/constants rather than env-driven
settings, since this is a demo service where the "config surface" itself
isn't the point. In a production system this would be a typed settings
object (e.g. pydantic-settings) sourced from env vars / a config service.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SymbolConfig:
    symbol: str
    model: str  # "gbm" (geometric brownian motion) or "ou" (Ornstein-Uhlenbeck, mean-reverting)
    start_price: float
    # GBM params (used when model == "gbm")
    mu: float = 0.0       # annualized drift
    sigma: float = 0.4    # annualized volatility
    # OU params (used when model == "ou")
    theta: float = 2.0    # mean reversion speed
    long_term_mean: float | None = None  # defaults to start_price if None


# 12 fake symbols, deliberately mixing both price models so the demo shows
# both a trending/volatile instrument (GBM) and a range-bound one (OU)
# streaming side by side.
DEFAULT_SYMBOLS: list[SymbolConfig] = [
    SymbolConfig("AAPL", "gbm", 190.0, mu=0.05, sigma=0.25),
    SymbolConfig("MSFT", "gbm", 420.0, mu=0.03, sigma=0.22),
    SymbolConfig("NVDA", "gbm", 900.0, mu=0.10, sigma=0.55),
    SymbolConfig("TSLA", "gbm", 250.0, mu=0.00, sigma=0.65),
    SymbolConfig("GOOG", "gbm", 175.0, mu=0.04, sigma=0.28),
    SymbolConfig("AMZN", "gbm", 185.0, mu=0.04, sigma=0.30),
    SymbolConfig("RTYF", "gbm", 2200.0, mu=0.02, sigma=0.35),
    SymbolConfig("NDXF", "gbm", 20000.0, mu=0.06, sigma=0.30),
    SymbolConfig("SPYF", "ou", 550.0, theta=3.0, sigma=0.12),
    SymbolConfig("BTCF", "ou", 65000.0, theta=1.5, sigma=0.50),
    SymbolConfig("XAUF", "ou", 2400.0, theta=2.5, sigma=0.15),
    SymbolConfig("VOLX", "ou", 18.0, theta=4.0, sigma=0.90),
]

# How often (seconds) the simulator scheduler wakes up to decide how many
# ticks to emit and flush a single batched WS message. See simulator.py's
# module docstring for why batching -- not a per-tick asyncio.sleep -- is
# the right design once tick rate gets high.
SCHEDULER_INTERVAL_SECONDS = 0.01  # 100 Hz -> 10ms latency floor per batch

MIN_TICK_RATE = 1
MAX_TICK_RATE = 100_000
DEFAULT_TICK_RATE = 500

# Bound on each connected client's outbound queue (server-side
# backpressure -- see connection_manager.py).
CLIENT_QUEUE_MAXSIZE = 2000
