"""Multi-leg option strategy analytics: payoff, combined Greeks, margin, save/load.

A leg is {optionType: 'CE'|'PE'|'FUT', strike, side: 'BUY'|'SELL', lots, price?}.
Entry price / IV / per-leg Greeks are pulled from the current processed chain when
not supplied. Everything is a heuristic aid, not broker-accurate (margin especially).
"""
from __future__ import annotations

import json
import math
import time
import uuid

from .config import DATA_DIR, DIVIDEND_YIELD, RISK_FREE_RATE
from .greeks import bs_price
from .processing import year_fraction

_FILE = DATA_DIR / "strategies.json"
_SQRT2PI = math.sqrt(2 * math.pi)


def _sign(side: str) -> int:
    return 1 if side.upper() == "BUY" else -1


def _row_for(chain: dict, strike: float) -> dict | None:
    for r in chain["rows"]:
        if abs(r["strike"] - strike) < 1e-6:
            return r
    return None


def _resolve_leg(chain: dict, leg: dict) -> dict:
    ot = leg["optionType"].upper()
    lots = int(leg["lots"])
    qty = lots * chain["lotSize"]
    row = _row_for(chain, leg.get("strike", 0.0))
    atm_iv = (chain.get("atmIV") or 15.0) / 100.0

    if ot == "FUT":
        entry = float(leg.get("price") or chain["spot"])
        iv = atm_iv
        g = {"delta": 1.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    else:
        side = None
        if row:
            side = row["call"] if ot == "CE" else row["put"]
        if leg.get("price") is not None:
            entry = float(leg["price"])
        elif side:
            entry = float(side["ltp"] or ((side["bid"] + side["ask"]) / 2) or 0.0)
        else:
            entry = 0.0
        iv = ((side["ivCalc"] or side["iv"]) if side else None)
        iv = (iv / 100.0) if iv else atm_iv
        g = (
            {k: side[k] for k in ("delta", "gamma", "theta", "vega")}
            if side
            else {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
        )
    return {
        "optionType": ot,
        "strike": leg.get("strike", 0.0),
        "side": leg["side"].upper(),
        "lots": lots,
        "qty": qty,
        "entry": round(entry, 2),
        "iv": round(iv * 100, 2),
        "greeks": g,
    }


def _leg_intrinsic(ot: str, strike: float, S: float) -> float:
    if ot == "CE":
        return max(S - strike, 0.0)
    if ot == "PE":
        return max(strike - S, 0.0)
    return S  # FUT: handled with entry separately


def _payoff_at(resolved: list[dict], S: float, t: float, mode: str) -> float:
    total = 0.0
    for leg in resolved:
        sgn = _sign(leg["side"])
        qty = leg["qty"]
        if leg["optionType"] == "FUT":
            total += sgn * (S - leg["entry"]) * qty
        elif mode == "expiry":
            total += sgn * (_leg_intrinsic(leg["optionType"], leg["strike"], S) - leg["entry"]) * qty
        else:  # "now" — theoretical value with time left
            px = bs_price(
                leg["optionType"], S, leg["strike"], max(t, 1e-6),
                RISK_FREE_RATE, DIVIDEND_YIELD, leg["iv"] / 100.0,
            )
            total += sgn * (px - leg["entry"]) * qty
    return total


def _margin(
    resolved: list[dict],
    spot: float,
    lot_size: int,
    max_loss: float,
    net_premium: float,
    loss_unbounded: bool,
) -> dict:
    shorts = [l for l in resolved if l["side"] == "SELL"]
    if not shorts:
        return {"estimate": round(max(net_premium, 0.0), 2), "basis": "debit paid (long options)"}
    if not loss_unbounded:
        return {
            "estimate": round(abs(max_loss) * 1.05, 2),
            "basis": "defined risk ~ max loss + 5%",
        }
    m = 0.0
    for l in shorts:
        m += 0.12 * spot * l["qty"] + l["entry"] * l["qty"]
    for l in resolved:
        if l["side"] == "BUY" and l["optionType"] != "FUT":
            m -= 0.06 * spot * l["qty"]
    return {
        "estimate": round(max(m, 0.06 * spot * lot_size), 2),
        "basis": "naked-short heuristic ~ 12% of notional (not SPAN)",
    }


def analyze(chain: dict, legs: list[dict], price_range: float = 0.10, points: int = 121) -> dict:
    spot = chain["spot"]
    expiry = chain["expiry"]
    t = year_fraction(expiry)
    ls = chain["lotSize"]
    points = max(41, min(points, 401))

    resolved = [_resolve_leg(chain, leg) for leg in legs]

    net_premium = 0.0
    gsum = {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0}
    for leg in resolved:
        sgn = _sign(leg["side"])
        net_premium += sgn * leg["entry"] * leg["qty"]
        for k in gsum:
            gsum[k] += sgn * leg["greeks"].get(k, 0.0) * leg["qty"]

    lo, hi = spot * (1 - price_range), spot * (1 + price_range)
    xs = [lo + (hi - lo) * i / (points - 1) for i in range(points)]
    exp_curve = [round(_payoff_at(resolved, S, t, "expiry"), 2) for S in xs]
    now_curve = [round(_payoff_at(resolved, S, t, "now"), 2) for S in xs]

    max_profit, max_loss = max(exp_curve), min(exp_curve)
    up_unbounded = exp_curve[-1] > exp_curve[-2]
    dn_unbounded = exp_curve[0] > exp_curve[1]
    loss_up_unbounded = exp_curve[-1] < exp_curve[-2] and exp_curve[-1] <= max_loss + 1e-6
    loss_dn_unbounded = exp_curve[0] < exp_curve[1] and exp_curve[0] <= max_loss + 1e-6

    step = chain.get("strikeStep") or 50.0
    eps = max(1.0, 0.01 * chain["lotSize"])  # treat |pnl| < eps as "on the zero line"
    raw_be: list[float] = []
    for i in range(1, len(xs)):
        a, b = exp_curve[i - 1], exp_curve[i]
        if abs(a) < eps and abs(b) < eps:
            continue  # flat on the zero line -> not a crossing
        if a == 0.0 and b != 0.0:
            raw_be.append(xs[i - 1])
        elif a * b < 0:
            raw_be.append(xs[i - 1] + (xs[i] - xs[i - 1]) * abs(a) / (abs(a) + abs(b)))
    breakevens: list[float] = []
    for be in sorted(raw_be):
        if not breakevens or be - breakevens[-1] > 0.5 * step:
            breakevens.append(round(be, 2))

    # probability of profit via lognormal terminal distribution (ATM IV)
    sigma = (chain.get("atmIV") or 15.0) / 100.0
    pop = None
    if t > 0 and sigma > 0 and spot > 0:
        mu = math.log(spot) + (RISK_FREE_RATE - DIVIDEND_YIELD - 0.5 * sigma * sigma) * t
        sd = sigma * math.sqrt(t)
        n = 400
        tot = win = 0.0
        for i in range(n):
            S = lo + (hi - lo) * i / (n - 1)
            if S <= 0:
                continue
            w = math.exp(-((math.log(S) - mu) ** 2) / (2 * sd * sd)) / (S * sd * _SQRT2PI)
            tot += w
            if _payoff_at(resolved, S, t, "expiry") > 0:
                win += w
        pop = round(100 * win / tot, 1) if tot else None

    loss_unbounded = bool(loss_up_unbounded or loss_dn_unbounded)
    margin = _margin(resolved, spot, ls, max_loss, net_premium, loss_unbounded)
    total_lots = sum(l["lots"] for l in resolved) or 1
    rr = round(abs(max_profit / max_loss), 2) if (max_loss < 0 and max_profit > 0) else None

    return {
        "symbol": chain["symbol"],
        "expiry": expiry,
        "spot": spot,
        "lotSize": ls,
        "dte": chain["dte"],
        "legs": [{k: v for k, v in l.items() if k != "greeks"} | {"greeks": {gk: round(gv, 4) for gk, gv in l["greeks"].items()}} for l in resolved],
        "x": [round(v, 2) for v in xs],
        "expiryPnl": exp_curve,
        "nowPnl": now_curve,
        "netPremium": round(net_premium, 2),
        "netPremiumType": "DEBIT" if net_premium > 0 else "CREDIT",
        "maxProfit": round(max_profit, 2),
        "maxLoss": round(max_loss, 2),
        "maxProfitUnbounded": bool(up_unbounded or dn_unbounded),
        "maxLossUnbounded": loss_unbounded,
        "breakevens": breakevens,
        "pop": pop,
        "rr": rr,
        "greeks": {k: round(v, 2) for k, v in gsum.items()},
        "greeksPerLot": {k: round(v / total_lots, 4) for k, v in gsum.items()},
        "margin": margin,
    }


# --------------------------------------------------------------------------
# Hedge finder — cap a running position's loss at a target rupee amount
# --------------------------------------------------------------------------
def find_hedge(
    chain: dict,
    legs: list[dict],
    max_loss: float,
    max_lots: int = 1,
    span: int = 16,
) -> dict:
    base = analyze(chain, legs)
    target = abs(float(max_loss))
    step = chain["strikeStep"] or 50.0
    atm = chain["atmStrike"]
    # hedge sizing matches the strategy's own lots (1:1). max_lots>1 allows a
    # ratio hedge up to that multiple of the position size.
    pos_lots = max((int(l["lots"]) for l in legs), default=1)
    lot_choices = [pos_lots * m for m in range(1, max(1, max_lots) + 1)]

    out = {
        "target": -round(target, 2),
        "current": {
            "maxLoss": base["maxLoss"],
            "maxLossUnbounded": base["maxLossUnbounded"],
            "maxProfit": base["maxProfit"],
            "maxProfitUnbounded": base["maxProfitUnbounded"],
            "netPremium": base["netPremium"],
            "pop": base["pop"],
            "rr": base["rr"],
            "breakevens": base["breakevens"],
        },
        "suggestions": [],
        "note": "",
    }

    if not base["maxLossUnbounded"] and abs(base["maxLoss"]) <= target + 1:
        out["note"] = "Position max loss is already within your target — no hedge needed."
        return out

    cands: list[dict] = []
    for off in range(-span, span + 1):
        strike = atm + off * step
        row = _row_for(chain, strike)
        if not row:
            continue
        for ot in ("CE", "PE"):
            leg_px = (row["call"] if ot == "CE" else row["put"])["ltp"]
            if not leg_px or leg_px <= 0:
                continue
            for lots in lot_choices:
                hedge = {"optionType": ot, "strike": strike, "side": "BUY", "lots": lots}
                a = analyze(chain, legs + [hedge])
                if a["maxLossUnbounded"] or abs(a["maxLoss"]) > target + 1:
                    continue
                cost = round(a["netPremium"] - base["netPremium"], 0)  # extra debit
                profit_give_up = round((base["maxProfit"] or 0) - (a["maxProfit"] or 0), 0)
                cands.append(
                    {
                        "leg": hedge,
                        "label": f"BUY {lots}× {int(strike)} {ot}",
                        "entry": round(leg_px, 2),
                        "cost": cost,
                        "profitGiveUp": profit_give_up,
                        "resultMaxLoss": a["maxLoss"],
                        "resultMaxProfit": a["maxProfit"],
                        "resultMaxProfitUnbounded": a["maxProfitUnbounded"],
                        "resultPop": a["pop"],
                        "resultRR": a["rr"],
                        "resultBreakevens": a["breakevens"],
                        "resultGreeks": a["greeks"],
                        "resultMargin": a["margin"]["estimate"],
                    }
                )
                break  # cheapest (fewest lots) that works for this strike/side

    # ---- pair pass: buy a CE wing + a PE wing (two-sided risk) ----
    if not cands and base["maxLossUnbounded"]:
        pspan = min(span, 10)
        ce_strikes = [atm + n * step for n in range(0, pspan + 1)]
        pe_strikes = [atm - n * step for n in range(0, pspan + 1)]
        for ck in ce_strikes:
            cr = _row_for(chain, ck)
            if not cr or not (cr["call"]["ltp"] or 0) > 0:
                continue
            for pk in pe_strikes:
                pr = _row_for(chain, pk)
                if not pr or not (pr["put"]["ltp"] or 0) > 0:
                    continue
                for lots in lot_choices:
                    pair = [
                        {"optionType": "CE", "strike": ck, "side": "BUY", "lots": lots},
                        {"optionType": "PE", "strike": pk, "side": "BUY", "lots": lots},
                    ]
                    a = analyze(chain, legs + pair)
                    if a["maxLossUnbounded"] or abs(a["maxLoss"]) > target + 1:
                        continue
                    cost = round(a["netPremium"] - base["netPremium"], 0)
                    cands.append(
                        {
                            "leg": pair,
                            "label": f"BUY {lots}× {int(ck)} CE + {lots}× {int(pk)} PE",
                            "entry": round(cr["call"]["ltp"] + pr["put"]["ltp"], 2),
                            "cost": cost,
                            "profitGiveUp": round(
                                (base["maxProfit"] or 0) - (a["maxProfit"] or 0), 0
                            ),
                            "resultMaxLoss": a["maxLoss"],
                            "resultMaxProfit": a["maxProfit"],
                            "resultMaxProfitUnbounded": a["maxProfitUnbounded"],
                            "resultPop": a["pop"],
                            "resultRR": a["rr"],
                            "resultBreakevens": a["breakevens"],
                            "resultGreeks": a["greeks"],
                            "resultMargin": a["margin"]["estimate"],
                        }
                    )
                    break

    # rank: cheapest hedge, then least profit given up, then best POP
    cands.sort(key=lambda c: (c["cost"], c["profitGiveUp"], -(c["resultPop"] or 0)))
    seen: set = set()
    for c in cands:
        legk = c["leg"] if isinstance(c["leg"], list) else [c["leg"]]
        k = tuple((l["optionType"], l["strike"]) for l in legk)
        if k in seen:
            continue
        seen.add(k)
        out["suggestions"].append(c)
        if len(out["suggestions"]) >= 6:
            break

    if not out["suggestions"]:
        out["note"] = (
            "Couldn't cap the loss at that level with a simple bought hedge. "
            "Raise the target amount or reduce position size."
        )
    return out


# --------------------------------------------------------------------------
# Prebuilt templates
# --------------------------------------------------------------------------
def templates(chain: dict) -> dict:
    step = chain["strikeStep"] or 50.0
    atm = chain["atmStrike"]

    def k(n: int) -> float:
        return atm + n * step

    raw = {
        "Long Straddle": [("CE", atm, "BUY", 1), ("PE", atm, "BUY", 1)],
        "Short Straddle": [("CE", atm, "SELL", 1), ("PE", atm, "SELL", 1)],
        "Long Strangle": [("CE", k(2), "BUY", 1), ("PE", k(-2), "BUY", 1)],
        "Short Strangle": [("CE", k(3), "SELL", 1), ("PE", k(-3), "SELL", 1)],
        "Bull Call Spread": [("CE", atm, "BUY", 1), ("CE", k(4), "SELL", 1)],
        "Bear Put Spread": [("PE", atm, "BUY", 1), ("PE", k(-4), "SELL", 1)],
        "Bull Put Spread": [("PE", k(-4), "BUY", 1), ("PE", k(-1), "SELL", 1)],
        "Iron Condor": [
            ("PE", k(-6), "BUY", 1), ("PE", k(-3), "SELL", 1),
            ("CE", k(3), "SELL", 1), ("CE", k(6), "BUY", 1),
        ],
        "Iron Fly": [
            ("PE", k(-4), "BUY", 1), ("PE", atm, "SELL", 1),
            ("CE", atm, "SELL", 1), ("CE", k(4), "BUY", 1),
        ],
        "Call Butterfly": [("CE", k(-3), "BUY", 1), ("CE", atm, "SELL", 2), ("CE", k(3), "BUY", 1)],
        "Call Ratio Backspread": [("CE", atm, "SELL", 1), ("CE", k(3), "BUY", 2)],
    }
    return {
        name: [
            {"optionType": ot, "strike": kk, "side": sd, "lots": lt}
            for (ot, kk, sd, lt) in legs
        ]
        for name, legs in raw.items()
    }


def from_paper(positions: list[dict]) -> dict | None:
    """Pick the symbol/expiry with the most paper legs and turn them into strategy legs."""
    if not positions:
        return None
    groups: dict[tuple, list[dict]] = {}
    for p in positions:
        groups.setdefault((p["symbol"], p["expiry"]), []).append(p)
    (symbol, expiry), legs_src = max(groups.items(), key=lambda kv: len(kv[1]))
    legs = []
    for p in legs_src:
        lots = max(1, round(abs(p["qty"]) / p["lotSize"]))
        legs.append(
            {
                "optionType": p["optionType"],
                "strike": p["strike"],
                "side": "BUY" if p["qty"] > 0 else "SELL",
                "lots": lots,
                "price": p["avgPrice"],
            }
        )
    return {"symbol": symbol, "expiry": expiry, "legs": legs}


def from_broker(positions: list[dict]) -> dict | None:
    """Turn live Flattrade PositionBook rows (open NFO option legs only) into
    strategy legs, same shape as from_paper -- picks the symbol/expiry with the
    most open legs so the hedge finder / builder work on the live position."""
    from .brokers.flattrade import parse_noren_tsym
    from .processing import lot_size

    groups: dict[tuple, list[dict]] = {}
    for p in positions or []:
        try:
            qty = float(p.get("netqty") or 0)
        except (TypeError, ValueError):
            qty = 0.0
        if not qty:
            continue
        parsed = parse_noren_tsym(p.get("tsym", ""))
        if not parsed:
            continue  # not an NFO option in the conventional tsym form (e.g. equity)
        avg = p.get("netavgprc") or p.get("daybuyavgprc") or p.get("daysellavgprc") or 0
        try:
            avg = float(avg)
        except (TypeError, ValueError):
            avg = 0.0
        key = (parsed["symbol"], parsed["expiry"])
        groups.setdefault(key, []).append({**parsed, "qty": qty, "avg": avg})
    if not groups:
        return None
    (symbol, expiry), rows = max(groups.items(), key=lambda kv: len(kv[1]))
    ls = lot_size(symbol)
    legs = [
        {
            "optionType": r["optionType"],
            "strike": r["strike"],
            "side": "BUY" if r["qty"] > 0 else "SELL",
            "lots": max(1, round(abs(r["qty"]) / ls)),
            "price": r["avg"],
        }
        for r in rows
    ]
    return {"symbol": symbol, "expiry": expiry, "legs": legs}


# --------------------------------------------------------------------------
# Persistence
# --------------------------------------------------------------------------
def _load() -> dict:
    try:
        return json.loads(_FILE.read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return {}


def _save(obj: dict) -> None:
    _FILE.write_text(json.dumps(obj, indent=2, default=str), "utf-8")


def list_saved() -> list[dict]:
    return sorted(_load().values(), key=lambda s: s.get("savedAt", 0), reverse=True)


def save_strategy(name: str, symbol: str, expiry: str, legs: list[dict]) -> dict:
    store = _load()
    sid = uuid.uuid4().hex[:10]
    rec = {
        "id": sid,
        "name": name,
        "symbol": symbol.upper(),
        "expiry": expiry,
        "legs": legs,
        "savedAt": time.time(),
    }
    store[sid] = rec
    _save(store)
    return rec


def delete_strategy(sid: str) -> list[dict]:
    store = _load()
    store.pop(sid, None)
    _save(store)
    return list_saved()
