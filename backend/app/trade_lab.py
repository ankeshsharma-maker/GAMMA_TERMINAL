"""Defined-loss ENTRY and REPAIR for option sellers.

find_trades(): "I'll risk at most Rs X" -> the iron condors / credit spreads / iron flies (every leg priced from the live chain: sold at the bid, bought
at the ask) whose worst case at expiry is <= X, sized in lots, each replayed on the index's own history (every past stretch of the same number of
sessions, on today's spot) so you see how often it made money and how bad the bad stretches were.

repair(): a running position (its legs and entry prices) -> the ways to fix it (do nothing / close the tested leg / roll it / buy protection /
close everything), each = the position's legs + the extra legs, re-analysed with strategy.analyze: what it costs now, the new worst case, breakevens,
P&L now and after a 1% move, and the same history replay for the position as it would then stand.
Everything is at expiry or from the model; nothing here sends an order.
"""
from __future__ import annotations

import bisect
from typing import Any

from . import seller_scorecard as SC
from . import strategy as strat

COST_PCT = 1.5          # % of the premium traded, round trip (spread / fees) taken off every replayed result
MAX_DIST = 0.06         # short strikes up to 6% from spot
WIDTH_STEPS = (1, 2, 3, 4, 6, 8, 12)  # wing widths in strikes
NAMES = {"IC": "Iron condor", "IF": "Iron fly", "PCS": "Put credit spread", "CCS": "Call credit spread"}


# ---------------------------------------------------------------- chain prices
def _rows(chain: dict) -> dict[float, dict]:
    return {float(r["strike"]): r for r in chain.get("rows", [])}


def _leg(r: dict, ot: str) -> dict:
    return r["call"] if ot == "CE" else r["put"]


def sell_px(r: dict, ot: str) -> float:
    """What a seller realistically gets: the bid (the last trade when there is no bid)."""
    l = _leg(r, ot)
    return float(l.get("bid") or 0) or float(l.get("ltp") or 0)


def buy_px(r: dict, ot: str) -> float:
    l = _leg(r, ot)
    return float(l.get("ask") or 0) or float(l.get("ltp") or 0)


def _spot(chain: dict) -> float:
    live = chain.get("liveSpot")
    return float(live["ltp"]) if isinstance(live, dict) and live.get("ltp") else float(chain["spot"])


def _windows(symbol: str, chain: dict):
    """(returns of every past stretch with as many sessions as are left, sessions) or (None, sessions)."""
    exp = SC.parse_expiry(chain.get("expiry") or "")
    sess = SC.sessions_to(exp) if exp else 1
    h = SC.history(symbol.upper())
    if h is None or exp is None:
        return None, sess
    closes = h[1]
    n = len(closes) - sess
    if n < 100:
        return None, sess
    return [closes[i + sess] / closes[i] - 1 for i in range(n)], sess


def _stats(pnl: list[float], risk: float) -> dict:
    s = sorted(pnl)
    n = len(s)
    avg = sum(s) / n
    return {
        "n": n,
        "win": round(sum(1 for x in pnl if x > 0) / n * 100, 1),
        "avg": round(avg, 0),
        "p5": round(s[int(n * 0.05)], 0),
        "worst": round(s[0], 0),
        "retPct": round(avg / risk * 100, 1) if risk else None,  # average result as % of the money at risk
    }


