"""Intraday charts for a multi-leg strategy.

Both views are built from the same per-leg 1-minute candles:

* premium -- the legs' combined price as one candle series ("what is my
  straddle trading at"), plus each leg's close so the client can draw a P&L
  curve against whatever entry it likes;
* greeks  -- net and per-leg delta / gamma / theta / vega / IV over time.
  Historical candles carry no exchange IV, so each bar's IV is solved from that
  leg's own close against the underlying's close at the same bar (the same
  Black-Scholes path the live chain uses). Thinly traded strikes therefore look
  stepped: their price only moves when they trade.

Multi-leg candle highs/lows are an envelope of the legs' bar opens and closes
(the legs' own highs and lows rarely happen at the same instant, so summing
them would overstate the range). A single leg keeps its exact high and low.
The Greek solve is CPU work and runs off the event loop, which the live poller
shares.
"""
from __future__ import annotations

import asyncio
import bisect
import time
from datetime import datetime

from . import candle_sources
from .config import DIVIDEND_YIELD, RISK_FREE_RATE
from .greeks import greeks as bs_greeks
from .greeks import implied_vol
from .processing import IST, _MIN_T, year_fraction

MAX_LEGS = 8
MAX_SOLVES = 15000     # bars x legs of implied-vol solving allowed in one request
FETCH_S = 60           # candles are always fetched at 1-min and bucketed up here
_TTL = 10.0
_CACHE: dict[tuple, tuple[float, dict]] = {}


class StrategyChartError(Exception):
    """A request that can't be charted; the message is safe to show the user."""


def _sign(side: str) -> int:
    return 1 if str(side).upper() == "BUY" else -1


def _day(ts: int) -> str:
    return datetime.fromtimestamp(ts, IST).strftime("%Y-%m-%d")


