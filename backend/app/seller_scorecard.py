"""Seller's strike scorecard: for each strike you could SELL, how often did the index finish beyond it by expiry, how big was the
loss when it did, and does today's premium pay for that?

For an index with daily history in the candle store (data/candles.db, 5 years) and the live option chain:
  * sessions = trading days left to expiry (weekdays after today up to and including the expiry day);
  * every historical window of that many sessions gives a return r; on today's spot S a put struck at K pays out max(0, K - S(1+r)),
    a call max(0, S(1+r) - K) -- the payout the seller would have owed;
  * P(ITM) = the share of windows with a payout; kept% = (premium - average payout) / premium (what a seller kept on average, before
    costs); avg loss = the average payout when it did finish ITM, in multiples of the premium collected;
  * break-even win rate = (avg payout - premium) / avg payout -- compare it with the actual share of windows that finished OTM;
  * the same numbers for the windows that STARTED in the same trend as today (NIFTY-style: close > 50-DMA > 200-DMA = up, below both = down).
It describes what happened over the history, not what will: gaps, margin and an event the history never saw are not in it.
"""
from __future__ import annotations

import sqlite3
from datetime import date, datetime, timedelta, timezone

from .config import DATA_DIR

IST = timezone(timedelta(hours=5, minutes=30))
SYMBOLS = ("NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY", "BANKEX", "NIFTYNXT50")
MAX_OTM = 0.07  # strikes up to 7% out of the money
_hist: dict[str, tuple] = {}  # symbol -> (mtime, dates, closes, regimes)


def history(symbol: str):
    """(dates, closes, regimes) -- regimes[i] = 'up' | 'down' | 'mixed' | None at the close of day i."""
    db = DATA_DIR / "candles.db"
    if symbol not in SYMBOLS or not db.exists():
        return None
    mt = db.stat().st_mtime
    c = _hist.get(symbol)
    if c and c[0] == mt:
        return c[1], c[2], c[3]
    try:
        con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=5)
        rows = con.execute("select ts, c from bars where sym=? and tf=86400 order by ts", (symbol,)).fetchall()
        con.close()
    except sqlite3.Error:
        return None
    rows = [r for r in rows if r[1]]
    if len(rows) < 300:
        return None
    dates = [datetime.fromtimestamp(r[0], IST).date() for r in rows]
    closes = [float(r[1]) for r in rows]
    reg: list[str | None] = [None] * len(closes)
    for i in range(200, len(closes)):
        a50 = sum(closes[i - 49 : i + 1]) / 50
        a200 = sum(closes[i - 199 : i + 1]) / 200
        reg[i] = "up" if closes[i] > a50 > a200 else "down" if closes[i] < a50 < a200 else "mixed"
    _hist[symbol] = (mt, dates, closes, reg)
    return dates, closes, reg


def sessions_to(expiry: date, today: date | None = None) -> int:
    """Weekdays after `today` up to and including the expiry day (at least 1)."""
    today = today or datetime.now(IST).date()
    n, d = 0, today
    while d < expiry:
        d += timedelta(days=1)
        if d.weekday() < 5:
            n += 1
    return max(1, n)


def parse_expiry(s: str) -> date | None:
    for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d-%m-%Y", "%d %b %Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except (ValueError, TypeError):
            continue
    return None


def _stats(rets: list[float], spot: float, strike: float, premium: float, put: bool) -> dict | None:
    if len(rets) < 30 or premium <= 0:
        return None
    pay = [max(0.0, (strike - spot * (1 + r)) if put else (spot * (1 + r) - strike)) for r in rets]
    itm = [p for p in pay if p > 0]
    n = len(pay)
    p_itm = len(itm) / n
    exp_pay = sum(pay) / n
    avg_itm = sum(itm) / len(itm) if itm else 0.0
    be_win = (avg_itm - premium) / avg_itm if avg_itm > premium else 0.0  # <= 0 when a loss never exceeds the premium
    return {
        "n": n,
        "probItm": round(p_itm * 100, 1),
        "keptPct": round((premium - exp_pay) / premium * 100, 1),
        "avgLossX": round(max(0.0, avg_itm - premium) / premium, 2),  # average loss when wrong, in premiums collected
        "worstX": round(max(0.0, max(pay) - premium) / premium, 1),
        "winsPerLoss": round(max(0.0, avg_itm - premium) / premium, 1),
        "breakEvenWin": round(be_win * 100, 1),
        "histWin": round((1 - p_itm) * 100, 1),
        "margin": round((1 - p_itm - be_win) * 100, 1),  # actual win rate minus the break-even one, in points
    }


