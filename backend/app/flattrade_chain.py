"""Builds an NSE-option-chain-*shaped* payload from Flattrade/Noren data, so
the existing processing.build_chain() -- and everything downstream of it
(screener, scanner, OI series, watchlist, unusual-Greeks detection, every
API route) -- keeps working completely unchanged. Only the fetch layer
changes; nothing that consumes store.get_chain() output needs to know.

Flattrade has no single "give me the live chain" call, and live testing
(2026-09-04) showed GetOptionChain's `cnt` windowing is NOT reliable for
enumerating a clean strike ladder -- two calls anchored on a CE token and a
PE token at the same strike came back with different, non-contiguous, gappy
strike sets rather than complementary halves of one ladder. The one thing
confirmed reliable across every live test is resolve_nfo() (SearchScrip on
an exact, directly-constructed tsym): it correctly resolves a specific
contract to its token every time.

So: discover every strike's CE/PE token via resolve_nfo() **once** per
(symbol, expiry) and cache it (tokens are static for the life of a contract)
-- then every refresh after that is just GetQuotes per cached token, which
does carry the real live data (lp, oi, bp1/sp1, bq1/sq1, v, c). No native IV
field (build_chain()'s own implied_vol() fills that gap already) and no
change-in-OI field (approximated as "vs first snapshot seen today", same
day-anchor trade-off store.session_open() already makes for the day-open
spot reference).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from .config import INDEX_FEED_TOKENS

log = logging.getLogger("flattrade_chain")

# ATM step per underlying, for choosing which strikes to discover.
_STEP_GUESS = {
    "NIFTY": 50, "BANKNIFTY": 100, "FINNIFTY": 50,
    "MIDCPNIFTY": 25, "NIFTYNXT50": 50,
    "SENSEX": 100, "BANKEX": 100,
}

# (symbol, expiry) -> {strike: {"CE": token, "PE": token}} -- discovered once
# via resolve_nfo, kept for the process lifetime (a restart re-discovers).
_contract_cache: dict[tuple[str, str], dict[float, dict[str, str]]] = {}

# token -> first open-interest value seen today, used as the change-in-OI
# baseline (see module docstring). Cleared once per calendar day.
_day_oi_base: dict[str, float] = {}
_day_oi_date: str = ""


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _reset_oi_base_if_new_day() -> None:
    global _day_oi_date
    today = datetime.now().strftime("%Y-%m-%d")
    if today != _day_oi_date:
        _day_oi_base.clear()
        _day_oi_date = today


def clear_contract_cache(symbol: str | None = None, expiry: str | None = None) -> None:
    """Force re-discovery (e.g. if a strike was missing because the underlying
    moved a lot intraday and the exchange added new strikes)."""
    if symbol and expiry:
        _contract_cache.pop((symbol.upper(), expiry), None)
    else:
        _contract_cache.clear()


async def underlying_spot(broker, symbol: str, exch: str = "NSE") -> float | None:
    """Live spot for the underlying index, via the same feed-token path the
    broker WS ticks already use."""
    sym = symbol.upper()
    tok = INDEX_FEED_TOKENS.get(sym)
    if not tok:
        try:
            tok = await broker.feed_token(sym)
        except Exception as exc:  # noqa: BLE001
            log.debug("feed_token failed for %s: %s", sym, exc)
            return None
    if not tok:
        return None
    try:
        q = await broker.quotes(*tok)
    except Exception as exc:  # noqa: BLE001
        log.debug("underlying quote failed for %s: %s", sym, exc)
        return None
    spot = _num((q or {}).get("lp"))
    return spot or None


async def _discover_contracts(
    broker, sym: str, expiry: str, atm: float, step: float, window: int
) -> dict[float, dict[str, str]]:
    """Resolve every strike in [atm - window*step, atm + window*step] on both
    sides to its Noren token, via the confirmed-reliable resolve_nfo()."""
    strikes = [atm + i * step for i in range(-window, window + 1)]

    async def _resolve(strike: float, ot: str):
        try:
            info = await broker.resolve_nfo(sym, expiry, strike, ot)
        except Exception as exc:  # noqa: BLE001
            log.debug("resolve_nfo(%s %s %s) failed: %s", sym, strike, ot, exc)
            return strike, ot, None
        return strike, ot, info.get("token") if info else None

    tasks = [_resolve(k, ot) for k in strikes for ot in ("CE", "PE")]
    results = await asyncio.gather(*tasks)

    out: dict[float, dict[str, str]] = {}
    for strike, ot, token in results:
        if token:
            out.setdefault(strike, {})[ot] = str(token)
    return out


async def fetch_chain_payload(
    broker,
    symbol: str,
    expiry: str,
    spot: float | None = None,
    exch: str = "NFO",
    count: int = 20,
) -> dict | None:
    """One (symbol, expiry) snapshot, returned NSE-payload-shaped so it can go
    straight into processing.build_chain() unchanged. `count` = strikes each
    side of ATM. None on failure."""
    sym = symbol.upper()
    _reset_oi_base_if_new_day()

    if spot is None:
        spot = await underlying_spot(broker, sym, "BSE" if exch == "BFO" else "NSE")
    if not spot:
        return None

    step = _STEP_GUESS.get(sym, 50)
    atm = round(spot / step) * step

    key = (sym, expiry)
    contracts = _contract_cache.get(key)
    if not contracts:
        contracts = await _discover_contracts(broker, sym, expiry, atm, step, count)
        if contracts:
            _contract_cache[key] = contracts
    if not contracts:
        return None

    targets = [(k, ot, tok) for k, sides in contracts.items() for ot, tok in sides.items()]

    async def _q(strike: float, ot: str, token: str):
        try:
            return strike, ot, token, await broker.quotes(exch, token)
        except Exception:  # noqa: BLE001
            return strike, ot, token, None

    results = await asyncio.gather(*[_q(k, ot, tok) for k, ot, tok in targets])

    by_strike: dict[float, dict] = {}
    for strike, ot, token, q in results:
        if not q or q.get("stat") != "Ok":
            continue
        ltp = _num(q.get("lp"))
        prev_close = _num(q.get("c"))
        oi = _num(q.get("oi"))
        base = _day_oi_base.setdefault(token, oi)
        chg = oi - base
        leg = {
            "lastPrice": ltp,
            "bidprice": _num(q.get("bp1")),
            "askPrice": _num(q.get("sp1")),
            "bidQty": _num(q.get("bq1")),
            "askQty": _num(q.get("sq1")),
            "openInterest": oi,
            "changeinOpenInterest": chg,
            "pchangeinOpenInterest": round(chg / base * 100.0, 2) if base else 0.0,
            "totalTradedVolume": _num(q.get("v")),
            "change": round(ltp - prev_close, 2),
            "pChange": round((ltp - prev_close) / prev_close * 100.0, 2) if prev_close else 0.0,
            "impliedVolatility": None,  # no native field -- build_chain() computes its own
            "underlyingValue": spot,
        }
        row = by_strike.setdefault(strike, {"strikePrice": strike, "expiryDate": expiry})
        row[ot] = leg

    if not by_strike:
        return None

    return {
        "records": {
            "expiryDates": [expiry],
            "underlyingValue": spot,
            "timestamp": datetime.now().strftime("%d-%b-%Y %H:%M:%S"),
            "data": sorted(by_strike.values(), key=lambda r: r["strikePrice"]),
        }
    }
