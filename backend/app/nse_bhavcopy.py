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

import json
import logging

from . import nse_client
from .config import DATA_DIR, DIVIDEND_YIELD, RISK_FREE_RATE, STRIKE_WINDOW
from .greeks import greeks as bs_greeks
from .greeks import implied_vol
from .processing import IST, _MIN_T, year_fraction

_STEP = {"NIFTY": 50, "BANKNIFTY": 100, "FINNIFTY": 50, "MIDCPNIFTY": 25, "NIFTYNXT50": 50}

_ROWS_CACHE: dict[str, list[dict] | None] = {}  # "YYYYMMDD" -> that day's IDO rows (all symbols), or None
_GREEKS_CACHE: dict[tuple, list[dict]] = {}
log = logging.getLogger("nse_bhavcopy")


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


# ----------------------------------------------------------------------------------------------
# Per-day option facts for backtests: for every index / stock with options, that day's expiries,
# its spot, the real closing prices near the money for the two nearest expiries, and the real
# at-the-money implied volatility. A backtest prices its options from these instead of a fixed
# "30 days to expiry, 15% IV" (which made a weekly NIFTY ATM option look ~Rs 400 instead of the
# real ~Rs 100-200, and every % stop / target move at the wrong speed).
# Kept small on disk (data/bhav_opts/YYYYMMDD.json) so a re-run doesn't re-download ~MBs a day.
# ----------------------------------------------------------------------------------------------
_FACTS_DIR = DATA_DIR / "bhav_opts"
_FACTS: dict[str, dict | None] = {}


def _atm_iv(closes: dict, expiry: str, spot: float, d: date) -> float | None:
    ks = sorted({float(key.split("|")[0]) for key in closes})
    if not ks:
        return None
    k = min(ks, key=lambda x: abs(x - spot))
    t = max(year_fraction(datetime.strptime(expiry, "%Y-%m-%d").strftime("%d-%b-%Y"),
                          datetime(d.year, d.month, d.day, 15, 30, tzinfo=IST)), _MIN_T)
    vs = []
    for ot in ("CE", "PE"):
        px = closes.get(f"{k:g}|{ot}")
        if px:
            v = implied_vol(ot, px, spot, k, t, RISK_FREE_RATE, DIVIDEND_YIELD)
            if v and 0.02 < v < 3:
                vs.append(v)
    return round(sum(vs) / len(vs), 4) if vs else None


def _build_facts(content: bytes, d: date) -> dict:
    """Pure / sync (zip + csv + IV solving) -- run in a thread."""
    by_sym: dict[str, list] = {}
    z = zipfile.ZipFile(io.BytesIO(content))
    with z.open(z.namelist()[0]) as f:
        for r in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8")):
            if r.get("FinInstrmTp") not in ("IDO", "STO"):
                continue
            by_sym.setdefault(r.get("TckrSymb") or "", []).append((
                r.get("XpryDt") or "", _num(r.get("StrkPric")), r.get("OptnTp") or "",
                _num(r.get("ClsPric")) or _num(r.get("SttlmPric")), _num(r.get("UndrlygPric")),
            ))
    ds = d.isoformat()
    out: dict = {}
    for sym, rows in by_sym.items():
        exps = sorted({x[0] for x in rows if x[0] >= ds})
        spot = next((x[4] for x in rows if x[4]), 0.0)
        if not sym or not exps or not spot:
            continue
        keep = exps[:2]
        closes: dict[str, dict] = {e: {} for e in keep}
        for e, k, ot, c, _u in rows:
            if e in closes and c > 0 and abs(k - spot) <= 0.1 * spot:
                closes[e][f"{k:g}|{ot}"] = c
        # the IV from the nearest expiry that is not today: an expiry-day close has minutes left,
        # which makes the implied vol meaningless
        iv_exp = next((e for e in keep if e > ds), None)
        iv = _atm_iv(closes[iv_exp], iv_exp, spot, d) if iv_exp else None
        out[sym] = {"spot": spot, "expiries": exps[:6], "closes": closes, "atmIv": iv}
    return out


async def day_facts(yyyymmdd: str) -> dict | None:
    """{symbol: {spot, expiries, closes{expiry: {"K|CE": close}}, atmIv}} for one trading day, or
    None (holiday / not published / fetch failed)."""
    if yyyymmdd in _FACTS:
        return _FACTS[yyyymmdd]
    p = _FACTS_DIR / f"{yyyymmdd}.json"
    try:
        _FACTS[yyyymmdd] = json.loads(p.read_text("utf-8"))
        return _FACTS[yyyymmdd]
    except (OSError, ValueError):
        pass
    content = await nse_client.client.bhavcopy_fo(yyyymmdd)
    if not content:
        return None  # not cached: a day that isn't out yet may be later
    try:
        facts = await asyncio.to_thread(_build_facts, content, datetime.strptime(yyyymmdd, "%Y%m%d").date())
    except Exception as exc:  # noqa: BLE001
        log.warning("bhavcopy facts %s: %s", yyyymmdd, exc)
        return None
    _FACTS[yyyymmdd] = facts
    try:
        _FACTS_DIR.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(facts, separators=(",", ":")), "utf-8")
    except OSError as exc:
        log.warning("bhavcopy facts save %s: %s", yyyymmdd, exc)
    return facts


async def symbol_facts(symbol: str, days: list[str]) -> dict[str, dict]:
    """{"YYYY-MM-DD": that symbol's facts} for the given trading days (missing days left out:
    holidays, BSE names like SENSEX that NSE's file doesn't carry, fetch failures)."""
    symbol = symbol.upper()
    sem = asyncio.Semaphore(6)

    async def _one(ds: str):
        async with sem:
            f = await day_facts(ds.replace("-", ""))
            return ds, (f or {}).get(symbol)

    got = await asyncio.gather(*[_one(ds) for ds in sorted(set(days))])
    return {ds: f for ds, f in got if f}
