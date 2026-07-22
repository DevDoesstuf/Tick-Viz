"""
Wire types for tick data.

Plain `@dataclass(slots=True)` rather than pydantic `BaseModel`: this type
is constructed up to 50,000 times per second on the hot path, and pydantic's
validation overhead (even with fastapi's models, not raw dicts) is real CPU
cost that we don't want to pay per-tick. Validation happens once, at the
edges (REST control endpoints), not on every simulated price update.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(slots=True)
class Tick:
    symbol: str
    price: float
    ts: float  # milliseconds since epoch, float (sub-millisecond precision)
    seq: int   # per-symbol monotonic sequence number, lets a client detect gaps

    def to_dict(self) -> dict[str, float | str | int]:
        return {"symbol": self.symbol, "price": self.price, "ts": self.ts, "seq": self.seq}
