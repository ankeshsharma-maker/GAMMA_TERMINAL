"""Drop-Base-Rally (DBR) demand zones on daily candles.

A DBR is: a sharp DROP (1-3 big bearish candles), a short BASE (1-5 small candles that pause
the fall), then a strong RALLY candle that closes above the base. The base is where buyers
absorbed the selling, so it is the "demand zone": proximal line = the top of the base bodies
(first price a pullback meets), distal line = the lowest low of the base (the stop).

`detect(past)` takes daily candles NEWEST FIRST, [ts, o, h, l, c, v, ...] (what the volume
baseline already holds -- no extra Upstox calls) and returns the most recent zone that has not
failed, or, failing that, a recently failed one. `live(z, ltp)` turns it into today's status.
"""
from __future__ import annotations

LOOKBACK = 90  # the rally candle must be within this many sessions
ATR_N = 14
DROP_ATR = 1.5  # the drop must cover at least this many ATRs
BODY_BIG = 0.6  # a drop / rally candle's body is >= 60% of its range
BODY_SMALL = 0.4  # a base candle's body is <= 40% of its range ...
BASE_ATR = 0.6  # ... or at most this many ATRs
BASE_H_ATR = 1.5  # the whole base is at most this many ATRs tall
RALLY_X = 1.5  # rally body >= this x the base's average body
RALLY_ATR = 1.0  # ... and at least one ATR
MAX_BASE, MAX_DROP = 5, 3
CA_JUMP = 0.25  # a >25% close-to-close jump in the pattern = probably a split / bonus, skip


def _num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def _bars(past: list) -> list[dict]:
    out = []
    for c in reversed(past):  # oldest -> newest
        o, h, lo, cl = (_num(c[i]) for i in (1, 2, 3, 4))
        if None in (o, h, lo, cl) or h < lo:
            continue
        out.append({"d": str(c[0])[:10], "o": o, "h": h, "l": lo, "c": cl, "v": _num(c[5]) if len(c) > 5 else None})
    return out


def _atr(cs: list[dict]) -> list[float | None]:
    """atr[i] = mean true range of the ATR_N candles ending at i."""
    tr = []
    for i, x in enumerate(cs):
        pc = cs[i - 1]["c"] if i else x["c"]
        tr.append(max(x["h"] - x["l"], abs(x["h"] - pc), abs(x["l"] - pc)))
    out: list[float | None] = []
    for i in range(len(cs)):
        out.append(sum(tr[i - ATR_N + 1 : i + 1]) / ATR_N if i >= ATR_N - 1 else None)
    return out


def _body(x: dict) -> float:
    return abs(x["c"] - x["o"])


def _rng(x: dict) -> float:
    return x["h"] - x["l"]


def _try(cs: list[dict], atr: list, r: int) -> dict | None:
    """A DBR whose rally candle is cs[r], or None."""
    R = cs[r]
    a = atr[r - 1] if r else None
    if not a or a <= 0 or _rng(R) <= 0:
        return None
    if not (R["c"] > R["o"] and _body(R) >= BODY_BIG * _rng(R) and _body(R) >= RALLY_ATR * a):
        return None
    for k in range(1, MAX_BASE + 1):  # fewest base candles first = the tightest reading
        s = r - k
        if s < 1:
            break
        base = cs[s:r]
        if any(not (_body(x) <= BODY_SMALL * _rng(x) or _body(x) <= BASE_ATR * a) for x in base):
            break  # a big candle in the base: more candles won't fix that either
        prox = max(max(x["o"], x["c"]) for x in base)
        dist = min(x["l"] for x in base)
        if max(x["h"] for x in base) - dist > BASE_H_ATR * a:
            continue
        avg_body = sum(_body(x) for x in base) / len(base)
        if R["c"] <= prox or _body(R) < RALLY_X * avg_body:
            continue
        # the drop: 1-3 bearish candles right before the base
        j = s - 1
        m = 0
        while m < MAX_DROP and j - m >= 0 and cs[j - m]["c"] < cs[j - m]["o"]:
            m += 1
        if m == 0:
            continue
        last = cs[j]
        if _rng(last) <= 0 or _body(last) < BODY_BIG * _rng(last):
            continue
        top = j - m + 1
        a0 = atr[top - 1] if top >= 1 else None
        total = cs[top]["o"] - last["c"]
        if not a0 or total < DROP_ATR * a0:
            continue
        win = cs[max(top - 1, 0) : r + 1]
        if any(win[i - 1]["c"] and abs(win[i]["c"] / win[i - 1]["c"] - 1) > CA_JUMP for i in range(1, len(win))):
            continue
        after = cs[r + 1 :]
        n = len(cs)
        vols = [x["v"] for x in cs[max(0, r - 20) : r] if x["v"]]
        rvol = round(R["v"] / (sum(vols) / len(vols)), 2) if R["v"] and len(vols) >= 10 else None
        tgt = cs[top]["h"]  # where the drop started: the first supply the rally meets
        rr = round((tgt - prox) / (prox - dist), 2) if tgt > prox > dist else None
        cl = [x["c"] for x in cs[-50:]]
        trend = bool(len(cl) >= 50 and cs[-1]["c"] > sum(cl) / 50)
        touches = sum(1 for x in after if x["l"] <= prox)
        failed = any(x["c"] < dist for x in after)
        age = n - 1 - r
        # rank: volume on the rally, an untouched zone, a young one, room to run, trend, a tight base
        score = 0.0
        score += min(rvol or 0, 3) / 3 * 25
        score += 25 if touches == 0 else 10 if touches == 1 else 0
        score += 10 if age <= 3 else 5 if age <= 10 else 0
        score += min(rr or 0, 4) / 4 * 15
        score += 10 if trend else 0
        score += (MAX_BASE + 1 - k) / MAX_BASE * 10
        score += 5 if R["c"] > last["o"] else 0
        return {
            "date": R["d"],
            "age": age,
            "drop": round(total / cs[top]["o"] * 100, 2),
            "rally": round(_body(R) / R["o"] * 100, 2),
            "base": k,
            "rvol": rvol,
            "prox": round(prox, 2),
            "dist": round(dist, 2),
            "tgt": round(tgt, 2),
            "rr": rr,
            "touches": touches,
            "failed": failed,
            "trend": trend,
            "score": round(score),
        }
    return None


def detect(past: list) -> dict | None:
    cs = _bars(past)
    if len(cs) < ATR_N + 6:
        return None
    atr = _atr(cs)
    failed_hit = None
    for r in range(len(cs) - 1, max(len(cs) - 1 - LOOKBACK, ATR_N + 3), -1):
        z = _try(cs, atr, r)
        if not z:
            continue
        if not z["failed"]:
            return z
        if failed_hit is None and z["age"] <= 30:
            failed_hit = z
    return failed_hit


def live(z: dict, ltp: float) -> dict:
    """The zone against today's price: fresh / retest / zone / failed, and how far price is above the zone."""
    prox, dist = z["prox"], z["dist"]
    if z["failed"] or ltp < dist:
        status = "failed"
    elif z["touches"] == 0 and z["age"] <= 3 and ltp > prox * 1.005:
        status = "fresh"
    elif ltp <= prox * 1.005 and z["touches"] <= 1:
        status = "retest"
    else:
        status = "zone"
    return {**z, "status": status, "distPct": round((ltp / prox - 1) * 100, 2)}
