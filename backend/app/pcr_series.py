"""PCR-vs-spot series for the OI tab's PCR chart.

Two sources, merged:
  * store.history   -- the in-memory ring of recent chain snapshots (any symbol; ~2-3 hours),
  * history_archive -- one JSONL file per index per trading day (NIFTY / BANKNIFTY / FINNIFTY / SENSEX), i.e. the WHOLE
                       session and earlier days.
Rows are bucketed to N minutes (the last snapshot in each bucket wins) and returned as compact arrays; the chart derives
the PCR variants itself (total-OI PCR, change-in-OI PCR, volume PCR) from the raw OI / volume totals.

Point layout: [t, spot, pcr, ceOI, peOI, ceOIChg, peOIChg, ceVol, peVol, expiryIndex]
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from . import history_archive

_IST = timezone(timedelta(hours=5, minutes=30))
MAX_DAYS = 30
FIELDS = ("t", "spot", "pcr", "ceOI", "peOI", "ceOIChg", "peOIChg", "ceVol", "peVol", "ei")


def _day_of(t: float) -> str:
    return datetime.fromtimestamp(t, _IST).strftime("%Y-%m-%d")


def _num(v, nd: int | None = None):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if f != f:                                   # NaN
        return None
    return round(f, nd) if nd is not None else (int(f) if f == int(f) and abs(f) > 1000 else f)


def _merge(archived: list[dict], live: list[dict]) -> list[dict]:
    """Union of the two sources, one row per timestamp (the archive rows ARE store.history rows, so the same t repeats)."""
    by_t: dict[float, dict] = {}
    for r in archived:
        if r.get("t"):
            by_t[float(r["t"])] = r
    for r in live:
        if r.get("t"):
            by_t[float(r["t"])] = r
    return [by_t[t] for t in sorted(by_t)]


def _bucket(rows: list[dict], minutes: int) -> list[dict]:
    """The last row of every `minutes`-wide bucket (IST clock aligned: the offset is a multiple of 15 minutes)."""
    size = max(1, int(minutes)) * 60
    out: dict[int, dict] = {}
    for r in rows:
        out[int(r["t"] // size)] = r
    return [out[k] for k in sorted(out)]


def _pcr(r: dict) -> float | None:
    v = r.get("pcr")
    if v is None and r.get("ceOI"):
        v = (r.get("peOI") or 0) / r["ceOI"]
    return _num(v, 3)


def build(symbol: str, day: str | None, bucket: int, live_rows: list[dict], now: float | None = None) -> dict:
    """Everything the PCR chart draws for one symbol and one trading day (None = the most recent day with data)."""
    symbol = symbol.upper()
    now = datetime.now(_IST).timestamp() if now is None else now
    live_days = {_day_of(r["t"]) for r in live_rows if r.get("t")}
    days = sorted(set(history_archive.days(symbol)) | live_days, reverse=True)[:MAX_DAYS]
    chosen = day if day in days else (days[0] if days else None)
    out = {"symbol": symbol, "day": chosen, "days": days, "bucketMin": int(bucket), "source": None, "live": False,
           "expiries": [], "fields": list(FIELDS), "points": [], "asOf": None}
    if chosen is None:
        return out

    archived = history_archive.read(symbol, chosen)
    live = [r for r in live_rows if r.get("t") and _day_of(r["t"]) == chosen]
    rows = _bucket(_merge(archived, live), bucket)
    out["source"] = "archive+live" if archived and live else "archive" if archived else "live"
    out["live"] = chosen == _day_of(now)

    expiries: list[str] = []
    pts = []
    for r in rows:
        ex = r.get("expiry")
        if ex and ex not in expiries:
            expiries.append(ex)
        pts.append([int(r["t"]), _num(r.get("spot"), 2), _pcr(r), _num(r.get("ceOI")), _num(r.get("peOI")),
                    _num(r.get("ceOIChg")), _num(r.get("peOIChg")), _num(r.get("ceVol")), _num(r.get("peVol")),
                    expiries.index(ex) if ex else None])
    out["expiries"], out["points"] = expiries, pts
    out["asOf"] = pts[-1][0] if pts else None
    return out


def gex_intraday(symbol: str, day: str | None, live_rows: list[dict], now: float | None = None) -> dict:
    """Net GEX / gamma flip / spot for one trading session (None = the latest day with data): the history
    archive (whole session, indices) merged with the live ring, market hours only -- the ring alone is 720
    readings round the clock, so in the morning it was ~95% last night's frozen after-hours readings.
    Point layout: [t, spot, netGex, gammaFlip]."""
    symbol = symbol.upper()
    now = datetime.now(_IST).timestamp() if now is None else now
    live_rows = [r for r in live_rows if r.get("t") and history_archive.in_session(r["t"]) and r.get("netGex") is not None]
    live_days = {_day_of(r["t"]) for r in live_rows}
    days = sorted(set(history_archive.days(symbol)) | live_days, reverse=True)[:MAX_DAYS]
    chosen = day if day in days else (days[0] if days else None)
    out = {"symbol": symbol, "day": chosen, "days": days, "live": False, "points": []}
    if chosen is None:
        return out
    rows = _merge(history_archive.read(symbol, chosen), [r for r in live_rows if _day_of(r["t"]) == chosen])
    out["live"] = chosen == _day_of(now)
    out["points"] = [
        [int(r["t"]), _num(r.get("spot"), 2), _num(r.get("netGex"), 2), _num(r.get("gammaFlip"), 2)]
        for r in rows
        if history_archive.in_session(r["t"]) and r.get("netGex") is not None
    ]
    return out
