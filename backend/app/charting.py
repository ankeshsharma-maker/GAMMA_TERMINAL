"""Build chart-ready series from the rolling history + scan-score history.

Everything is derived from data we already collect (`store.history`,
`store.scan_history`), optionally backfilled with NSE intraday spot ticks.
Timestamps are UNIX seconds, strictly ascending and de-duplicated -- the shape
lightweight-charts expects.
"""
from __future__ import annotations

_IST_S = 19800                    # IST = UTC+5:30
_OPEN_S = 9 * 3600 + 15 * 60      # the 09:15 session open, in seconds after IST midnight
WEEK_S = 604800                   # the 1W chart interval: calendar weeks from Monday (IST)
MONTH_S = 2592000                 # the 1M chart interval: calendar months (IST); the number is only a label


def bucket_start(t: float, interval_s: int) -> int:
    """Start time of the candle that contains `t` (UNIX seconds).

    Up to 15 minutes, plain epoch alignment already lands on the market's own grid (IST is UTC+5:30, a multiple of
    15 minutes), so those are unchanged. From 30 minutes up to (not including) a day the bars are anchored to the
    09:15 open, the way NSE / Kite charts draw them:
        30m: 09:15, 09:45 ...          1h: 09:15, 10:15 ... 15:15
        2h: 09:15, 11:15, 13:15, 15:15   4h: 09:15, 13:15
    Epoch alignment put all of these 15 minutes off (a 09:00 / 08:30 / 07:30 / 05:30 first bar holding only 15
    minutes of trading).

    A daily candle sits on IST midnight of its trading date. Upstox stamps its daily bars 00:00 +05:30, which is
    18:30 UTC the day BEFORE; bucketing on epoch days filed every one of them under the previous date (Monday's
    candle drawn on Sunday, and a month's first candle counted in the month before). A weekly candle sits on the
    Monday of its week, a monthly one on the 1st of its month (IST midnight, like the daily). The frontend's
    `bucketStart` (lib/istTime.ts) must match this exactly."""
    t = int(t)
    if interval_s == WEEK_S:
        day = (t + _IST_S) // 86400  # IST day number; day 0 (1 Jan 1970) was a Thursday
        return (day - (day + 3) % 7) * 86400 - _IST_S
    if interval_s == MONTH_S:
        import datetime as _dt

        d = _dt.datetime.fromtimestamp(t + _IST_S, _dt.timezone.utc)
        return int(_dt.datetime(d.year, d.month, 1, tzinfo=_dt.timezone.utc).timestamp()) - _IST_S
    if interval_s == 86400:
        return (t + _IST_S) // 86400 * 86400 - _IST_S
    if 1800 <= interval_s < 86400:
        open_ = (t + _IST_S) // 86400 * 86400 - _IST_S + _OPEN_S
        return open_ + (t - open_) // interval_s * interval_s
    return t // interval_s * interval_s


def _candles(hist: list[dict], interval_s: int) -> list[dict]:
    buckets: dict[int, dict] = {}
    order: list[int] = []
    for h in hist:
        s = h.get("spot")
        t = h.get("t")
        if s is None or t is None:
            continue
        b = bucket_start(t, interval_s)
        c = buckets.get(b)
        if c is None:
            buckets[b] = {"time": b, "open": s, "high": s, "low": s, "close": s}
            order.append(b)
        else:
            c["high"] = max(c["high"], s)
            c["low"] = min(c["low"], s)
            c["close"] = s
    return [buckets[b] for b in sorted(order)]


def _line(hist: list[dict], key: str, interval_s: int = 0) -> list[dict]:
    """One point per chart bar (the last reading inside it, stamped at the bar's start) --
    the history is a reading every ~70 s, and sending all 720 of them for 17 lines made
    every chart answer ~450 KB whatever the timeframe. interval_s=0: every reading."""
    out: list[dict] = []
    last_t = None
    for h in hist:
        v = h.get(key)
        t = h.get("t")
        if v is None or t is None:
            continue
        ti = bucket_start(t, interval_s) if interval_s else int(t)
        if ti == last_t:
            out[-1] = {"time": ti, "value": round(v, 4)}
        else:
            out.append({"time": ti, "value": round(v, 4)})
            last_t = ti
    return out


def build_chart(
    symbol: str,
    hist: list[dict],
    scan_hist: list[dict],
    interval_s: int = 60,
    base_candles: list[dict] | None = None,
    source_label: str = "broker",
) -> dict:
    hist = sorted(hist, key=lambda h: h.get("t") or 0)
    score_line: list[dict] = []
    last_t = None
    for x in scan_hist:
        ti = bucket_start(x["t"], interval_s)
        if ti == last_t:
            score_line[-1] = {"time": ti, "value": x["score"]}
        else:
            score_line.append({"time": ti, "value": x["score"]})
            last_t = ti

    if base_candles:
        # real broker candles at 1-min; re-bucket to the requested interval
        buckets: dict[int, dict] = {}
        order: list[int] = []
        for c in sorted(base_candles, key=lambda c: c["time"]):
            b = bucket_start(c["time"], interval_s)
            cur = buckets.get(b)
            if cur is None:
                buckets[b] = {
                    "time": b, "open": c["open"], "high": c["high"],
                    "low": c["low"], "close": c["close"], "volume": c.get("volume", 0) or 0,
                }
                order.append(b)
            else:
                cur["high"] = max(cur["high"], c["high"])
                cur["low"] = min(cur["low"], c["low"])
                cur["close"] = c["close"]
                cur["volume"] += c.get("volume", 0) or 0
        candles = [buckets[b] for b in order]
        source = source_label
    else:
        candles = _candles(hist, interval_s)
        source = "sampled"
    return {
        "symbol": symbol.upper(),
        "interval": interval_s,
        "candleSource": source,
        "hasVolume": any(c.get("volume") for c in candles),
        "candles": candles,
        "series": {
            "straddle": _line(hist, "atmStraddle", interval_s),
            "atmIV": _line(hist, "atmIV", interval_s),
            "netGex": _line(hist, "netGex", interval_s),
            "pcr": _line(hist, "pcr", interval_s),
            "maxPain": _line(hist, "maxPain", interval_s),
            "ceOI": _line(hist, "ceOI", interval_s),
            "peOI": _line(hist, "peOI", interval_s),
            "ceOIChg": _line(hist, "ceOIChg", interval_s),
            "peOIChg": _line(hist, "peOIChg", interval_s),
            "score": score_line,
            "ceDelta": _line(hist, "atmCEDelta", interval_s),
            "peDelta": _line(hist, "atmPEDelta", interval_s),
            "ceGamma": _line(hist, "atmCEGamma", interval_s),
            "peGamma": _line(hist, "atmPEGamma", interval_s),
            "ceTheta": _line(hist, "atmCETheta", interval_s),
            "peTheta": _line(hist, "atmPETheta", interval_s),
            "ceVega": _line(hist, "atmCEVega", interval_s),
            "peVega": _line(hist, "atmPEVega", interval_s),
        },
        "lastSpot": candles[-1]["close"] if candles else None,
        "points": len(hist),
    }
