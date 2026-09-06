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

import asyncio
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


# ------------------------------------------------------------------ history
# in-process cache: (symbol, expiry, from, to) -> series  (past data is static)
_HIST_CACHE: dict[tuple, list[dict]] = {}


def _max_pain(strikes: dict[float, dict]) -> float | None:
    """Strike that minimises total option-writer payout using the given day's
    per-strike OI. `strikes` = {k: {"CE": oi, "PE": oi}}."""
    ks = sorted(strikes)
    if len(ks) < 3:
        return None
    best_k, best_pain = None, None
    for e in ks:  # candidate expiry price
        pain = 0.0
        for k, oi in strikes.items():
            if k < e:
                pain += oi.get("CE", 0.0) * (e - k)   # ITM calls
            elif k > e:
                pain += oi.get("PE", 0.0) * (k - e)   # ITM puts
        if best_pain is None or pain < best_pain:
            best_pain, best_k = pain, e
    return best_k


def _state(d_price: float, d_oi: float) -> str:
    up_p, up_oi = d_price >= 0, d_oi >= 0
    if up_p and up_oi:
        return "LONG BUILDUP"
    if not up_p and up_oi:
        return "SHORT BUILDUP"
    if not up_p and not up_oi:
        return "LONG UNWINDING"
    return "SHORT COVERING"


async def fetch_history_chain(
    symbol: str, expiry: str, from_date: str, to_date: str
) -> dict:
    """Daily series of aggregate chain metrics (spot, CE/PE OI, PCR, max-pain,
    OI state) across [from_date, to_date] ('YYYY-MM-DD'), built from Upstox
    per-contract historical OI candles. Cached — past days don't change."""
    ux = get_upstox()
    key = ux.instrument_key(symbol)
    if not key:
        raise RuntimeError(f"no Upstox instrument_key for {symbol}")

    ck = (symbol.upper(), expiry, from_date, to_date)
    if ck in _HIST_CACHE:
        return {"symbol": symbol.upper(), "expiry": expiry, "from": from_date,
                "to": to_date, "series": _HIST_CACHE[ck], "cached": True}

    # 1. current chain -> per-strike CE/PE instrument keys
    chain = await ux.get(
        "/option/chain", {"instrument_key": key, "expiry_date": _nse_to_iso(expiry)}
    )
    legs: list[tuple[float, str, str]] = []
    for r in chain.get("data", []) or []:
        strike = _num(r.get("strike_price"))
        for side, obj in (("CE", r.get("call_options")), ("PE", r.get("put_options"))):
            ik = (obj or {}).get("instrument_key")
            if ik:
                legs.append((strike, side, ik))

    # 2. per-leg daily candles  [ts, o, h, l, c, volume, oi]
    sem = asyncio.Semaphore(12)

    async def _one(strike: float, side: str, ik: str):
        async with sem:
            try:
                h = await ux.get(f"/historical-candle/{ik}/day/{to_date}/{from_date}")
                return strike, side, h.get("data", {}).get("candles", []) or []
            except Exception:  # noqa: BLE001
                return strike, side, []

    results = await asyncio.gather(*[_one(s, sd, ik) for s, sd, ik in legs])

    # 3. underlying daily closes (spot)
    spot_by_date: dict[str, float] = {}
    try:
        uh = await ux.get(f"/historical-candle/{key}/day/{to_date}/{from_date}")
        for c in uh.get("data", {}).get("candles", []) or []:
            spot_by_date[c[0][:10]] = _num(c[4])
    except Exception:  # noqa: BLE001
        pass

    # 4. aggregate per calendar date
    per_date: dict[str, dict] = {}
    for strike, side, candles in results:
        for c in candles:
            d = c[0][:10]
            oi = _num(c[6]) if len(c) > 6 else 0.0
            pd = per_date.setdefault(d, {"ceOI": 0.0, "peOI": 0.0, "strikes": {}})
            pd["strikes"].setdefault(strike, {})[side] = oi
            pd["ceOI" if side == "CE" else "peOI"] += oi

    series: list[dict] = []
    for d in sorted(per_date):
        pd = per_date[d]
        ce, pe = pd["ceOI"], pd["peOI"]
        series.append({
            "date": d,
            "spot": spot_by_date.get(d),
            "ceOI": ce,
            "peOI": pe,
            "pcr": round(pe / ce, 3) if ce else None,
            "maxPain": _max_pain(pd["strikes"]),
        })

    # 5. day-over-day movement + OI state
    for i in range(1, len(series)):
        p, c = series[i - 1], series[i]
        dp = (c["spot"] or 0) - (p["spot"] or 0)
        doi = (c["ceOI"] + c["peOI"]) - (p["ceOI"] + p["peOI"])
        c["dSpot"] = round(dp, 2)
        c["dOI"] = round(doi, 0)
        c["state"] = _state(dp, doi)

    _HIST_CACHE[ck] = series
    return {"symbol": symbol.upper(), "expiry": expiry, "from": from_date,
            "to": to_date, "series": series, "cached": False}
