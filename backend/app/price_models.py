"""
Stochastic price models used to drive the fake tick stream.

Both models are stepped with the *exact* transition distribution for their
SDE (not a naive Euler-Maruyama discretization). This matters for
correctness: Euler-Maruyama accumulates discretization error that grows
with dt, so behavior would visibly depend on how often you happen to call
`step()` -- an artifact you do not want in a simulator whose whole point is
being driven at wildly different tick rates (1/sec up to 50,000/sec, i.e.
dt spanning several orders of magnitude). The exact solutions used below
are correct at any dt.
"""
from __future__ import annotations

import math
import random


class GbmPriceModel:
    """Geometric Brownian Motion: dS = mu*S*dt + sigma*S*dW.

    Exact log-normal step:
        S_{t+dt} = S_t * exp((mu - 0.5*sigma^2)*dt + sigma*sqrt(dt)*Z),  Z ~ N(0,1)

    This is the exact solution of the SDE (not an approximation), and it
    guarantees price stays strictly positive.
    """

    __slots__ = ("price", "mu", "sigma")

    def __init__(self, start_price: float, mu: float = 0.0, sigma: float = 0.4) -> None:
        if start_price <= 0:
            raise ValueError("start_price must be > 0 for GBM")
        self.price = start_price
        self.mu = mu
        self.sigma = sigma

    def step(self, dt: float) -> float:
        if dt <= 0:
            return self.price
        z = random.gauss(0.0, 1.0)
        drift = (self.mu - 0.5 * self.sigma * self.sigma) * dt
        diffusion = self.sigma * math.sqrt(dt) * z
        self.price *= math.exp(drift + diffusion)
        return self.price


class OuPriceModel:
    """Ornstein-Uhlenbeck mean-reverting process: dx = theta*(mu - x)*dt + sigma*dW.

    Exact transition (conditional on x_t, x_{t+dt} is Gaussian):
        x_{t+dt} = mu + (x_t - mu)*e^{-theta*dt}
                   + sigma * sqrt((1 - e^{-2*theta*dt}) / (2*theta)) * Z,   Z ~ N(0,1)

    Stationary variance is sigma^2 / (2*theta) -- used in tests to sanity
    check the implementation statistically.
    """

    __slots__ = ("price", "theta", "mean", "sigma")

    def __init__(
        self,
        start_price: float,
        theta: float = 2.0,
        sigma: float = 0.4,
        long_term_mean: float | None = None,
    ) -> None:
        if theta <= 0:
            raise ValueError("theta (mean reversion speed) must be > 0")
        self.price = start_price
        self.theta = theta
        self.mean = long_term_mean if long_term_mean is not None else start_price
        self.sigma = sigma

    def step(self, dt: float) -> float:
        if dt <= 0:
            return self.price
        z = random.gauss(0.0, 1.0)
        decay = math.exp(-self.theta * dt)
        variance = (self.sigma * self.sigma) * (1 - math.exp(-2 * self.theta * dt)) / (2 * self.theta)
        self.price = self.mean + (self.price - self.mean) * decay + math.sqrt(max(variance, 0.0)) * z
        return self.price
