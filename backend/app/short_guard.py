"""Short-strike guard: every open SHORT option (paper positions and live
Flattrade positions) is checked against its chain each poll. When a leg's
|delta| crosses 0.30 and again at 0.40 -- the strike is being tested -- it
fires one alert per level (edge-triggered, re-arms after easing back 0.05)
with the roll that takes it back to ~0.20 delta on the same expiry, priced
at the live quotes (buy back at the ask, sell the new strike at the bid).

State is in memory and resets each IST day; a restart can re-alert a leg
that is still above a level, which is harmless (it is still true)."""
from __future__ import annotations

from datetime import datetime

from .brokers.flattrade import parse_noren_tsym
from .processing import IST
from .store import store

LEVELS = (0.30, 0.40)
TARGET = 0.20
REARM = 0.05

_fired: dict[tuple, int] = {}   # leg key -> highest level index alerted (0 = none)
_day: str | None = None


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _short_legs() -> list[dict]:
    legs: list[dict] = []
    for p in store.paper.get("positions", []):
        qty = _f(p.get("qty"))
        if qty < 0 and p.get("optionType") in ("CE", "PE") and p.get("strike") is not None and p.get("expiry"):
            legs.append({"src": "paper", "symbol": p["symbol"].upper(), "expiry": p["expiry"],
                         "strike": float(p["strike"]), "ot": p["optionType"], "qty": abs(qty),
                         "avg": _f(p.get("avgPrice")), "name": None})
    for r in store.broker_positions:
        qty = _f(r.get("netqty"))
        if qty >= 0:
            continue
        parsed = parse_noren_tsym(r.get("tsym") or "", r.get("dname"))
        if not parsed:
            continue
        legs.append({"src": "live", "symbol": parsed["symbol"], "expiry": parsed["expiry"],
                     "strike": parsed["strike"], "ot": parsed["optionType"], "qty": abs(qty),
                     "avg": _f(r.get("netavgprc")), "name": r.get("tsym")})
    return legs


def watch_pairs() -> set[tuple[str, str]]:
    """(symbol, expiry) of every open short leg -- the poller keeps these chains
    fresh even when a leg isn't on the front expiry."""
    return {(lg["symbol"], lg["expiry"]) for lg in _short_legs()}


def _px(side: dict, want: str) -> float:
    """Live price to trade at: the ask to buy back, the bid to sell -- LTP when
    that side isn't quoted."""
    v = _f(side.get(want))
    return v if v > 0 else _f(side.get("ltp"))


def _evaluate(lg: dict) -> dict:
    out = {k: lg[k] for k in ("src", "symbol", "expiry", "strike", "ot", "qty", "avg", "name")}
    out.update(delta=None, absDelta=None, level=0, spot=None, distance=None, ltp=None, roll=None, reason=None)
    chain = store.get_chain(lg["symbol"], lg["expiry"])
    if not chain:
        out["reason"] = "chain not loaded yet"
        return out
    key = "call" if lg["ot"] == "CE" else "put"
    row = next((r for r in chain["rows"] if abs(r["strike"] - lg["strike"]) < 1e-6), None)
    if not row:
        out["reason"] = "strike outside the loaded chain"
        return out
    side = row[key]
    spot = chain.get("spot") or 0.0
    ad = abs(side.get("delta") or 0.0)
    level = 2 if ad >= LEVELS[1] else 1 if ad >= LEVELS[0] else 0
    # positive = still out of the money by that many points, negative = in the money
    dist = (lg["strike"] - spot) if lg["ot"] == "CE" else (spot - lg["strike"])
    out.update(delta=round(side.get("delta") or 0.0, 3), absDelta=round(ad, 3), level=level,
               spot=spot, distance=round(dist, 1), ltp=side.get("ltp"))
    if level:
        further = [r for r in chain["rows"]
                   if (r["strike"] > lg["strike"] if lg["ot"] == "CE" else r["strike"] < lg["strike"])
                   and (r[key].get("delta") or 0.0) != 0.0]
        if further:
            best = min(further, key=lambda r: abs(abs(r[key]["delta"]) - TARGET))
            buy = _px(side, "ask")
            sell = _px(best[key], "bid")
            net = sell - buy
            out["roll"] = {"strike": best["strike"], "delta": round(best[key]["delta"], 3),
                           "buyBack": round(buy, 2), "sellNew": round(sell, 2),
                           "netPerUnit": round(net, 2), "netTotal": round(net * lg["qty"], 0)}
    return out


def snapshot() -> list[dict]:
    rows = [_evaluate(lg) for lg in _short_legs()]
    return sorted(rows, key=lambda r: -(r["absDelta"] or 0.0))


def _key(r: dict) -> tuple:
    return (r["src"], r["symbol"], r["expiry"], r["strike"], r["ot"])


def _message(r: dict) -> str:
    lvl = LEVELS[r["level"] - 1]
    where = f"{abs(r['distance']):g} pts {'from' if r['distance'] >= 0 else 'past'} the strike"
    msg = (f"{r['symbol']} {r['strike']:g} {r['ot']} short ({r['src']}, {r['qty']:g} qty): "
           f"delta {r['absDelta']:.2f} crossed {lvl:.2f} — spot {r['spot']:g}, {where}.")
    rl = r.get("roll")
    if rl:
        verb = "credit" if rl["netPerUnit"] >= 0 else "debit"
        msg += (f" Roll to {rl['strike']:g} {r['ot']} (delta {abs(rl['delta']):.2f}): buy back ~{rl['buyBack']:g}, "
                f"sell ~{rl['sellNew']:g} → net {verb} {abs(rl['netPerUnit']):g}/unit (₹{abs(rl['netTotal']):,.0f}).")
    return msg


async def tick() -> list[dict]:
    """Alert events for legs that just crossed a level."""
    global _day
    today = datetime.now(IST).strftime("%Y-%m-%d")
    if today != _day:
        _day = today
        _fired.clear()
    events: list[dict] = []
    live_keys = set()
    for r in snapshot():
        if r["absDelta"] is None:
            continue
        k = _key(r)
        live_keys.add(k)
        prev = _fired.get(k, 0)
        if r["level"] > prev:
            _fired[k] = r["level"]
            events.append({"kind": "short-guard", "symbol": r["symbol"],
                           "severity": "critical" if r["level"] == 2 else "warning", "message": _message(r)})
        elif r["level"] < prev and r["absDelta"] < LEVELS[prev - 1] - REARM:
            _fired[k] = r["level"]
    for k in list(_fired):
        if k not in live_keys:   # position closed: forget it
            del _fired[k]
    return events