# ---------------------------------------------------------------- entry: defined-loss trades
def find_trades(
    chain: dict,
    max_loss: float,
    structures: list[str] | None = None,
    min_dist_pct: float = 0.5,
    sort: str = "return",
    top: int = 10,
    min_rr: float = 0.15,
) -> dict:
    symbol = chain["symbol"]
    spot = _spot(chain)
    step = float(chain.get("strikeStep") or 50.0)
    lot = int(chain["lotSize"])
    rows = _rows(chain)
    ks = sorted(rows)
    want = set(structures or ["IC", "IF", "PCS", "CCS"])
    rets, sess = _windows(symbol, chain)
    ST = [spot * (1 + r) for r in rets] if rets else None
    max_loss = float(max_loss)

    def spread(side: str, k_short: float, w_steps: int):
        """A credit spread: dict(credit, width, vec) or None. side 'P' (put) / 'C' (call)."""
        ot = "PE" if side == "P" else "CE"
        k_long = k_short - w_steps * step if side == "P" else k_short + w_steps * step
        rs, rl = rows.get(k_short), rows.get(k_long)
        if not rs or not rl:
            return None
        s_px, l_px = sell_px(rs, ot), buy_px(rl, ot)
        if s_px <= 0 or l_px <= 0:
            return None
        credit = s_px - l_px
        width = abs(k_short - k_long)
        if credit <= 0 or credit >= width:
            return None
        gross = s_px + l_px
        if ST is None:
            vec = None
        elif side == "P":
            vec = [credit - max(0.0, k_short - s) + max(0.0, k_long - s) for s in ST]
        else:
            vec = [credit - max(0.0, s - k_short) + max(0.0, s - k_long) for s in ST]
        return {"credit": credit, "width": width, "vec": vec, "gross": gross, "short": k_short, "long": k_long, "sPx": s_px, "lPx": l_px, "ot": ot}

    puts, calls = {}, {}
    for k in ks:
        d = (spot - k) / spot
        if min_dist_pct / 100 <= d <= MAX_DIST:
            for w in WIDTH_STEPS:
                sp = spread("P", k, w)
                if sp:
                    puts[(k, w)] = sp
        d = (k - spot) / spot
        if min_dist_pct / 100 <= d <= MAX_DIST:
            for w in WIDTH_STEPS:
                sp = spread("C", k, w)
                if sp:
                    calls[(k, w)] = sp

    cands: list[dict] = []

    def add(key: str, parts: list[dict]):
        credit = sum(p["credit"] for p in parts)
        width = parts[0]["width"] if len(parts) == 1 else max(p["width"] for p in parts)
        loss_unit = width - credit
        if loss_unit <= 0 or credit / loss_unit < min_rr:
            return  # a credit under ~15% of the risk is not worth the trade (and tops a "win rate" sort with junk)
        loss_lot = loss_unit * lot
        lots = int(max_loss // loss_lot)
        if lots < 1:
            return
        lots = min(lots, 100)
        gross = sum(p["gross"] for p in parts)
        fee = gross * COST_PCT / 100
        hist = None
        if ST is not None:
            pnl = [(sum(p["vec"][i] for p in parts) - fee) * lot * lots for i in range(len(ST))]
            hist = _stats(pnl, loss_lot * lots)
        legs = []
        for p in parts:  # long wings first: the protection goes on before the short leg
            legs.append({"optionType": p["ot"], "strike": p["long"], "side": "BUY", "lots": lots, "price": round(p["lPx"], 2)})
        for p in parts:
            legs.append({"optionType": p["ot"], "strike": p["short"], "side": "SELL", "lots": lots, "price": round(p["sPx"], 2)})
        sp_put = next((p for p in parts if p["ot"] == "PE"), None)
        sp_call = next((p for p in parts if p["ot"] == "CE"), None)
        bes = []
        if sp_put:
            bes.append(round(sp_put["short"] - credit, 2))
        if sp_call:
            bes.append(round(sp_call["short"] + credit, 2))
        cands.append({
            "key": key, "structure": NAMES[key], "legs": legs, "lots": lots, "width": width,
            "credit": round(credit * lot * lots, 0), "maxLoss": round(loss_lot * lots, 0), "costs": round(fee * lot * lots, 0),
            "rr": round(credit / loss_unit, 2), "breakevens": bes,
            "shortPutDist": round((spot - sp_put["short"]) / spot * 100, 2) if sp_put else None,
            "shortCallDist": round((sp_call["short"] - spot) / spot * 100, 2) if sp_call else None,
            "hist": hist,
        })

    if "PCS" in want:
        for sp in puts.values():
            add("PCS", [sp])
    if "CCS" in want:
        for sp in calls.values():
            add("CCS", [sp])
    if "IC" in want:
        for (kp, w), sp in puts.items():
            for (kc, w2), sc in calls.items():
                if w == w2:
                    add("IC", [sp, sc])
    if "IF" in want:
        katm = min(ks, key=lambda x: abs(x - spot))
        for w in WIDTH_STEPS:
            sp, sc = spread("P", katm, w), spread("C", katm, w)
            if sp and sc:
                add("IF", [sp, sc])

    def rank(c: dict):
        h = c["hist"]
        if sort == "win" and h:
            return (-h["win"], -(h["retPct"] or 0))
        if sort == "credit":
            return (-c["credit"],)
        if h:
            return (-(h["retPct"] if h["retPct"] is not None else -1e9), -h["win"])
        return (-c["rr"],)

    cands.sort(key=rank)
    out, seen = [], set()
    for c in cands:
        k = tuple((l["optionType"], l["strike"], l["side"]) for l in c["legs"])
        if k in seen:
            continue
        seen.add(k)
        out.append(c)
        if len(out) >= top:
            break
    for c in out[:6]:  # margin estimate and probability from the strategy analyser (top few only)
        try:
            a = strat.analyze(chain, c["legs"], points=161)
            c["margin"] = a["margin"]["estimate"]
            c["pop"] = a["pop"]
        except Exception:  # noqa: BLE001
            c["margin"], c["pop"] = None, None
    note = ""
    if not out:
        one = min((p["width"] - p["credit"]) * lot for p in list(puts.values()) + list(calls.values())) if (puts or calls) else None
        note = (f"No defined-loss trade fits ₹{max_loss:,.0f}: the smallest worst case for one lot is about ₹{one:,.0f}. Raise the limit." if one
                else "No priced strikes to build a trade from right now.")
    return {
        "symbol": symbol, "expiry": chain.get("expiry"), "spot": spot, "sessions": sess, "lotSize": lot,
        "maxLoss": max_loss, "windows": len(rets) if rets else 0, "trades": out, "note": note,
        "cost": f"{COST_PCT}% of the premium traded is taken off the replayed results",
    }


# ---------------------------------------------------------------- repair: ways to fix a running position
def _interp(xs: list[float], ys: list[float], x: float) -> float:
    if x <= xs[0]:
        return ys[0]
    if x >= xs[-1]:
        return ys[-1]
    i = bisect.bisect_left(xs, x)
    x0, x1, y0, y1 = xs[i - 1], xs[i], ys[i - 1], ys[i]
    return y0 + (y1 - y0) * (x - x0) / (x1 - x0) if x1 != x0 else y0


def repair(chain: dict, legs: list[dict], max_loss: float | None = None) -> dict:
    symbol = chain["symbol"]
    spot = _spot(chain)
    step = float(chain.get("strikeStep") or 50.0)
    lot = int(chain["lotSize"])
    rows = _rows(chain)
    rets, sess = _windows(symbol, chain)
    base_legs = [{"optionType": l["optionType"], "strike": float(l["strike"]), "side": l["side"].upper(), "lots": int(l["lots"]),
                  "price": l.get("price")} for l in legs]

    def row_of(k: float):
        return rows.get(float(k))

    def tested(l: dict) -> bool:
        if l["side"] != "SELL" or l["optionType"] == "FUT":
            return False
        r = row_of(l["strike"])
        d = abs((_leg(r, l["optionType"]).get("delta") or 0)) if r else 0
        itm = (spot < l["strike"]) if l["optionType"] == "PE" else (spot > l["strike"])
        return itm or d >= 0.30

    def evaluate(name: str, kind: str, extra: list[dict], why: str) -> dict | None:
        combined = base_legs + extra
        try:
            a = strat.analyze(chain, combined, price_range=0.15, points=241)
        except Exception:  # noqa: BLE001
            return None
        xs, now, exp = a["x"], a["nowPnl"], a["expiryPnl"]
        cost = 0.0
        for e in extra:
            px = float(e["price"] or 0) * e["lots"] * lot
            cost += px if e["side"] == "BUY" else -px
        hist = None
        if rets:
            pnl = [_interp(xs, exp, spot * (1 + r)) for r in rets]
            risk = abs(a["maxLoss"]) if not a["maxLossUnbounded"] and a["maxLoss"] else None
            hist = _stats(pnl, risk or 0)
        return {
            "name": name, "kind": kind, "why": why, "extra": extra, "costNow": round(cost, 0),
            "maxLoss": a["maxLoss"], "maxLossUnbounded": a["maxLossUnbounded"], "maxProfit": a["maxProfit"],
            "maxProfitUnbounded": a["maxProfitUnbounded"], "breakevens": a["breakevens"], "pop": a["pop"],
            "pnlNow": round(_interp(xs, now, spot), 0), "pnlDown1": round(_interp(xs, now, spot * 0.99), 0),
            "pnlUp1": round(_interp(xs, now, spot * 1.01), 0),
            "margin": a["margin"]["estimate"], "greeks": a["greeks"], "hist": hist,
        }

    def px_for(l: dict, ot: str, side: str):
        r = row_of(l)
        if not r:
            return None
        p = sell_px(r, ot) if side == "SELL" else buy_px(r, ot)
        return p if p > 0 else None

    cands: list[dict] = []
    base = evaluate("Do nothing", "none", [], "Keep the position as it is.")
    if base:
        cands.append(base)

    t_legs = [l for l in base_legs if tested(l)]
    for l in t_legs:
        ot, k, n = l["optionType"], l["strike"], l["lots"]
        label = f"{int(k)} {'put' if ot == 'PE' else 'call'}"
        close_px = px_for(k, ot, "BUY")
        if close_px:
            c = evaluate(f"Close the {label}", "close", [{"optionType": ot, "strike": k, "side": "BUY", "lots": n, "price": round(close_px, 2)}],
                         "Buy back the tested leg now and take the loss; what is left stays open.")
            if c:
                cands.append(c)
        sign = -1 if ot == "PE" else 1  # further out of the money
        for m in (2, 4, 6):
            k2 = k + sign * m * step
            sell2, buy1 = px_for(k2, ot, "SELL"), close_px
            if sell2 and buy1:
                c = evaluate(f"Roll the {label} to {int(k2)}", "roll",
                             [{"optionType": ot, "strike": k, "side": "BUY", "lots": n, "price": round(buy1, 2)},
                              {"optionType": ot, "strike": k2, "side": "SELL", "lots": n, "price": round(sell2, 2)}],
                             "Buy back the tested leg and sell the same option further from the market, same expiry.")
                if c:
                    cands.append(c)
        for m in (2, 4, 8):
            k3 = k + sign * m * step
            b3 = px_for(k3, ot, "BUY")
            if b3:
                c = evaluate(f"Buy a {int(k3)} {'put' if ot == 'PE' else 'call'} as protection", "hedge",
                             [{"optionType": ot, "strike": k3, "side": "BUY", "lots": n, "price": round(b3, 2)}],
                             "Keep the position and add a bought option behind the tested leg: it caps the loss on that side.")
                if c:
                    cands.append(c)
    # protection on BOTH sides: the move that turns a naked strangle into a defined-loss iron condor
    sp_ = [l for l in base_legs if l["side"] == "SELL" and l["optionType"] == "PE"]
    sc_ = [l for l in base_legs if l["side"] == "SELL" and l["optionType"] == "CE"]
    has_long = {ot: any(l["side"] == "BUY" and l["optionType"] == ot for l in base_legs) for ot in ("PE", "CE")}
    if (sp_ and not has_long["PE"]) or (sc_ and not has_long["CE"]):
        for m in (3, 6, 10):
            extra = []
            if sp_ and not has_long["PE"]:
                kp = min(l["strike"] for l in sp_) - m * step
                p_ = px_for(kp, "PE", "BUY")
                if p_:
                    extra.append({"optionType": "PE", "strike": kp, "side": "BUY", "lots": max(l["lots"] for l in sp_), "price": round(p_, 2)})
            if sc_ and not has_long["CE"]:
                kc = max(l["strike"] for l in sc_) + m * step
                c_ = px_for(kc, "CE", "BUY")
                if c_:
                    extra.append({"optionType": "CE", "strike": kc, "side": "BUY", "lots": max(l["lots"] for l in sc_), "price": round(c_, 2)})
            if extra and len(extra) == int(bool(sp_ and not has_long["PE"])) + int(bool(sc_ and not has_long["CE"])):
                c = evaluate(f"Add protection on both sides ({m} strikes out)", "wings", extra,
                             "Buy a put and a call behind your sold strikes so the loss is capped on both sides (it becomes an iron condor).")
                if c:
                    cands.append(c)
    # close everything
    allx = []
    for l in base_legs:
        if l["optionType"] == "FUT":
            continue
        opp = "SELL" if l["side"] == "BUY" else "BUY"
        p = px_for(l["strike"], l["optionType"], opp)
        if p:
            allx.append({"optionType": l["optionType"], "strike": l["strike"], "side": opp, "lots": l["lots"], "price": round(p, 2)})
    if allx:
        c = evaluate("Close everything", "exit", allx, "Exit every leg at the current bid / ask and book the result.")
        if c:
            cands.append(c)

    # tags: cheapest fix, biggest risk cut, most profit kept (among the candidates that change something)
    ch = [c for c in cands if c["kind"] not in ("none", "exit")]
    defined = [c for c in ch if not c["maxLossUnbounded"]]
    tags: dict[str, str] = {}
    if defined:
        tags["lowRisk"] = min(defined, key=lambda c: abs(c["maxLoss"]))["name"]
        tags["cheapest"] = min(defined, key=lambda c: c["costNow"])["name"]
        tags["keepsMost"] = max(defined, key=lambda c: c["maxProfit"])["name"]
    ok = []
    if max_loss:
        ok = [c["name"] for c in ch if not c["maxLossUnbounded"] and abs(c["maxLoss"]) <= float(max_loss) + 1]
    return {
        "symbol": symbol, "expiry": chain.get("expiry"), "spot": spot, "sessions": sess, "lotSize": lot,
        "legs": base_legs, "tested": [{"strike": l["strike"], "optionType": l["optionType"]} for l in t_legs],
        "options": cands, "tags": tags, "withinLimit": ok, "maxLoss": max_loss, "windows": len(rets) if rets else 0,
    }
