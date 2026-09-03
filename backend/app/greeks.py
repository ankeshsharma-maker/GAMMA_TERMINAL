"""Dependency-free Black-Scholes-Merton pricing, implied vol, and Greeks.

All Greeks are returned in trader-friendly units:
  delta  - per 1 point of underlying
  gamma  - per 1 point of underlying (delta change)
  theta  - per calendar day
  vega   - per 1 volatility point (1% = 0.01 sigma)
  rho    - per 1% change in the risk-free rate
"""
from __future__ import annotations

import math
from typing import Optional

SQRT_2PI = math.sqrt(2.0 * math.pi)


def _norm_pdf(x: float) -> float:
    return math.exp(-0.5 * x * x) / SQRT_2PI


def _norm_cdf(x: float) -> float:
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _d1_d2(S: float, K: float, t: float, r: float, q: float, sigma: float):
    vsqrt = sigma * math.sqrt(t)
    d1 = (math.log(S / K) + (r - q + 0.5 * sigma * sigma) * t) / vsqrt
    return d1, d1 - vsqrt


def bs_price(kind: str, S: float, K: float, t: float, r: float, q: float, sigma: float) -> float:
    """European option price. `kind` is 'CE'/'call' or 'PE'/'put'."""
    call = kind.upper() in ("CE", "CALL", "C")
    if t <= 0 or sigma <= 0 or S <= 0 or K <= 0:
        intrinsic = (S - K) if call else (K - S)
        return max(intrinsic, 0.0)
    d1, d2 = _d1_d2(S, K, t, r, q, sigma)
    df_r = math.exp(-r * t)
    df_q = math.exp(-q * t)
    if call:
        return S * df_q * _norm_cdf(d1) - K * df_r * _norm_cdf(d2)
    return K * df_r * _norm_cdf(-d2) - S * df_q * _norm_cdf(-d1)


def implied_vol(
    kind: str,
    price: float,
    S: float,
    K: float,
    t: float,
    r: float,
    q: float,
    lo: float = 1e-4,
    hi: float = 6.0,
) -> Optional[float]:
    """Solve for sigma given a market price. Newton with a bisection fallback."""
    call = kind.upper() in ("CE", "CALL", "C")
    if price is None or price <= 0 or t <= 0 or S <= 0 or K <= 0:
        return None
    intrinsic = max((S - K) if call else (K - S), 0.0)
    if price <= intrinsic + 1e-6:
        return None
    df_r = math.exp(-r * t)
    df_q = math.exp(-q * t)
    upper_bound = S * df_q if call else K * df_r
    if price >= upper_bound:
        return None

    sigma = 0.25
    for _ in range(60):
        d1, _ = _d1_d2(S, K, t, r, q, sigma)
        diff = bs_price(kind, S, K, t, r, q, sigma) - price
        if abs(diff) < 1e-6:
            return sigma if lo <= sigma <= hi else None
        vega = S * df_q * _norm_pdf(d1) * math.sqrt(t)
        if vega < 1e-8:
            break
        step = diff / vega
        sigma -= step
        if sigma <= lo or sigma >= hi or math.isnan(sigma):
            break

    # Bisection fallback.
    a, b = lo, hi
    fa = bs_price(kind, S, K, t, r, q, a) - price
    fb = bs_price(kind, S, K, t, r, q, b) - price
    if fa * fb > 0:
        return None
    for _ in range(200):
        m = 0.5 * (a + b)
        fm = bs_price(kind, S, K, t, r, q, m) - price
        if abs(fm) < 1e-6:
            return m
        if fa * fm < 0:
            b, fb = m, fm
        else:
            a, fa = m, fm
    return 0.5 * (a + b)


def greeks(kind: str, S: float, K: float, t: float, r: float, q: float, sigma: float) -> dict:
    call = kind.upper() in ("CE", "CALL", "C")
    out = {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "rho": 0.0}
    if t <= 0 or sigma is None or sigma <= 0 or S <= 0 or K <= 0:
        out["delta"] = (1.0 if S > K else 0.0) if call else (-1.0 if S < K else 0.0)
        return out

    d1, d2 = _d1_d2(S, K, t, r, q, sigma)
    df_r = math.exp(-r * t)
    df_q = math.exp(-q * t)
    pdf_d1 = _norm_pdf(d1)
    sqrt_t = math.sqrt(t)

    out["gamma"] = df_q * pdf_d1 / (S * sigma * sqrt_t)
    out["vega"] = S * df_q * pdf_d1 * sqrt_t / 100.0

    if call:
        out["delta"] = df_q * _norm_cdf(d1)
        theta = (
            -(S * df_q * pdf_d1 * sigma) / (2.0 * sqrt_t)
            - r * K * df_r * _norm_cdf(d2)
            + q * S * df_q * _norm_cdf(d1)
        )
        out["rho"] = K * t * df_r * _norm_cdf(d2) / 100.0
    else:
        out["delta"] = -df_q * _norm_cdf(-d1)
        theta = (
            -(S * df_q * pdf_d1 * sigma) / (2.0 * sqrt_t)
            + r * K * df_r * _norm_cdf(-d2)
            - q * S * df_q * _norm_cdf(-d1)
        )
        out["rho"] = -K * t * df_r * _norm_cdf(-d2) / 100.0

    out["theta"] = theta / 365.0
    return out
