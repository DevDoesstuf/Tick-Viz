"""
Tests for simulator.py. Uses stdlib unittest.IsolatedAsyncioTestCase for the
asyncio-driven scheduler tests -- no pytest-asyncio dependency required.
"""
from __future__ import annotations

import asyncio
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.config import SymbolConfig  # noqa: E402
from app.simulator import TickSimulator  # noqa: E402


class TestBatchSizeAccumulator(unittest.TestCase):
    """The fractional-remainder accumulator is the correctness-critical bit
    here (analogous to "get the rounding right in a matching engine"): if
    it's wrong, configured rate silently doesn't match delivered rate."""

    def test_average_rate_matches_over_many_periods(self) -> None:
        sim = TickSimulator([SymbolConfig("X", "gbm", 100.0)], broadcast_fn=_noop_broadcast)
        sim.set_rate(333)
        dt = 0.01
        periods = 1000
        total = sum(sim._next_batch_size(dt) for _ in range(periods))
        expected = 333 * dt * periods
        # Accumulator should track the true rate to within a single tick
        # over a long run, not drift with floor()-per-period error.
        self.assertAlmostEqual(total, expected, delta=1)

    def test_never_emits_negative_or_fractional_ticks(self) -> None:
        sim = TickSimulator([SymbolConfig("X", "gbm", 100.0)], broadcast_fn=_noop_broadcast)
        sim.set_rate(50_000)
        for _ in range(500):
            n = sim._next_batch_size(0.01)
            self.assertIsInstance(n, int)
            self.assertGreaterEqual(n, 0)

    def test_low_rate_mostly_emits_zero_per_period_but_averages_correctly(self) -> None:
        sim = TickSimulator([SymbolConfig("X", "gbm", 100.0)], broadcast_fn=_noop_broadcast)
        sim.set_rate(1)  # 1 tick/sec, but scheduler wakes up 100x/sec
        outputs = [sim._next_batch_size(0.01) for _ in range(1000)]  # 10 simulated seconds
        self.assertEqual(sum(outputs), 10)
        self.assertGreater(outputs.count(0), 900)  # overwhelming majority of periods emit nothing

    def test_rate_is_clamped_to_configured_bounds(self) -> None:
        sim = TickSimulator([SymbolConfig("X", "gbm", 100.0)], broadcast_fn=_noop_broadcast)
        sim.set_rate(-5)
        self.assertGreaterEqual(sim.rate, 1)
        sim.set_rate(10_000_000)
        self.assertLessEqual(sim.rate, 100_000)


class TestSimulatorRun(unittest.IsolatedAsyncioTestCase):
    async def test_emits_expected_volume_over_time(self) -> None:
        received: list[dict] = []

        async def fake_broadcast(msg: str) -> None:
            received.append(json.loads(msg))

        sim = TickSimulator(
            [SymbolConfig("X", "gbm", 100.0), SymbolConfig("Y", "ou", 50.0, theta=2.0, sigma=0.1)],
            broadcast_fn=fake_broadcast,
        )
        sim.set_rate(1000)
        sim.start()
        await asyncio.sleep(0.5)
        await sim.stop()

        total_ticks = sum(len(m["ticks"]) for m in received)
        # 1000/sec * 0.5s = 500 expected; generous tolerance for CI/scheduler jitter.
        self.assertGreater(total_ticks, 250)
        self.assertLess(total_ticks, 900)

    async def test_each_tick_has_well_formed_fields(self) -> None:
        received: list[dict] = []

        async def fake_broadcast(msg: str) -> None:
            received.append(json.loads(msg))

        sim = TickSimulator([SymbolConfig("X", "gbm", 100.0)], broadcast_fn=fake_broadcast)
        sim.set_rate(2000)
        sim.start()
        await asyncio.sleep(0.1)
        await sim.stop()

        all_ticks = [t for m in received for t in m["ticks"]]
        self.assertGreater(len(all_ticks), 0)
        for t in all_ticks:
            self.assertEqual(t["symbol"], "X")
            self.assertIsInstance(t["price"], (int, float))
            self.assertGreater(t["price"], 0)
            self.assertIsInstance(t["seq"], int)

        # seq numbers for a single symbol must be strictly increasing
        seqs = [t["seq"] for t in all_ticks]
        self.assertEqual(seqs, sorted(seqs))
        self.assertEqual(len(seqs), len(set(seqs)))

    async def test_stop_is_clean_and_idempotent(self) -> None:
        sim = TickSimulator([SymbolConfig("X", "gbm", 100.0)], broadcast_fn=_noop_broadcast)
        sim.start()
        await asyncio.sleep(0.05)
        await sim.stop()
        await sim.stop()  # must not raise on a second call

    async def test_rejects_empty_symbol_list(self) -> None:
        with self.assertRaises(ValueError):
            TickSimulator([], broadcast_fn=_noop_broadcast)


async def _noop_broadcast(_message: str) -> None:
    return None


if __name__ == "__main__":
    unittest.main()