def _snap(candles: list[dict]) -> dict[int, dict]:
    """1-min bars keyed by their minute; a later duplicate wins. Zero closes are
    dropped -- a contract that hasn't traded has no price, not a price of 0."""
    out: dict[int, dict] = {}
    for c in candles:
        if not c.get("close") or c["close"] <= 0:
            continue
        out[int(c["time"]) // FETCH_S * FETCH_S] = c
    return out


def _align(bars: dict[int, dict], grid: list[int]) -> dict[str, list]:
    """One leg's open/high/low/close on `grid`. A minute the contract didn't
    trade repeats the last close (seeded from the last print before the grid
    starts); None until the contract has printed at all."""
    times = sorted(bars)
    i = bisect.bisect_left(times, grid[0]) - 1
    last = bars[times[i]]["close"] if i >= 0 else None
    o: list = []
    h: list = []
    l: list = []
    c: list = []
    for t in grid:
        b = bars.get(t)
        if b:
            o.append(b["open"])
            h.append(b["high"])
            l.append(b["low"])
            c.append(b["close"])
            last = b["close"]
        elif last is not None:
            o.append(last)
            h.append(last)
            l.append(last)
            c.append(last)
        else:
            o.append(None)
            h.append(None)
            l.append(None)
            c.append(None)
    return {"o": o, "h": h, "l": l, "c": c}


def _round(v: float | None, nd: int) -> float | None:
    return None if v is None else round(v, nd)


def _assemble(
    symbol: str,
    expiry: str,
    lot_size: int,
    legs: list[dict],
    leg_bars: list[dict[int, dict]],
    spot_bars: dict[int, dict] | None,
    interval_s: int,
    days: int,
    sources: list[str],
) -> dict:
    # ---- timeline: the underlying's minutes (a regular grid), else the legs' own ----
    if spot_bars:
        master = sorted(spot_bars)
    else:
        master = sorted({t for b in leg_bars for t in b})
    keep = sorted({_day(t) for t in master})[-days:]
    keepset = set(keep)
    grid = [t for t in master if _day(t) in keepset]
    if not grid:
        raise StrategyChartError("No candles in the selected range")

    aligned = [_align(b, grid) for b in leg_bars]
    # start once every leg has a price
    first = 0
    for k in range(len(grid)):
        if all(a["c"][k] is not None for a in aligned):
            first = k
            break
    else:
        raise StrategyChartError("The legs have no overlapping price history in this range")
    grid = grid[first:]
    aligned = [{key: v[first:] for key, v in a.items()} for a in aligned]
    n = len(grid)
    spot_min = None
    if spot_bars:
        spot_min = []
        last_s = None
        for t in grid:
            b = spot_bars.get(t)
            if b:
                last_s = b["close"]
            spot_min.append(last_s)

    # ---- combined per-minute candles (signed position value, in points) ----
    w = [_sign(l["side"]) * int(l["lots"]) for l in legs]
    vo = [sum(w[i] * aligned[i]["o"][k] for i in range(len(legs))) for k in range(n)]
    vc = [sum(w[i] * aligned[i]["c"][k] for i in range(len(legs))) for k in range(n)]
    if len(legs) == 1:
        a = aligned[0]
        if w[0] > 0:
            vh = [w[0] * v for v in a["h"]]
            vl = [w[0] * v for v in a["l"]]
        else:
            vh = [w[0] * v for v in a["l"]]
            vl = [w[0] * v for v in a["h"]]
    else:
        vh = [max(a, b) for a, b in zip(vo, vc)]
        vl = [min(a, b) for a, b in zip(vo, vc)]

    # ---- bucket to the chart interval ----
    buckets: list[list[int]] = []
    key = None
    for k, t in enumerate(grid):
        b = t // interval_s
        if b != key:
            buckets.append([])
            key = b
        buckets[-1].append(k)
    times = [grid[ks[0]] // interval_s * interval_s for ks in buckets]

    def _last(seq):
        return [seq[ks[-1]] for ks in buckets]

    po = [vo[ks[0]] for ks in buckets]
    pc = _last(vc)
    ph = [max(vh[k] for k in ks) for ks in buckets]
    pl = [min(vl[k] for k in ks) for ks in buckets]
    spot = _last(spot_min) if spot_min else [None] * len(times)
    closes = [_last(a["c"]) for a in aligned]

    # a net credit is charted as the (positive) premium collected
    sign = 1 if pc[-1] >= 0 else -1
    if sign > 0:
        prem = {"open": po, "high": ph, "low": pl, "close": pc}
    else:
        prem = {
            "open": [-v for v in po],
            "high": [-v for v in pl],
            "low": [-v for v in ph],
            "close": [-v for v in pc],
        }
    prem = {k: [round(v, 2) for v in vs] for k, vs in prem.items()}

    # ---- greeks per bucket, solved from each leg's own close ----
    greeks_out: dict | None = None
    if spot_min and all(s is not None for s in spot):
        per: list[dict[str, list]] = []
        for i, leg in enumerate(legs):
            kind = leg["optionType"]
            strike = float(leg["strike"])
            iv_l: list = []
            g_l = {"delta": [], "gamma": [], "theta": [], "vega": []}
            last_iv = None
            for k, t in enumerate(times):
                px, s = closes[i][k], spot[k]
                tt = max(
                    year_fraction(expiry, datetime.fromtimestamp(t + interval_s, IST)), _MIN_T
                )
                iv = implied_vol(kind, px, s, strike, tt, RISK_FREE_RATE, DIVIDEND_YIELD)
                if iv is None:
                    iv = last_iv  # at/below intrinsic or unsolvable: keep the last good IV
                if iv is None:
                    iv_l.append(None)
                    for name in g_l:
                        g_l[name].append(None)
                    continue
                last_iv = iv
                g = bs_greeks(kind, s, strike, tt, RISK_FREE_RATE, DIVIDEND_YIELD, iv)
                iv_l.append(iv * 100.0)
                for name in g_l:
                    g_l[name].append(g[name])
            per.append({"iv": iv_l, **g_l})

        qty = [w[i] * lot_size for i in range(len(legs))]  # signed units held
        net = {name: [] for name in ("delta", "gamma", "theta", "vega")}
        net_iv: list = []
        for k in range(len(times)):
            row = [per[i]["delta"][k] is not None for i in range(len(legs))]
            if not all(row):
                for name in net:
                    net[name].append(None)
                net_iv.append(None)
                continue
            for name in net:
                net[name].append(sum(qty[i] * per[i][name][k] for i in range(len(legs))))
            wt = [abs(qty[i] * per[i]["vega"][k]) for i in range(len(legs))]
            tot = sum(wt)
            net_iv.append(
                sum(wt[i] * per[i]["iv"][k] for i in range(len(legs))) / tot
                if tot > 0
                else sum(per[i]["iv"][k] for i in range(len(legs))) / len(legs)
            )
        greeks_out = {
            "net": {
                "delta": [_round(v, 2) for v in net["delta"]],
                "gamma": [_round(v, 5) for v in net["gamma"]],
                "theta": [_round(v, 2) for v in net["theta"]],
                "vega": [_round(v, 2) for v in net["vega"]],
                "iv": [_round(v, 2) for v in net_iv],
            },
            # each leg's signed contribution to the net (so the legs add up to it)
            "legs": [
                {
                    "delta": [_round(None if v is None else qty[i] * v, 2) for v in per[i]["delta"]],
                    "gamma": [_round(None if v is None else qty[i] * v, 5) for v in per[i]["gamma"]],
                    "theta": [_round(None if v is None else qty[i] * v, 2) for v in per[i]["theta"]],
                    "vega": [_round(None if v is None else qty[i] * v, 2) for v in per[i]["vega"]],
                    "iv": [_round(v, 2) for v in per[i]["iv"]],
                }
                for i in range(len(legs))
            ],
        }

    return {
        "symbol": symbol,
        "expiry": expiry,
        "interval": interval_s,
        "days": days,
        "lotSize": lot_size,
        "sessions": sorted({_day(t) for t in grid}),
        "source": sorted(set(sources)),
        "kind": "DEBIT" if sign > 0 else "CREDIT",
        "sign": sign,
        "times": times,
        "premium": prem,
        "spot": [_round(v, 2) for v in spot],
        "legs": [
            {
                "optionType": leg["optionType"],
                "strike": float(leg["strike"]),
                "side": str(leg["side"]).upper(),
                "lots": int(leg["lots"]),
                "close": [_round(v, 2) for v in closes[i]],
            }
            for i, leg in enumerate(legs)
        ],
        "greeks": greeks_out,
        "greeksNote": None if greeks_out else "Underlying candles unavailable - Greeks need the spot at each bar",
        "updated": time.time(),
    }


async def build(
    symbol: str,
    expiry: str,
    lot_size: int,
    legs: list[dict],
    interval_s: int = 300,
    days: int = 1,
    src: str = "auto",
) -> dict:
    symbol = symbol.upper()
    legs = [l for l in legs if str(l.get("optionType", "")).upper() in ("CE", "PE")]
    if not legs:
        raise StrategyChartError("Add at least one option leg to chart")
    if len(legs) > MAX_LEGS:
        raise StrategyChartError(f"At most {MAX_LEGS} legs can be charted at once")
    for l in legs:
        l["optionType"] = str(l["optionType"]).upper()
    interval_s = max(60, int(interval_s) // 60 * 60)
    days = max(1, min(int(days), 5))
    bars_per_leg = days * 375 * 60 // interval_s
    if bars_per_leg * len(legs) > MAX_SOLVES:
        raise StrategyChartError("Range too large for this many legs - shorten it or use a longer interval")

    ck = (
        symbol, expiry, interval_s, days, src,
        tuple(sorted((l["optionType"], float(l["strike"]), str(l["side"]).upper(), int(l["lots"])) for l in legs)),
    )
    hit = _CACHE.get(ck)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]

    # ---- candles: each distinct contract once, plus the underlying ----
    lookback = (days * 2 + 3) * 24 * 60   # calendar-generous window for the broker's TPSeries
    contracts = sorted({(float(l["strike"]), l["optionType"]) for l in legs})
    sem = asyncio.Semaphore(3)

    async def _opt(strike: float, ot: str):
        async with sem:
            return await candle_sources.option_candles(
                symbol, expiry, strike, ot, FETCH_S, src, lookback=lookback
            )

    async def _spot():
        async with sem:
            return await candle_sources.underlying_candles(symbol, FETCH_S, lookback=lookback)

    got = await asyncio.gather(*[_opt(k, ot) for k, ot in contracts], _spot())
    opt_res = dict(zip(contracts, got[:-1]))
    spot_candles, spot_src = got[-1]

    missing = [f"{k:g}{ot}" for (k, ot), (c, _) in opt_res.items() if not c]
    if missing:
        raise StrategyChartError(
            "No candle history for " + ", ".join(missing)
            + " - connect Upstox or Flattrade in Settings, or pick strikes that trade"
        )

    snapped = {key: _snap(c) for key, (c, _) in opt_res.items()}
    leg_bars = [snapped[(float(l["strike"]), l["optionType"])] for l in legs]
    if any(not b for b in leg_bars):
        raise StrategyChartError("A leg has no priced candles in this range")
    sources = [lab for (_, lab) in opt_res.values()]
    spot_bars = _snap(spot_candles) if spot_candles else None

    out = await asyncio.to_thread(
        _assemble, symbol, expiry, lot_size, legs, leg_bars, spot_bars, interval_s, days,
        sources + ([spot_src] if spot_bars else []),
    )
    if len(_CACHE) > 64:
        _CACHE.pop(min(_CACHE, key=lambda k: _CACHE[k][0]), None)
    _CACHE[ck] = (time.time(), out)
    return out
