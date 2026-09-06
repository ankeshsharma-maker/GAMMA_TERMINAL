"""Turn Upstox's /option/chain response into the NSE-option-chain-*shaped*
payload that processing.build_chain() already consumes — so the screener,
scanner, OI series, watchlist, every route and the frontend keep working
unchanged. Only the fetch layer differs.

Upstox gives the whole ladder in one REST call (LTP, OI, prev-OI, greeks, IV,
bid/ask, PCR, spot) for NSE *and* BSE underlyings — which is what finally
brings SENSEX / BANKEX into the terminal.

  GET /v2/option/chain?instrument_key=<underlying>&expiry_date=YYYY-MM-DD
  GET /v2/option/contract?instrument_key=<underlying>     (expiry list)
"""
from __future__ import annotations

import logging
from datetime import datetime

from .brokers.upstox import get_upstox

log = logging.getLogger("upstox_data")

_MONTHS = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _iso_to_nse(d: str) -> str:
    """'2026-09-08' -> '08-Sep-2026' (the format the rest of the app uses)."""
    try:
        y, m, day = d.split("-")
        return f"{int(day):02d}-{_MONTHS[int(m)]}-{y}"
    except Exception:  # noqa: BLE001
        return d


def _nse_to_iso(d: str) -> str:
    """'08-Sep-2026' -> '2026-09-08'."""
    try:
        return datetime.strptime(d, "%d-%b-%Y").strftime("%Y-%m-%d")
    except ValueError:
        return d


def _leg(md: dict, greeks: dict, spot: float) -> dict:
    ltp = _num(md.get("ltp"))
    prev_close = _num(md.get("close_price") or md.get("cp"))
    oi = _num(md.get("oi"))
    prev_oi = _num(md.get("prev_oi"))
    iv = greeks.get("iv")
    return {
        "lastPrice": ltp,
        "bidprice": _num(md.get("bid_price")),
        "askPrice": _num(md.get("ask_price")),
        "bidQty": _num(md.get("bid_qty")),
        "askQty": _num(md.get("ask_qty")),
        "openInterest": oi,
        "changeinOpenInterest": oi - prev_oi,
        "pchangeinOpenInterest": round((oi - prev_oi) / prev_oi * 100.0, 2) if prev_oi else 0.0,
        "totalTradedVolume": _num(md.get("volume")),
        "change": round(ltp - prev_close, 2),
        "pChange": round((ltp - prev_close) / prev_close * 100.0, 2) if prev_close else 0.0,
        # Upstox reports IV as a percentage already (e.g. 12.3); build_chain()
        # falls back to its own implied_vol() when this is None.
        "impliedVolatility": _num(iv) if iv not in (None, "") else None,
        "underlyingValue": spot,
    }


async def fetch_expiries(symbol: str) -> list[str]:
    ux = get_upstox()
    key = ux.instrument_key(symbol)
    if not key:
        return []
    d = await ux.get("/option/contract", {"instrument_key": key})
    seen: list[str] = []
    for row in d.get("data", []) or []:
        e = row.get("expiry")
        if e and e not in seen:
            seen.append(e)
    seen.sort()
    return [_iso_to_nse(e) for e in seen]


async def fetch_chain_payload(symbol: str, expiry: str) -> dict | None:
    """One (symbol, expiry) snapshot, NSE-payload-shaped for build_chain().
    `expiry` is the app's 'DD-Mon-YYYY'. None on failure."""
    ux = get_upstox()
    key = ux.instrument_key(symbol)
    if not key:
        log.warning("no Upstox instrument_key for %s", symbol)
        return None

    d = await ux.get(
        "/option/chain", {"instrument_key": key, "expiry_date": _nse_to_iso(expiry)}
    )
    rows = d.get("data", []) or []
    if not rows:
        return None

    spot = _num(rows[0].get("underlying_spot_price"))
    data = []
    for r in rows:
        row: dict = {"strikePrice": _num(r.get("strike_price")), "expiryDate": expiry}
        ce = r.get("call_options") or {}
        pe = r.get("put_options") or {}
        if ce:
            row["CE"] = _leg(ce.get("market_data") or {}, ce.get("option_greeks") or {}, spot)
        if pe:
            row["PE"] = _leg(pe.get("market_data") or {}, pe.get("option_greeks") or {}, spot)
        if "CE" in row or "PE" in row:
            data.append(row)

    if not data:
        return None

    return {
        "records": {
            "expiryDates": [expiry],
            "underlyingValue": spot,
            "timestamp": datetime.now().strftime("%d-%b-%Y %H:%M:%S"),
            "data": sorted(data, key=lambda x: x["strikePrice"]),
        }
    }