def verdict(s: dict | None) -> str:
    if not s:
        return "n/a"
    if s["keptPct"] >= 25 and s["margin"] >= 3:
        return "pays"
    if s["keptPct"] >= 0:
        return "thin"
    return "underpays"


def build(symbol: str, chain: dict, side: str) -> dict:
    symbol = symbol.upper()
    h = history(symbol)
    if h is None:
        return {"error": f"no daily history for {symbol} yet (indices only: {', '.join(SYMBOLS)})"}
    dates, closes, reg = h
    put = side.upper().startswith("P")
    spot = float(chain.get("liveSpot", {}).get("ltp") if isinstance(chain.get("liveSpot"), dict) and chain["liveSpot"].get("ltp") else chain["spot"])
    exp = parse_expiry(chain.get("expiry") or "")
    if exp is None:
        return {"error": f"unreadable expiry {chain.get('expiry')!r}"}
    sess = sessions_to(exp)
    n = len(closes) - sess
    if n < 100:
        return {"error": "not enough history"}
    rets = [closes[i + sess] / closes[i] - 1 for i in range(n)]
    today_reg = reg[-1]
    same = [rets[i] for i in range(n) if reg[i] == today_reg] if today_reg else []
    out_rows = []
    for r in chain.get("rows", []):
        k = float(r["strike"])
        leg = r["put"] if put else r["call"]
        pct = (spot - k) / spot if put else (k - spot) / spot  # > 0 = out of the money
        if pct < -0.0001 or pct > MAX_OTM:
            continue
        bid, ask, ltp = leg.get("bid") or 0, leg.get("ask") or 0, leg.get("ltp") or 0
        prem = ltp if ltp > 0 else ((bid + ask) / 2 if bid > 0 and ask > 0 else 0)
        if prem <= 0:
            continue
        allw = _stats(rets, spot, k, prem, put)
        samew = _stats(same, spot, k, prem, put) if len(same) >= 60 else None
        delta = abs(leg.get("delta") or 0)
        out_rows.append({
            "strike": k, "pctOtm": round(pct * 100, 2), "premium": round(prem, 2), "bid": bid, "ask": ask,
            "impliedItm": round(delta * 100, 1) if delta else None,  # the market's own chance of ending ITM (|delta|)
            "all": allw, "trend": samew, "verdict": verdict(allw), "verdictTrend": verdict(samew),
        })
    out_rows.sort(key=lambda x: x["pctOtm"])
    return {
        "symbol": symbol, "side": "P" if put else "C", "expiry": chain.get("expiry"), "expiries": chain.get("expiries"), "spot": spot, "sessions": sess, "lotSize": chain.get("lotSize"),
        "windows": n, "from": dates[0].isoformat(), "to": dates[-1].isoformat(),
        "trend": today_reg, "trendWindows": len(same), "rows": out_rows,
    }


