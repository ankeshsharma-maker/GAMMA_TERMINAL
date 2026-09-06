"""Turn a raw NSE option-chain payload into a processed chain with Greeks."""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from .config import DIVIDEND_YIELD, RISK_FREE_RATE, STRIKE_WINDOW
from .greeks import greeks, implied_vol

IST = ZoneInfo("Asia/Kolkata")
_YEAR_SECONDS = 365.0 * 24 * 3600

# Greeks are computed with t floored here so that near-/at-expiry chains still
# produce finite, meaningful gamma/theta (the whole point of a gamma-blast view)
# instead of collapsing to intrinsic. Displayed `dte` still uses the true value.
_MIN_T = (15.0 * 60) / _YEAR_SECONDS  # 15 minutes

# Contract lot sizes. Indices are hand-kept here as an offline fallback; the
# authoritative per-underlying map (`_DYNAMIC_LOTS`) is populated from the
# Upstox instrument master on startup — that covers every F&O stock, which
# this table never did (stocks used to silently fall back to 1).
LOT_SIZES = {
    "NIFTY": 65,
    "BANKNIFTY": 35,
    "FINNIFTY": 65,
    "MIDCPNIFTY": 140,
    "NIFTYNXT50": 25,
    "SENSEX": 20,
    "BANKEX": 30,
}
DEFAULT_LOT_SIZE = 1

# underlying -> lot size, filled from the exchange instrument master
_DYNAMIC_LOTS: dict[str, int] = {}


def set_lot_sizes(m: dict[str, int]) -> None:
    """Merge an exchange-sourced {UNDERLYING: lot} map (Upstox instrument dump)."""
    for k, v in (m or {}).items():
        try:
            iv = int(v)
        except (TypeError, ValueError):
            continue
        if iv > 0:
            _DYNAMIC_LOTS[str(k).upper()] = iv


def lot_size(symbol: str) -> int:
    s = symbol.upper()
    # indices: trust the hand-kept table; stocks: trust the exchange dump
    if s in LOT_SIZES:
        return LOT_SIZES[s]
    return _DYNAMIC_LOTS.get(s) or DEFAULT_LOT_SIZE


def _num(v, default=0.0) -> float:
    try:
        if v in (None, "", "-"):
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def year_fraction(expiry: str, now: datetime | None = None) -> float:
    """Calendar-day year fraction from `now` to expiry 15:30 IST."""
    now = now or datetime.now(IST)
    exp = datetime.strptime(expiry, "%d-%b-%Y").replace(
        hour=15, minute=30, tzinfo=IST
    )
    return max((exp - now).total_seconds(), 0.0) / _YEAR_SECONDS


def days_to_expiry(expiry: str, now: datetime | None = None) -> float:
    return round(year_fraction(expiry, now) * 365.0, 2)


def _leg(raw: dict | None, kind: str, spot: float, strike: float, t: float) -> dict:
    raw = raw or {}
    tc = max(t, _MIN_T)
    ltp = _num(raw.get("lastPrice"))
    bid = _num(raw.get("bidprice", raw.get("bidPrice")))
    ask = _num(raw.get("askPrice"))
    mid = (bid + ask) / 2.0 if bid > 0 and ask > 0 else ltp
    nse_iv = _num(raw.get("impliedVolatility")) / 100.0 or None

    iv_calc = implied_vol(kind, mid, spot, strike, tc, RISK_FREE_RATE, DIVIDEND_YIELD)
    sigma = iv_calc or nse_iv
    g = greeks(kind, spot, strike, tc, RISK_FREE_RATE, DIVIDEND_YIELD, sigma or 0.0)
    oi = _num(raw.get("openInterest"))

    return {
        "oi": oi,
        "oiChg": _num(raw.get("changeinOpenInterest")),
        "oiChgPct": _num(raw.get("pchangeinOpenInterest")),
        "volume": _num(raw.get("totalTradedVolume")),
        "iv": round(nse_iv * 100, 2) if nse_iv else None,
        "ivCalc": round(sigma * 100, 2) if sigma else None,
        "ltp": ltp,
        "chg": _num(raw.get("change")),
        "chgPct": _num(raw.get("pChange")),
        "bid": bid,
        "ask": ask,
        "bidQty": _num(raw.get("bidQty")),
        "askQty": _num(raw.get("askQty")),
        "delta": round(g["delta"], 4),
        "gamma": round(g["gamma"], 6),
        "theta": round(g["theta"], 3),
        "vega": round(g["vega"], 3),
        "rho": round(g["rho"], 3),
        # rough gamma-exposure proxy (gamma per 1pt * OI); sign applied at chain level
        "gex": round(g["gamma"] * oi, 4),
    }


