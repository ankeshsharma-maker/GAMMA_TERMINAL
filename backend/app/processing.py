"""Turn a raw NSE option-chain payload into a processed chain with Greeks."""
from __future__ import annotations

import math
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


def is_expired(expiry: str, now: datetime | None = None) -> bool:
    """True once the expiry's 15:30 IST cutoff has passed. Unparseable → False
    (never hide a contract just because the date format changed)."""
    now = now or datetime.now(IST)
    try:
        exp = datetime.strptime(expiry, "%d-%b-%Y").replace(hour=15, minute=30, tzinfo=IST)
    except (ValueError, TypeError):
        return False
    return exp < now


def future_expiries(expiries: list[str], now: datetime | None = None) -> list[str]:
    """Drop already-expired dates, order preserved. If that would empty the list
    (clock skew, format change), return the original untouched."""
    now = now or datetime.now(IST)
    out = [e for e in expiries if not is_expired(e, now)]
    return out or list(expiries)


def _mid(raw: dict) -> float:
    """Bid/ask mid when both sides are quoted, else the last trade."""
    bid = _num(raw.get("bidprice", raw.get("bidPrice")))
    ask = _num(raw.get("askPrice"))
    return (bid + ask) / 2.0 if bid > 0 and ask > 0 else _num(raw.get("lastPrice"))


# a stale print further than this from parity gets flagged in the chain
PARITY_FLAG_PTS = 2.5
PARITY_FLAG_FRAC = 0.00012


def implied_forward(pairs: list[tuple[float, float, float]], spot: float, t: float) -> float | None:
    """Put-call parity: every strike prices the same forward, F = K + (C - P)·e^(rt).
    Median over near-ATM (strike, call, put) prices -- robust to a stale print or
    two. None when too few strikes are two-sided or the result is implausible,
    so the caller falls back to the rate/dividend model."""
    tc = max(t, _MIN_T)
    fs = sorted(k + (c - p) * math.exp(RISK_FREE_RATE * tc) for k, c, p in pairs if c > 0 and p > 0)
    if len(fs) < 3 or spot <= 0:
        return None
    n = len(fs)
    f = fs[n // 2] if n % 2 else (fs[n // 2 - 1] + fs[n // 2]) / 2.0
    return f if abs(f / spot - 1.0) < 0.03 else None


def _leg(raw: dict | None, kind: str, spot: float, strike: float, t: float, q: float = DIVIDEND_YIELD) -> dict:
    """`q` is the chain's carry: the parity-implied dividend yield, so pricing off
    spot with it is the same as pricing off the market's own forward."""
    raw = raw or {}
    tc = max(t, _MIN_T)
    ltp = _num(raw.get("lastPrice"))
    bid = _num(raw.get("bidprice", raw.get("bidPrice")))
    ask = _num(raw.get("askPrice"))
    mid = _mid(raw)
    nse_iv = _num(raw.get("impliedVolatility")) / 100.0 or None

    iv_calc = implied_vol(kind, mid, spot, strike, tc, RISK_FREE_RATE, q)
    sigma = iv_calc or nse_iv
    g = greeks(kind, spot, strike, tc, RISK_FREE_RATE, q, sigma or 0.0)
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


def _gamma_flip(rows: list[dict], spot: float, atm: float) -> float | None:
    """The strike where cumulative dealer gamma exposure (put gamma*OI - call
    gamma*OI, running over `rows` ascending by strike) crosses zero: below it
    dealers are short gamma (moves amplified), above it long gamma (moves
    dampened). `rows` need only have strike/call.gamma/call.oi/put.gamma/put.oi.

    When call/put gamma exposure is roughly balanced near the money, the
    cumulative curve can cross zero at SEVERAL strikes -- picking the first
    one (ascending) is arbitrary and noise-sensitive: a small OI tick at any
    strike in that band can relocate "first" to a different level between
    polls even though nothing meaningful changed. The crossing nearest spot
    is both the economically relevant one (the regime boundary AT the price
    that matters) and far more stable, since noise in strikes away from spot
    no longer relocates it. Falls back to ATM when the curve never crosses
    (e.g. one-sided OI, or too few strikes)."""
    cum = 0.0
    pts: list[tuple[float, float]] = []
    for r in rows:
        cum += r["put"]["gamma"] * r["put"]["oi"] - r["call"]["gamma"] * r["call"]["oi"]
        pts.append((r["strike"], cum))
    crossings: list[float] = []
    for (k0, v0), (k1, v1) in zip(pts, pts[1:]):
        if (v0 <= 0 <= v1 or v0 >= 0 >= v1) and v0 != v1:
            crossings.append(k0 + (-v0) / (v1 - v0) * (k1 - k0))
    if crossings:
        return round(min(crossings, key=lambda k: abs(k - spot)), 2)
    return atm if rows else None


def build_chain(
    raw: dict,
    symbol: str,
    expiry: str | None = None,
    strike_window: int = STRIKE_WINDOW,
) -> dict:
    records = raw.get("records", {})
    expiries: list[str] = future_expiries(records.get("expiryDates", []) or [])
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
    tc = max(t, _MIN_T)

    # the market's own forward from put-call parity (±6 strikes around ATM),
    # turned into the carry q every leg below is priced with. Falls back to the
    # flat rate/dividend model when the chain is too thin to trust.
    near = [d for d in exp_rows if abs(_num(d.get("strikePrice")) - atm) <= 6 * step]
    fwd = implied_forward(
        [(_num(d.get("strikePrice")), _mid(d.get("CE") or {}), _mid(d.get("PE") or {})) for d in near], spot, t
    )
    q = RISK_FREE_RATE - math.log(fwd / spot) / tc if fwd else DIVIDEND_YIELD
    flag_pts = max(PARITY_FLAG_PTS, PARITY_FLAG_FRAC * spot)

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

        call = _leg(ce, "CE", spot, strike, t, q)
        put = _leg(pe, "PE", spot, strike, t, q)
        net_gex += call["gex"] - put["gex"]
        # how far this strike's LAST TRADES sit from parity: a big gap is a stale
        # print on a thin side, not an arbitrage. Only flagged when it's wider than
        # the live quotes themselves allow -- deep-ITM legs with 150+ pt spreads
        # sit "off parity" all day and flagging them is just noise.
        pdev = None
        stale = False
        if fwd and call["ltp"] > 0 and put["ltp"] > 0:
            pdev = round(strike + (call["ltp"] - put["ltp"]) * math.exp(RISK_FREE_RATE * tc) - fwd, 2)
            spreads = sum(s["ask"] - s["bid"] for s in (call, put) if s["bid"] > 0 and s["ask"] > 0)
            stale = abs(pdev) > max(flag_pts, spreads)
        rows.append(
            {
                "strike": strike,
                "isATM": strike == atm,
                "moneyness": "ITM" if strike < spot else ("OTM" if strike > spot else "ATM"),
                "call": call,
                "put": put,
                "parityDev": pdev,
                "parityStale": stale,
            }
        )

    max_pain = min(strikes, key=lambda k: pain_ce[k] + pain_pe[k]) if strikes else atm
    pcr = round(tot_pe_oi / tot_ce_oi, 3) if tot_ce_oi else None

    gamma_flip = _gamma_flip(rows, spot, atm)

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
        # the price the options are actually priced off (a synthetic future:
        # buy call + sell put at one strike) -- "model" when parity couldn't be
        # read and the flat rate/dividend assumption was used instead
        "forward": round(fwd if fwd else spot * math.exp((RISK_FREE_RATE - q) * tc), 2),
        "forwardSource": "parity" if fwd else "model",
        "carryQ": round(q, 6),
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
