"""Trend-day guard: is today a trend day, and has it started to reverse?

Asked 2026-09-28 by a trader whose fear of a reversal on a trend day made them trade the reversal
BEFORE it happened (selling puts all through a falling day). This answers "is it reversing yet?"
with evidence instead of a feeling: a reversal needs 2 of these 3 signs, all against the day's trend:

  1. structure -- 15-min price structure turns the other way (a close through the last swing, or
     higher-highs-and-lows on a down day) -- same swing rules as the Home trend table;
  2. OI       -- the day's Put OI change crosses the Call OI change the other way (the Trend OI
     Crossover view);
  3. flow     -- the 15-min option flow turns the other way (the Flow tab's state).

A trend day = the index is at least 0.30% away from the day's first reading AND the OI leads the
same way (calls building faster on a down day, puts on an up day), or 0.60% away whatever the OI.
`tick()` alerts once when the signs reach 2 of 3 (re-arms after they fall back to 0 or 1), at most
3 times a day per index."""
from __future__ import annotations

import time
from datetime import datetime

from .processing import IST
from .store import store

WATCH = ("NIFTY", "SENSEX", "BANKNIFTY")
TREND_PCT, STRONG_PCT, OI_LEAD = 0.30, 0.60, 1.15
_alerted: dict[str, dict] = {}   # symbol -> {"day", "armed", "n"}


def _swings(c: list[dict], n: int = 2) -> tuple[list[float], list[float]]:
    highs, lows = [], []
    for i in range(n, len(c) - n):
        is_h = all(c[i]["high"] > c[i - k]["high"] and c[i]["high"] >= c[i + k]["high"] for k in range(1, n + 1))
        is_l = all(c[i]["low"] < c[i - k]["low"] and c[i]["low"] <= c[i + k]["low"] for k in range(1, n + 1))
        if is_h:
            highs.append(c[i]["high"])
        if is_l:
            lows.append(c[i]["low"])
    return highs, lows


def structure(c: list[dict]) -> dict | None:
    """The Home trend table's price-action structure (TrendCompass.tsx structure()), in Python."""
    highs, lows = _swings(c)
    if len(highs) < 2 or len(lows) < 2:
        return None
    h1, h2 = highs[-2:]
    l1, l2 = lows[-2:]
    close = c[-1]["close"]
    eps = close * 0.0003
    hi = "HH" if h2 > h1 + eps else "LH" if h2 < h1 - eps else "EH"
    lo = "HL" if l2 > l1 + eps else "LL" if l2 < l1 - eps else "EL"
    d = "up" if (hi, lo) == ("HH", "HL") else "down" if (hi, lo) == ("LH", "LL") else "mixed"
    broke = "up" if close > h2 else "down" if close < l2 else None
    if broke == "up":
        d = "mixed" if d == "down" else "up"
    if broke == "down":
        d = "mixed" if d == "up" else "down"
    return {"dir": d, "hi": hi, "lo": lo, "lastHigh": h2, "lastLow": l2, "broke": broke}


async def _candles_15m(symbol: str) -> list[dict]:
    from . import upstox_data
    from .charting import bucket_start

    raw = await upstox_data.fetch_underlying_candles(symbol, 900)
    b: dict[int, dict] = {}
    for x in raw or []:
        k = bucket_start(float(x["time"]), 900)
        cur = b.get(k)
        if cur is None:
            b[k] = {"time": k, "open": x["open"], "high": x["high"], "low": x["low"], "close": x["close"]}
        else:
            cur["high"] = max(cur["high"], x["high"])
            cur["low"] = min(cur["low"], x["low"])
            cur["close"] = x["close"]
    return [b[k] for k in sorted(b)][-60:]   # a few sessions: enough swings for the structure