def build_chain(
    raw: dict,
    symbol: str,
    expiry: str | None = None,
    strike_window: int = STRIKE_WINDOW,
) -> dict:
    records = raw.get("records", {})
    expiries: list[str] = records.get("expiryDates", []) or []
    data = records.get("data", []) or []
    if not expiries:
        raise ValueError(f"no expiries in NSE payload for {symbol}")

    if expiry not in expiries:
        expiry = expiries[0]

    spot = _num(records.get("underlyingValue"))
    if spot <= 0:
        for d in data:
            leg = d.get("CE") or d.get("PE") or {}
            if _num(leg.get("underlyingValue")) > 0:
                spot = _num(leg.get("underlyingValue"))
                break

    exp_rows = sorted(
        (d for d in data if d.get("expiryDate") == expiry),
        key=lambda d: _num(d.get("strikePrice")),
    )
    if not exp_rows:
        raise ValueError(f"no rows for {symbol} {expiry}")

    strikes = [_num(d.get("strikePrice")) for d in exp_rows]
    diffs = sorted({round(b - a, 2) for a, b in zip(strikes, strikes[1:]) if b > a})
    step = diffs[0] if diffs else 50.0
    atm = min(strikes, key=lambda k: abs(k - spot))
    lo, hi = atm - strike_window * step, atm + strike_window * step

    t = year_fraction(expiry)

    rows: list[dict] = []
    tot_ce_oi = tot_pe_oi = tot_ce_vol = tot_pe_vol = 0.0
    tot_ce_oi_chg = tot_pe_oi_chg = 0.0
    net_gex = 0.0
    pain_ce = {k: 0.0 for k in strikes}
    pain_pe = {k: 0.0 for k in strikes}

    for d in exp_rows:
        strike = _num(d.get("strikePrice"))
        ce = d.get("CE") or {}
        pe = d.get("PE") or {}
        ce_oi, pe_oi = _num(ce.get("openInterest")), _num(pe.get("openInterest"))
        tot_ce_oi += ce_oi
        tot_pe_oi += pe_oi
        tot_ce_vol += _num(ce.get("totalTradedVolume"))
        tot_pe_vol += _num(pe.get("totalTradedVolume"))
        tot_ce_oi_chg += _num(ce.get("changeinOpenInterest"))
        tot_pe_oi_chg += _num(pe.get("changeinOpenInterest"))

        # max-pain accumulation over the full expiry
        for k in strikes:
            if strike < k:
                pain_ce[k] += ce_oi * (k - strike)
            elif strike > k:
                pain_pe[k] += pe_oi * (strike - k)

        if not (lo <= strike <= hi):
            continue

        call = _leg(ce, "CE", spot, strike, t)
        put = _leg(pe, "PE", spot, strike, t)
        net_gex += call["gex"] - put["gex"]
        rows.append(
            {
                "strike": strike,
                "isATM": strike == atm,
                "moneyness": "ITM" if strike < spot else ("OTM" if strike > spot else "ATM"),
                "call": call,
                "put": put,
            }
        )

    max_pain = min(strikes, key=lambda k: pain_ce[k] + pain_pe[k]) if strikes else atm
    pcr = round(tot_pe_oi / tot_ce_oi, 3) if tot_ce_oi else None

    # gamma-flip / zero-gamma strike: where the running sum of
    # (put gamma*OI - call gamma*OI) changes sign (dealer positioning flips
    # from short-gamma / trend-amplifying to long-gamma / mean-reverting).
    gamma_flip = None
    cum = 0.0
    _pts: list[tuple[float, float]] = []
    for r in rows:
        cum += r["put"]["gamma"] * r["put"]["oi"] - r["call"]["gamma"] * r["call"]["oi"]
        _pts.append((r["strike"], cum))
    for (k0, v0), (k1, v1) in zip(_pts, _pts[1:]):
        if (v0 <= 0 <= v1 or v0 >= 0 >= v1) and v0 != v1:
            gamma_flip = round(k0 + (-v0) / (v1 - v0) * (k1 - k0), 2)
            break
    if gamma_flip is None and rows:
        gamma_flip = atm

    atm_row = next((r for r in rows if r["strike"] == atm), None)
    atm_iv = None
    atm_straddle = None
    atm_gamma_oi = 0.0
    if atm_row:
        ivs = [
            v
            for v in (atm_row["call"].get("ivCalc"), atm_row["put"].get("ivCalc"))
            if v
        ]
        atm_iv = round(sum(ivs) / len(ivs), 2) if ivs else None
        atm_straddle = round(
            (atm_row["call"].get("ltp") or 0.0) + (atm_row["put"].get("ltp") or 0.0), 2
        )
        atm_gamma_oi = round(
            atm_row["call"]["gamma"] * atm_row["call"]["oi"]
            + atm_row["put"]["gamma"] * atm_row["put"]["oi"],
            2,
        )

    return {
        "symbol": symbol.upper(),
        "expiry": expiry,
        "expiries": expiries,
        "spot": round(spot, 2),
        "atmStrike": atm,
        "strikeStep": step,
        "lotSize": lot_size(symbol),
        "dte": days_to_expiry(expiry),
        "nseTimestamp": records.get("timestamp"),
        "atmIV": atm_iv,
        "atmStraddle": atm_straddle,
        "atmGammaOI": atm_gamma_oi,
        "pcr": pcr,
        "maxPain": max_pain,
        "gammaFlip": gamma_flip,
        "netGex": round(net_gex, 2),
        "totals": {
            "ceOI": tot_ce_oi,
            "peOI": tot_pe_oi,
            "ceOIChg": tot_ce_oi_chg,
            "peOIChg": tot_pe_oi_chg,
            "ceVol": tot_ce_vol,
            "peVol": tot_pe_vol,
        },
        "rows": rows,
    }
