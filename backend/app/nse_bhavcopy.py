"""Historical index-options Greeks/GEX reconstruction from NSE's own public
F&O bhavcopy archive (nse_client.bhavcopy_fo) -- one CSV per trading day
covering the whole F&O chain, including whichever expiry was actually
front-week that day.

This is what upstox_data.fetch_history_greeks() has to approximate with a
single, currently-listed expiry: Upstox's instrument master only carries
contracts still listed today, so an expired front-week contract's
instrument_key can never be resolved after the fact -- the historical range
it can reach is bounded by how far in advance whatever's listed *today* was
originally listed, often just a few weeks. Bhavcopy has no such gap: every
expiry that ever traded is in that day's own file, correctly dated, at real
(often much better) liquidity, going back as far as NSE's archive does.

Falls back cleanly (empty series) for symbols NSE's F&O segment doesn't
cover (BSE names like SENSEX/BANKEX) or on any fetch/parse failure --
autobot_backtest.py already knows how to fall back to fetch_history_greeks
in that case.
"""
from __future__ import annotations

import asyncio
import csv
import io
import zipfile
from datetime import date, datetime, timedelta

from . import nse_client
from .config import DIVIDEND_YIELD, RISK_FREE_RATE, STRIKE_WINDOW
from .greeks import greeks as bs_greeks
from .greeks import implied_vol
from .processing import IST, _MIN_T, year_fraction

_STEP = {"NIFTY": 50, "BANKNIFTY": 100, "FINNIFTY": 50, "MIDCPNIFTY": 25, "NIFTYNXT50": 50}

_ROWS_CACHE: dict[str, list[dict] | None] = {}  # "YYYYMMDD" -> that day's IDO rows (all symbols), or None
_GREEKS_CACHE: dict[tuple, list[dict]] = {}


