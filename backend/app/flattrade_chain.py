"""Builds an NSE-option-chain-*shaped* payload from Flattrade/Noren data, so
the existing processing.build_chain() -- and everything downstream of it
(screener, scanner, OI series, watchlist, unusual-Greeks detection, every
API route) -- keeps working completely unchanged. Only the fetch layer
changes; nothing that consumes store.get_chain() output needs to know.

Flattrade has no single "give me the live chain" call. The shape is:
  1. GetOptionChain(anchor tsym, strike) -> the strike list for one expiry,
     but only *static* contract metadata (token/tsym/strike/lot/tick) --
     no LTP/OI/bid-ask.
  2. GetQuotes(exch, token) per strike -> the live data (lp, oi, bp1/sp1,
     bq1/sq1, v, c). No IV field (we already compute our own via
     greeks.implied_vol, so that's not a gap) and no change-in-OI field
     (approximated here as "vs first snapshot seen today" -- resets on a
     backend restart, same trade-off store.session_open() already makes
     for the day-open spot reference).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime

from .config import INDEX_FEED_TOKENS

log = logging.getLogger("flattrade_chain")

# ATM step per underlying, for anchoring the GetOptionChain call. Options with
# their own step (e.g. 250 for stocks >5000) still get every strike back from
# Noren around this anchor -- it only needs to be "close enough".
_STEP_GUESS = {
    "NIFTY": 50, "BANKNIFTY": 100, "FINNIFTY": 50,
    "MIDCPNIFTY": 25, "NIFTYNXT50": 50,
    "SENSEX": 100, "BANKEX": 100,
}

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


async def fetch_chain_payload(
    broker,
    symbol: str,
    expiry: str,
    spot: float | None = None,
    exch: str = "NFO",
    count: int = 30,
) -> dict | None:
    """One (symbol, expiry) snapshot, returned NSE-payload-shaped so it can go
    straight into processing.build_chain() unchanged. None on failure."""
    sym = symbol.upper()
    _reset_oi_base_if_new_day()

    if spot is None:
        spot = await underlying_spot(broker, sym, "BSE" if exch == "BFO" else "NSE")
    if not spot:
        return None

    step = _STEP_GUESS.get(sym, 50)
    atm = round(spot / step) * step

    try:
        anchor = await broker.resolve_nfo(sym, expiry, atm, "CE")
    except Exception as exc:  # noqa: BLE001
        log.warning("resolve_nfo failed for %s %s: %s", sym, expiry, exc)
        return None
    if not anchor.get("tsym"):
        return None

    try:
        oc = await broker.get_option_chain(exch, anchor["tsym"], str(int(atm)), count)
    except Exception as exc:  # noqa: BLE001
        log.warning("GetOptionChain failed for %s %s: %s", sym, expiry, exc)
        return None
    values = (oc or {}).get("values") or []
    if not values:
        return None

    async def _q(v: dict):
        try:
            return v, await broker.quotes(exch, v["token"])
        except Exception:  # noqa: BLE001
            return v, None

    results = await asyncio.gather(*[_q(v) for v in values])

    by_strike: dict[float, dict] = {}
    for v, q in results:
        if not q or q.get("stat") != "Ok":
            continue
        strike = _num(v.get("strprc"))
        ot = "CE" if v.get("optt") == "CE" else "PE"
        token = str(v.get("token"))
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
