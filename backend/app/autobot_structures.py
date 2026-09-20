"""Multi-leg structures an AutoBot rule can open as ONE trade.

A rule with `"structure": "iron_condor"` (and, optionally, `"offset"` / `"width"`) opens all
of the legs together when its entry signal fires, manages them as a single position on
the structure's NET premium -- one stop-loss, target, breakeven and trail for the whole
thing -- and closes every leg together. The single-option fields (`instrument`, `side`)
are ignored for a structure.

Strikes are placed in whole strike steps from ATM:
    offset  how far the short (or, for a debit structure, the first) strikes sit from ATM
    width   how far the protective / far leg sits beyond that

`net premium` throughout = sum over legs of (+1 for BUY, -1 for SELL) x price. A positive
net is a DEBIT (the position profits when it rises); a negative net is a CREDIT (it profits
when it falls). autobot_exit takes that as `buy=True` / `buy=False` on the absolute net.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

# leg = (option type, strike offset in steps from ATM, side, lot multiple)
Leg = tuple[str, int, str, int]


@dataclass(frozen=True)
class Structure:
    key: str
    title: str
    offset_default: int          # strikes from ATM to the first leg(s)
    width_default: int           # 0 = the structure has no wing / spread width
    legs: Callable[[int, int], list[Leg]]
    blurb: str


STRUCTURES: dict[str, Structure] = {s.key: s for s in (
    Structure("short_straddle", "Short straddle", 0, 0,
              lambda k, w: [("CE", 0, "SELL", 1), ("PE", 0, "SELL", 1)],
              "Sell the ATM call and put. Collects the most premium; unlimited risk."),
    Structure("long_straddle", "Long straddle", 0, 0,
              lambda k, w: [("CE", 0, "BUY", 1), ("PE", 0, "BUY", 1)],
              "Buy the ATM call and put. Profits from a big move either way."),
    Structure("short_strangle", "Short strangle", 2, 0,
              lambda k, w: [("CE", k, "SELL", 1), ("PE", -k, "SELL", 1)],
              "Sell an OTM call and an OTM put. Wider than a straddle; unlimited risk."),
    Structure("long_strangle", "Long strangle", 2, 0,
              lambda k, w: [("CE", k, "BUY", 1), ("PE", -k, "BUY", 1)],
              "Buy an OTM call and an OTM put. Cheaper than a straddle."),
    Structure("iron_condor", "Iron condor", 2, 2,
              lambda k, w: [("CE", k, "SELL", 1), ("CE", k + w, "BUY", 1),
                            ("PE", -k, "SELL", 1), ("PE", -(k + w), "BUY", 1)],
              "Short strangle with bought wings. Defined risk."),
    Structure("iron_fly", "Iron butterfly", 0, 2,
              lambda k, w: [("CE", 0, "SELL", 1), ("PE", 0, "SELL", 1),
                            ("CE", w, "BUY", 1), ("PE", -w, "BUY", 1)],
              "Short straddle with bought wings. Defined risk."),
    Structure("bull_call_spread", "Bull call spread", 0, 2,
              lambda k, w: [("CE", k, "BUY", 1), ("CE", k + w, "SELL", 1)],
              "Buy a call, sell a higher call. Defined-risk bullish debit spread."),
    Structure("bear_put_spread", "Bear put spread", 0, 2,
              lambda k, w: [("PE", -k, "BUY", 1), ("PE", -(k + w), "SELL", 1)],
              "Buy a put, sell a lower put. Defined-risk bearish debit spread."),
    Structure("bull_put_spread", "Bull put spread", 1, 2,
              lambda k, w: [("PE", -k, "SELL", 1), ("PE", -(k + w), "BUY", 1)],
              "Sell a put, buy a lower put. Defined-risk bullish credit spread."),
    Structure("bear_call_spread", "Bear call spread", 1, 2,
              lambda k, w: [("CE", k, "SELL", 1), ("CE", k + w, "BUY", 1)],
              "Sell a call, buy a higher call. Defined-risk bearish credit spread."),
)}

MAX_STEPS = 30     # the chain only carries strikes this far from ATM


def is_structure(rule: dict) -> bool:
    return (rule.get("structure") or "single") in STRUCTURES


def clamp_params(key: str, offset, width) -> tuple[int, int]:
    s = STRUCTURES[key]
    try:
        k = int(offset) if offset not in (None, "") else s.offset_default
    except (TypeError, ValueError):
        k = s.offset_default
    try:
        w = int(width) if width not in (None, "") else s.width_default
    except (TypeError, ValueError):
        w = s.width_default
    k = max(0, min(k, MAX_STEPS))
    # a structure with wings needs at least 1 step of width, or its far leg IS its near leg
    w = max(1, min(w, MAX_STEPS)) if s.width_default else 0
    return k, w


def legs_for(key: str, atm: float, step: float, offset=None, width=None) -> list[dict]:
    """Concrete legs around `atm`: [{ot, strike, side, mult}]."""
    s = STRUCTURES[key]
    k, w = clamp_params(key, offset, width)
    out = []
    for ot, off, side, mult in s.legs(k, w):
        out.append({"ot": ot, "strike": round(atm + off * step, 2), "side": side, "mult": mult})
    return out


def title(key: str) -> str:
    return STRUCTURES[key].title


def label(key: str, legs: list[dict]) -> str:
    """Short position label, e.g. 'Iron condor 23150P 23250P 23450C 23550C'."""
    parts = sorted(legs, key=lambda lg: (lg["ot"], lg["strike"]))
    return f"{title(key)} " + " ".join(f"{lg['strike']:g}{lg['ot'][0]}" for lg in parts)


def net_premium(legs: list[dict], prices: list[float]) -> float:
    """Signed net: positive = debit, negative = credit."""
    return sum((1 if lg["side"] == "BUY" else -1) * int(lg.get("mult", 1)) * p for lg, p in zip(legs, prices))


def catalog() -> list[dict]:
    """What the rule editor needs to offer each structure: its defaults, and which of the two
    strike parameters actually change its legs (a straddle has neither)."""
    return [{"key": s.key, "title": s.title, "offset": s.offset_default, "width": s.width_default,
             "blurb": s.blurb, "legs": len(s.legs(1, 1)),
             "hasOffset": s.legs(1, 1) != s.legs(2, 1), "hasWidth": s.legs(1, 1) != s.legs(1, 2)}
            for s in STRUCTURES.values()]


def payoff_limits(legs: list[dict], prices: list[float]) -> dict:
    """Best and worst P&L per unit AT EXPIRY, or None where the payoff is unbounded that way.
    Positive = profit. Evaluated at every strike (a payoff is piecewise-linear between them),
    at spot 0 and far above the top strike; the slope beyond the top strike says whether the
    upside is unbounded."""
    def pnl(spot: float) -> float:
        total = 0.0
        for lg, px in zip(legs, prices):
            intrinsic = max(spot - lg["strike"], 0.0) if lg["ot"] == "CE" else max(lg["strike"] - spot, 0.0)
            total += (1 if lg["side"] == "BUY" else -1) * int(lg.get("mult", 1)) * (intrinsic - px)
        return total

    top = max(lg["strike"] for lg in legs)
    pts = sorted({0.0, *[lg["strike"] for lg in legs], top * 3})
    vals = [pnl(x) for x in pts]
    slope_up = sum((1 if lg["side"] == "BUY" else -1) * int(lg.get("mult", 1)) for lg in legs if lg["ot"] == "CE")
    return {
        "maxProfit": None if slope_up > 0 else max(vals),
        "maxLoss": None if slope_up < 0 else -min(vals),
    }