def _num(v, d: float = 0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


async def _fetch_day_rows(yyyymmdd: str) -> list[dict] | None:
    if yyyymmdd in _ROWS_CACHE:
        return _ROWS_CACHE[yyyymmdd]
    content = await nse_client.client.bhavcopy_fo(yyyymmdd)
    rows: list[dict] | None = None
    if content:
        try:
            z = zipfile.ZipFile(io.BytesIO(content))
            with z.open(z.namelist()[0]) as f:
                reader = csv.DictReader(io.TextIOWrapper(f, encoding="utf-8"))
                rows = [r for r in reader if r.get("FinInstrmTp") == "IDO"]
        except Exception:  # noqa: BLE001
            rows = None
    _ROWS_CACHE[yyyymmdd] = rows
    return rows


def _compute_day(symbol: str, rows: list[dict], d: date) -> dict | None:
    """Pure/sync -- run via asyncio.to_thread, same reasoning as
    upstox_data._compute_greeks_series: implied-vol solving here must never
    run inline on the event loop that also drives the live poller/AutoBot
    tick/broker feed.

    Picks whichever expiry is front-week (nearest expiry on/after `d`) among
    that day's own listed expiries, then reconstructs netGex/gammaFlip/ATM
    greeks the same way the live chain does (processing.build_chain),
    windowed to STRIKE_WINDOW around that day's own ATM."""
    sym_rows = [r for r in rows if r.get("TckrSymb") == symbol]
    if not sym_rows:
        return None
    ds = d.strftime("%Y-%m-%d")
    expiries = sorted({r["XpryDt"] for r in sym_rows})
    front = next((e for e in expiries if e >= ds), None)
    if not front:
        return None
    chain = [r for r in sym_rows if r["XpryDt"] == front]
    spot = _num(chain[0].get("UndrlygPric"))
    if not spot:
        return None

    by_strike: dict[float, dict] = {}
    for r in chain:
        k = _num(r.get("StrkPric"))
        side = r.get("OptnTp")
        close = _num(r.get("ClsPric")) or _num(r.get("SttlmPric"))
        oi = _num(r.get("OpnIntrst"))
        by_strike.setdefault(k, {})[side] = {"close": close, "oi": oi}

    step = _STEP.get(symbol, 50)
    atm = round(spot / step) * step
    lo, hi = atm - STRIKE_WINDOW * step, atm + STRIKE_WINDOW * step
    window = sorted(k for k in by_strike if lo <= k <= hi)
    # Same sparsity guard as upstox_data._compute_greeks_series: a handful of
    # thinly-traded strikes shouldn't be enough to fake a "covered" day.
    if len(window) < max(10, round((2 * STRIKE_WINDOW + 1) * 0.3)):
        return None

    expiry_nse_fmt = datetime.strptime(front, "%Y-%m-%d").strftime("%d-%b-%Y")
    now = datetime(d.year, d.month, d.day, 15, 30, tzinfo=IST)
    t = max(year_fraction(expiry_nse_fmt, now), _MIN_T)

    iv: dict[tuple, float] = {}
    for k in window:
        for side, leg in by_strike[k].items():
            px = leg["close"]
            if px > 0:
                v = implied_vol(side, px, spot, k, t, RISK_FREE_RATE, DIVIDEND_YIELD)
                if v is not None:
                    iv[(k, side)] = v

    def _fallback_iv(k: float, side: str) -> float:
        same_side = [(abs(sk - k), v) for (sk, ss), v in iv.items() if ss == side]
        if same_side:
            return min(same_side)[1]
        other_side = list(iv.values())
        return other_side[0] if other_side else 0.15

    net_gex = cum = 0.0
    pts: list[tuple[float, float]] = []
    atm_ce_delta = atm_ce_gamma = atm_pe_delta = atm_pe_gamma = 0.0
    for k in window:
        legs = by_strike[k]
        ce_oi = legs.get("CE", {}).get("oi", 0.0)
        pe_oi = legs.get("PE", {}).get("oi", 0.0)
        sigma_ce = iv.get((k, "CE")) or _fallback_iv(k, "CE")
        sigma_pe = iv.get((k, "PE")) or _fallback_iv(k, "PE")
        g_ce = bs_greeks("CE", spot, k, t, RISK_FREE_RATE, DIVIDEND_YIELD, sigma_ce)
        g_pe = bs_greeks("PE", spot, k, t, RISK_FREE_RATE, DIVIDEND_YIELD, sigma_pe)
        net_gex += g_ce["gamma"] * ce_oi - g_pe["gamma"] * pe_oi
        cum += g_pe["gamma"] * pe_oi - g_ce["gamma"] * ce_oi
        pts.append((k, cum))
        if k == atm:
            atm_ce_delta, atm_ce_gamma = g_ce["delta"], g_ce["gamma"]
            atm_pe_delta, atm_pe_gamma = g_pe["delta"], g_pe["gamma"]

    gamma_flip = atm
    for (k0, v0), (k1, v1) in zip(pts, pts[1:]):
        if (v0 <= 0 <= v1 or v0 >= 0 >= v1) and v0 != v1:
            gamma_flip = round(k0 + (-v0) / (v1 - v0) * (k1 - k0), 2)
            break

    return {
        "date": ds, "spot": round(spot, 2), "netGex": round(net_gex, 2), "gammaFlip": gamma_flip,
        "atmCEDelta": round(atm_ce_delta, 4), "atmCEGamma": round(atm_ce_gamma, 6),
        "atmPEDelta": round(atm_pe_delta, 4), "atmPEGamma": round(atm_pe_gamma, 6),
        "expiry": expiry_nse_fmt,
    }


async def fetch_bhavcopy_greeks(symbol: str, from_date: str, to_date: str) -> dict:
    """Same series shape as upstox_data.fetch_history_greeks (date/netGex/
    gammaFlip/atm*Delta/atm*Gamma per day), reconstructed from NSE's own
    bhavcopy so each day uses whichever expiry was genuinely front-week that
    day -- no single-expiry DTE drift, no dependence on a contract still
    being listed today. No `expiry` parameter: the right expiry is a
    per-day fact bhavcopy already answers."""
    symbol = symbol.upper()
    ck = (symbol, from_date, to_date)
    if ck in _GREEKS_CACHE:
        return {"symbol": symbol, "from": from_date, "to": to_date,
                "series": _GREEKS_CACHE[ck], "cached": True, "source": "nse_bhavcopy"}

    start = datetime.strptime(from_date, "%Y-%m-%d").date()
    end = datetime.strptime(to_date, "%Y-%m-%d").date()
    days = [start + timedelta(n) for n in range((end - start).days + 1)
            if (start + timedelta(n)).weekday() < 5]

    sem = asyncio.Semaphore(8)

    async def _one(d: date):
        async with sem:
            rows = await _fetch_day_rows(d.strftime("%Y%m%d"))
            if not rows:
                return None
            return await asyncio.to_thread(_compute_day, symbol, rows, d)

    results = await asyncio.gather(*[_one(d) for d in days])
    series = [r for r in results if r]
    _GREEKS_CACHE[ck] = series
    return {"symbol": symbol, "from": from_date, "to": to_date,
            "series": series, "cached": False, "source": "nse_bhavcopy"}