# ---------------------------------------------------------------- the BUYER's side
def _stats_buy(rets: list[float], spot: float, strike: float, premium: float, call: bool) -> dict | None:
    """What a buyer who holds to expiry made on every past window: payout - premium, as % of the premium."""
    if len(rets) < 30 or premium <= 0:
        return None
    pay = [max(0.0, (spot * (1 + r) - strike) if call else (strike - spot * (1 + r))) for r in rets]
    res = sorted((p - premium) / premium * 100 for p in pay)
    n = len(pay)
    wins = [p for p in pay if p > premium]
    return {
        "n": n,
        "probProfit": round(len(wins) / n * 100, 1),
        "avgPct": round(sum(res) / n, 1),
        "medPct": round(res[n // 2], 1),
        "p10Pct": round(res[int(n * 0.1)], 1),
        "lose50": round(sum(1 for p in pay if p < 0.5 * premium) / n * 100, 1),  # share that lost more than half the premium
        "avgWinX": round((sum(wins) / len(wins) - premium) / premium, 2) if wins else 0.0,
        "bestX": round((max(pay) - premium) / premium, 1),
    }


def verdict_buy(s: dict | None) -> str:
    if not s:
        return "n/a"
    return "fair" if s["avgPct"] >= -8 else "costly" if s["avgPct"] >= -25 else "verycostly"


def build_buy(symbol: str, chain: dict, side: str) -> dict:
    """Per strike you could BUY (calls or puts), held to expiry: what it costs in time value, spread and daily decay, the move you
    need to break even, and how the index's own history treated it. `advisor` = the in-the-money strike that cost least."""
    symbol = symbol.upper()
    h = history(symbol)
    if h is None:
        return {"error": f"no daily history for {symbol} yet (indices only: {', '.join(SYMBOLS)})"}
    dates, closes, reg = h
    call = not side.upper().startswith("P")
    live = chain.get("liveSpot")
    spot = float(live["ltp"] if isinstance(live, dict) and live.get("ltp") else chain["spot"])
    exp = parse_expiry(chain.get("expiry") or "")
    if exp is None:
        return {"error": f"unreadable expiry {chain.get('expiry')!r}"}
    sess = sessions_to(exp)
    n = len(closes) - sess
    if n < 100:
        return {"error": "not enough history"}
    rets = [closes[i + sess] / closes[i] - 1 for i in range(n)]
    today_reg = reg[-1]
    same = [rets[i] for i in range(n) if reg[i] == today_reg] if today_reg else []
    rows = []
    for r in chain.get("rows", []):
        k = float(r["strike"])
        leg = r["call"] if call else r["put"]
        itm = (spot - k) / spot if call else (k - spot) / spot  # > 0 = in the money
        if itm < -0.02 or itm > 0.04:
            continue
        bid, ask, ltp = leg.get("bid") or 0, leg.get("ask") or 0, leg.get("ltp") or 0
        prem = ltp if ltp > 0 else ((bid + ask) / 2 if bid > 0 and ask > 0 else 0)
        if prem <= 0:
            continue
        intrinsic = max(0.0, (spot - k) if call else (k - spot))
        be = (k + prem) / spot - 1 if call else 1 - (k - prem) / spot  # the move (in the option's direction) needed to break even at expiry
        allw = _stats_buy(rets, spot, k, prem, call)
        samew = _stats_buy(same, spot, k, prem, call) if len(same) >= 60 else None
        mid = (bid + ask) / 2 if bid > 0 and ask > 0 else prem
        rows.append({
            "strike": k, "pctItm": round(itm * 100, 2), "premium": round(prem, 2), "bid": bid, "ask": ask,
            "spreadPct": round((ask - bid) / mid * 100, 1) if bid > 0 and ask > 0 and mid else None,
            "timeValuePct": round(max(0.0, prem - intrinsic) / prem * 100, 1),
            "decayDayPct": round(abs(leg.get("theta") or 0) / prem * 100, 1) if leg.get("theta") else None,  # of the premium, per day
            "delta": round(abs(leg.get("delta") or 0), 2), "volume": leg.get("volume") or 0,
            "breakEvenPct": round(be * 100, 2),
            "all": allw, "trend": samew, "verdict": verdict_buy(allw), "verdictTrend": verdict_buy(samew),
        })
    rows.sort(key=lambda x: -x["pctItm"])  # deepest in the money first
    # the advisor: of the liquid in-the-money strikes (delta >= 0.6, spread <= 3%) the one that cost the least on this history
    cand = [x for x in rows if 0.3 <= x["pctItm"] <= 3.0 and x["delta"] >= 0.6 and x["timeValuePct"] >= 1  # a price below intrinsic is a stale quote
            and (x["spreadPct"] is None or x["spreadPct"] <= 3) and x["all"]]
    best = max(cand, key=lambda x: x["all"]["avgPct"]) if cand else None
    atm = min(rows, key=lambda x: abs(x["pctItm"])) if rows else None
    return {
        "mode": "buy", "symbol": symbol, "side": "C" if call else "P", "expiry": chain.get("expiry"), "expiries": chain.get("expiries"), "spot": spot,
        "sessions": sess, "lotSize": chain.get("lotSize"), "windows": n, "from": dates[0].isoformat(), "to": dates[-1].isoformat(),
        "trend": today_reg, "trendWindows": len(same), "rows": rows,
        "advisor": best["strike"] if best else None, "atm": atm["strike"] if atm else None,
    }
