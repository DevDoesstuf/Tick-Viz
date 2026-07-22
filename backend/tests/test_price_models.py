"""
Tests for price_models.py. Deliberately uses stdlib `unittest` (not pytest)
so these tests run with zero third-party dependencies -- pytest can still
discover and run this file fine, but `python -m unittest` alone is enough.
"""
from __future__ import annotations

import math
import random
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.price_models import GbmPriceModel, OuPriceModel  # noqa: E402


class TestGbmPriceModel(unittest.TestCase):
    def test_rejects_non_positive_start_price(self) -> None:
        with self.assertRaises(ValueError):
            GbmPriceModel(start_price=0.0, mu=0.0, sigma=0.1)
        with self.assertRaises(ValueError):
            GbmPriceModel(start_price=-5.0, mu=0.0, sigma=0.1)

    def test_price_stays_strictly_positive_over_many_steps(self) -> None:
        random.seed(42)
        model = GbmPriceModel(start_price=100.0, mu=0.05, sigma=0.9)
        for _ in range(10_000):
            price = model.step(dt=0.001)
            self.assertGreater(price, 0.0)

    def test_zero_dt_is_a_noop(self) -> None:
        model = GbmPriceModel(start_price=50.0, mu=0.2, sigma=0.5)
        price = model.step(dt=0.0)
        self.assertEqual(price, 50.0)

    def test_zero_volatility_is_deterministic_drift(self) -> None:
        # With sigma=0, the diffusion term vanishes regardless of the drawn
        # random Z, so the result must be exactly the deterministic drift
        # term -- no seeding required for this to be reproducible.
        model = GbmPriceModel(start_price=100.0, mu=0.1, sigma=0.0)
        price = model.step(dt=2.0)
        expected = 100.0 * math.exp(0.1 * 2.0)
        self.assertAlmostEqual(price, expected, places=9)


class TestOuPriceModel(unittest.TestCase):
    def test_rejects_non_positive_theta(self) -> None:
        with self.assertRaises(ValueError):
            OuPriceModel(start_price=100.0, theta=0.0, sigma=0.1)

    def test_zero_dt_is_a_noop(self) -> None:
        model = OuPriceModel(start_price=42.0, theta=2.0, sigma=1.0)
        price = model.step(dt=0.0)
        self.assertEqual(price, 42.0)

    def test_reverts_toward_mean_on_average(self) -> None:
        random.seed(7)
        model = OuPriceModel(start_price=200.0, theta=5.0, sigma=0.1, long_term_mean=100.0)
        prices = [model.step(dt=0.01) for _ in range(5_000)]
        tail_avg = sum(prices[-500:]) / 500
        self.assertLess(abs(tail_avg - 100.0), 5.0)

    def test_stationary_variance_matches_theory(self) -> None:
        random.seed(123)
        theta, sigma = 3.0, 1.0
        model = OuPriceModel(start_price=0.0, theta=theta, sigma=sigma, long_term_mean=0.0)
        samples = [model.step(dt=0.05) for _ in range(20_000)]
        tail = samples[5_000:]  # discard burn-in before process reaches stationarity
        tail_mean = sum(tail) / len(tail)
        empirical_var = sum((x - tail_mean) ** 2 for x in tail) / len(tail)
        theoretical_var = (sigma ** 2) / (2 * theta)
        relative_error = abs(empirical_var - theoretical_var) / theoretical_var
        self.assertLess(relative_error, 0.2)

    def test_correct_at_large_and_small_dt_alike(self) -> None:
        # Regression guard for the "exact solution vs Euler-Maruyama" claim
        # in the module docstring: run the same model at a very small dt
        # and a much larger dt for the same total elapsed time, and check
        # the resulting distributions have comparable variance. A naive
        # Euler discretization would show dt-dependent bias here.
        theta, sigma, total_time = 4.0, 0.8, 50.0

        def run(dt: float, seed: int) -> float:
            random.seed(seed)
            model = OuPriceModel(start_price=10.0, theta=theta, sigma=sigma, long_term_mean=10.0)
            steps = int(total_time / dt)
            samples = [model.step(dt=dt) for _ in range(steps)]
            tail = samples[len(samples) // 2:]
            mean = sum(tail) / len(tail)
            return sum((x - mean) ** 2 for x in tail) / len(tail)

        var_small_dt = run(dt=0.01, seed=1)
        var_large_dt = run(dt=0.5, seed=2)
        theoretical_var = (sigma ** 2) / (2 * theta)

        self.assertLess(abs(var_small_dt - theoretical_var) / theoretical_var, 0.25)
        self.assertLess(abs(var_large_dt - theoretical_var) / theoretical_var, 0.25)


if __name__ == "__main__":
    unittest.main()