async def read(symbol: str) -> dict:
    """{trend: "up" | "down" | None, move, pct, since, signs: [{key, label, on, detail}], count}."""
    from . import flow, pcr_series

    symbol = symbol.upper()
    out: dict = {"symbol": symbol, "trend": None, "move": None, "pct": None, "since": None,
                 "signs": [], "count": 0, "asOf": time.time()}
    d = pcr_series.build(symbol, None, 5, store.get_history(symbol))
    f = d.get("fields") or []
    if not f or not d.get("points"):
        return out
    ix = {k: f.index(k) for k in f}
    pts = [p for p in d["points"] if p[ix["spot"]]]
    if len(pts) < 3:
        return out
    day = datetime.fromtimestamp(pts[-1][ix["t"]], IST).date()
    pts = [p for p in pts if datetime.fromtimestamp(p[ix["t"]], IST).date() == day]
    if len(pts) < 3:
        return out
    o, now = float(pts[0][ix["spot"]]), float(pts[-1][ix["spot"]])
    dce = float(pts[-1][ix["ceOIChg"]] or 0) if "ceOIChg" in ix else 0.0
    dpe = float(pts[-1][ix["peOIChg"]] or 0) if "peOIChg" in ix else 0.0
    pct = (now - o) / o * 100 if o else 0.0
    out.update(move=round(now - o, 1), pct=round(pct, 2), since=pts[0][ix["t"]], open=o, spot=now,
               callChg=dce, putChg=dpe)
    calls_lead = dce > 0 and dce > dpe * OI_LEAD
    puts_lead = dpe > 0 and dpe > dce * OI_LEAD
    if pct <= -STRONG_PCT or (pct <= -TREND_PCT and calls_lead):
        trend = "down"
    elif pct >= STRONG_PCT or (pct >= TREND_PCT and puts_lead):
        trend = "up"
    else:
        return out
    out["trend"] = trend
    against = "up" if trend == "down" else "down"

    # 1. structure (15-min candles)
    st = None
    try:
        st = structure(await _candles_15m(symbol))
    except Exception:  # noqa: BLE001 -- no candles (not logged in to Upstox): the sign just stays off
        st = None
    st_on = bool(st and (st["dir"] == against or st["broke"] == against))
    st_detail = (
        "no candles yet" if not st else
        f"15m structure {st['hi']}·{st['lo']}" + (f", closed {'above' if st['broke'] == 'up' else 'below'} the last swing" if st["broke"] else "")
    )
    # 2. OI crossover
    oi_on = (dpe > dce) if trend == "down" else (dce > dpe)
    # 3. 15-min flow
    fl_dir = None
    chain = store.get_chain(symbol)
    if chain:
        try:
            fl_dir = (flow.view(symbol, chain["expiry"], "15", chain.get("spot")).get("state") or {}).get("dir")
        except Exception:  # noqa: BLE001
            fl_dir = None
    fl_on = fl_dir == ("bull" if trend == "down" else "bear")
    word = "buying" if trend == "down" else "selling"
    out["signs"] = [
        {"key": "structure", "label": f"structure turns {against}", "on": st_on, "detail": st_detail},
        {"key": "oi", "label": ("puts overtake calls" if trend == "down" else "calls overtake puts"), "on": oi_on,
         "detail": f"Put Δ {dpe / 1e7:.2f}Cr vs Call Δ {dce / 1e7:.2f}Cr"},
        {"key": "flow", "label": f"{word} takes over", "on": fl_on, "detail": f"15-min flow: {fl_dir or 'warming up'}"},
    ]
    out["count"] = sum(1 for s in out["signs"] if s["on"])
    return out


async def tick() -> list[dict]:
    """An alert when an index's trend-day reversal signs reach 2 of 3 (once, re-armed below 2)."""
    events: list[dict] = []
    today = datetime.now(IST).date().isoformat()
    for sym in WATCH:
        try:
            r = await read(sym)
        except Exception:  # noqa: BLE001
            continue
        a = _alerted.setdefault(sym, {"day": today, "armed": True, "n": 0})
        if a["day"] != today:
            a.update(day=today, armed=True, n=0)
        if not r["trend"] or r["count"] < 2:
            a["armed"] = True
            continue
        if not a["armed"] or a["n"] >= 3:
            continue
        a["armed"] = False
        a["n"] += 1
        on = ", ".join(s["label"] for s in r["signs"] if s["on"])
        arrow = "▲" if r["trend"] == "down" else "▼"
        events.append({
            "kind": "trend-reversal", "symbol": sym, "severity": "warning",
            "message": (f"{arrow} {sym}: possible reversal of today's {r['trend'].upper()} trend — {r['count']} of 3 signs "
                        f"({on}). Spot {r['spot']:,.0f}, {r['move']:+,.0f} pts on the day. A sign, not a signal: "
                        "confirm on the chart before trading against the trend."),
        })
    return events
