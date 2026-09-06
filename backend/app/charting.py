"""Build chart-ready series from the rolling history + scan-score history.

Everything is derived from data we already collect (`store.history`,
`store.scan_history`), optionally backfilled with NSE intraday spot ticks.
Timestamps are UNIX seconds, strictly ascending and de-duplicated -- the shape
lightweight-charts expects.
"""
from __future__ import annotations


def _candles(hist: list[dict], interval_s: int) -> list[dict]:
    buckets: dict[int, dict] = {}
    order: list[int] = []
    for h in hist:
        s = h.get("spot")
        t = h.get("t")
        if s is None or t is None:
            continue
        b = int(t // interval_s) * interval_s
        c = buckets.get(b)
        if c is None:
            buckets[b] = {"time": b, "open": s, "high": s, "low": s, "close": s}
            order.append(b)
        else:
            c["high"] = max(c["high"], s)
            c["low"] = min(c["low"], s)
            c["close"] = s
    return [buckets[b] for b in sorted(order)]


def _line(hist: list[dict], key: str) -> list[dict]:
    out: list[dict] = []
    last_t = None
    for h in hist:
        v = h.get(key)
        t = h.get("t")
        if v is None or t is None:
            continue
        ti = int(t)
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
        ti = int(x["t"])
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
            b = int(c["time"] // interval_s) * interval_s
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
            "straddle": _line(hist, "atmStraddle"),
            "atmIV": _line(hist, "atmIV"),
            "netGex": _line(hist, "netGex"),
            "pcr": _line(hist, "pcr"),
            "maxPain": _line(hist, "maxPain"),
            "ceOI": _line(hist, "ceOI"),
            "peOI": _line(hist, "peOI"),
            "ceOIChg": _line(hist, "ceOIChg"),
            "peOIChg": _line(hist, "peOIChg"),
            "score": score_line,
        },
        "lastSpot": candles[-1]["close"] if candles else None,
        "points": len(hist),
    }
