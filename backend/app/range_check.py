"""Range-day check: how often an index has stayed inside a band around its open until the close, for days like
today (same weekday, same kind of opening gap). Price only -- it says nothing about option premiums.

Built from about 3 years of daily candles (Upstox), cached for 30 minutes per symbol."""
from __future__ import annotations

import logging
import time
from datetime import date, datetime, timedelta, timezone

log = logging.getLogger("range_check")

IST = timezone(timedelta(hours=5, minutes=30))
BANDS = (0.5, 0.75, 1.0, 1.5)
GAP_BIG = 0.5  # % -- an opening gap this large (either way) is a "gap day"
MIN_N = 20  # fewer similar days than this and the number is not shown
WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
_cache: dict[str, tuple[float, list]] = {}


def _pct(a: float, b: float) -> float:
    return (a - b) / b * 100


async def _daily(symbol: str) -> list:
    hit = _cache.get(symbol)
    if hit and time.time() - hit[0] < 1800:
        return hit[1]
    from .brokers.upstox import get_upstox
    from .upstox_data import _hc

    ux = get_upstox()
    key = ux.underlying_key(symbol) if ux.authed else None
    if not key:
        return hit[1] if hit else []
    end = datetime.now(IST).date()
    h = await ux.get(_hc(key, "days", 1, end.isoformat(), (end - timedelta(days=1100)).isoformat()), v3=True)
    cs = sorted(((h.get("data") or {}).get("candles") or []), key=lambda c: c[0])
    rows = [(str(c[0])[:10], float(c[1]), float(c[2]), float(c[3]), float(c[4])) for c in cs if c[1] and c[2] and c[3] and c[4]]
    _cache[symbol] = (time.time(), rows)
    return rows


def _inside(r, x: float) -> bool:
    _, o, h, lo, _c = r
    return _pct(h, o) <= x and _pct(o, lo) <= x


def _stat(days: list, x: float) -> dict | None:
    if len(days) < MIN_N:
        return None
    ins = sum(1 for d in days if _inside(d, x))
    over = [max(_pct(d[2], d[1]) - x, _pct(d[1], d[3]) - x) for d in days if not _inside(d, x)]
    return {"pInside": round(ins / len(days) * 100, 1), "n": len(days), "overshoot": round(sum(over) / len(over), 2) if over else 0.0}


async def build(symbol: str) -> dict:
    symbol = symbol.upper()
    rows = await _daily(symbol)
    if len(rows) < 60:
        return {"symbol": symbol, "ok": False, "reason": "no daily history yet"}
    now = datetime.now(IST)
    today = now.date().isoformat()
    # today's gap: the open of today's candle vs the previous close (known once the market has opened)
    gap = None
    if rows[-1][0] == today and len(rows) >= 2:
        gap = round(_pct(rows[-1][1], rows[-2][4]), 2)
    # the day being assessed: today on a weekday (before the close), else the next weekday
    d = now.date()
    if d.weekday() >= 5 or (now.hour * 60 + now.minute) > 15 * 60 + 30:
        d += timedelta(days=1)
        while d.weekday() >= 5:
            d += timedelta(days=1)
    wd = d.weekday()
    hist = [(rows[i], rows[i - 1]) for i in range(1, len(rows)) if rows[i][0] != today]
    days_all = [r for r, _p in hist]
    days_wd = [r for r, _p in hist if date.fromisoformat(r[0]).weekday() == wd]
    big = gap is not None and abs(gap) >= GAP_BIG
    days_gap = [r for r, p in hist if (abs(_pct(r[1], p[4])) >= GAP_BIG) == big] if gap is not None else []
    days_both = [r for r in days_wd if r in days_gap] if gap is not None else []
    bands = []
    for x in BANDS:
        bands.append({
            "band": x,
            "all": _stat(days_all, x),
            "weekday": _stat(days_wd, x),
            "gap": _stat(days_gap, x),
            "both": _stat(days_both, x),
        })
    # verdict from the +-1% band on the most specific sample that is big enough
    ref = next((b for b in bands if b["band"] == 1.0), None) or {}
    pick = ref.get("both") or ref.get("gap") or ref.get("weekday") or ref.get("all")
    p = pick["pInside"] if pick else None
    verdict = None if p is None else "favourable" if p >= 80 else "average" if p >= 70 else "poor"
    ranges = [_pct(r[2], r[3]) for r in days_all]
    closes = [abs(_pct(r[4], p_[4])) for r, p_ in hist]
    return {
        "symbol": symbol,
        "ok": True,
        "weekday": WEEKDAYS[wd],
        "forDay": d.isoformat(),
        "gapPct": gap,
        "gapKind": None if gap is None else ("gap day" if big else "normal open"),
        "bands": bands,
        "verdict": verdict,
        "verdictP": p,
        "avgRangePct": round(sum(ranges) / len(ranges), 2),
        "worstCloseMovePct": round(max(closes), 2),
        "days": len(days_all),
        "from": rows[0][0],
    }
