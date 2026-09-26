"""Volume screener: stocks by traded volume -- spikes vs their usual volume, the most
traded, and volume-backed breakouts -- for the F&O stocks, and (on demand) every NSE
cash stock. Alerts when a stock crosses 3x / 5x its usual volume.

Two background loops:
  * baseline -- once a trading day, each stock's 20-day average daily volume and
    yesterday's high / low / close from Upstox daily candles, saved to disk. Paced
    (Upstox caps historical calls); F&O first, then all NSE if that list was asked for.
  * quotes   -- Upstox /market-quote/quotes (500 stocks a call): F&O every 30 s in
    market hours, all NSE every 90 s while someone is looking at it.

"Relative volume" compares today's volume with what the stock usually trades BY THIS
TIME OF DAY, using a typical NSE intraday volume curve (volume is heavy in the first
and last hour) -- approximate, but it stops every stock reading "low" at 10:00.
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
from datetime import date, datetime, timedelta, timezone

from .config import DATA_DIR, FO_UNIVERSE, INDEX_SYMBOLS

log = logging.getLogger("volume_screener")

IST = timezone(timedelta(hours=5, minutes=30))
_BASE_FILE = DATA_DIR / "volume_baseline.json"
_KV = "volume_screener"
_DEFAULT_CFG = {"alertLevel": 3, "minValueCr": 5.0}
AVG_DAYS = 20

# cumulative share of a day's volume traded by N minutes after 09:15 (typical NSE U-shape)
_CURVE = [(0, 0.0), (15, 0.10), (30, 0.16), (60, 0.26), (90, 0.34), (120, 0.41), (150, 0.47),
          (180, 0.53), (210, 0.58), (240, 0.63), (270, 0.69), (300, 0.76), (330, 0.84),
          (360, 0.93), (375, 1.0)]

_base: dict[str, dict] = {}          # symbol -> {avgVol, pdh, pdl, pdc, days}
_base_date: str | None = None        # the IST date the baseline was built for
_live: dict[str, dict] = {}          # symbol -> latest quote numbers
_live_ts: dict[str, float] = {"fo": 0.0, "all": 0.0}
_all_wanted_until = 0.0              # poll / build the all-NSE list while now < this
_viewed_until = 0.0                  # someone has the tab open (off-hours polling)
_alerted: dict[str, int] = {}        # symbol -> highest level alerted today
_alert_day: str | None = None


def _now() -> datetime:
    return datetime.now(IST)


def _market_open(now: datetime | None = None) -> bool:
    now = now or _now()
    if now.weekday() >= 5:
        return False
    m = now.hour * 60 + now.minute
    return 9 * 60 + 15 <= m <= 15 * 60 + 30


def _session_fraction(now: datetime | None = None) -> float:
    """Share of a normal day's volume expected by now (1.0 outside the session)."""
    now = now or _now()
    if not _market_open(now):
        return 1.0
    t = (now.hour * 60 + now.minute - (9 * 60 + 15)) + now.second / 60
    for (t0, f0), (t1, f1) in zip(_CURVE, _CURVE[1:]):
        if t <= t1:
            return max(0.02, f0 + (f1 - f0) * (t - t0) / (t1 - t0))
    return 1.0


def _session_day(now: datetime | None = None) -> date:
    """The trading day the quotes describe: today from 08:30 on a weekday, otherwise the
    weekday before (a weekend / early morning shows the last session). The baseline is
    built from candles strictly BEFORE this day, so a session is never compared with
    itself (holidays aside)."""
    now = now or _now()
    d = now.date()
    if d.weekday() < 5 and now.hour * 60 + now.minute >= 8 * 60 + 30:
        return d
    d -= timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def cfg() -> dict:
    from . import db

    return {**_DEFAULT_CFG, **(db.get_kv(_KV) or {})}


def set_cfg(body: dict) -> dict:
    from . import db

    c = cfg()
    if "alertLevel" in body:
        lvl = int(body["alertLevel"] or 0)
        c["alertLevel"] = lvl if lvl in (0, 2, 3, 5) else 3
    if "minValueCr" in body:
        c["minValueCr"] = max(0.0, float(body["minValueCr"] or 0))
    db.set_kv(_KV, c)
    return c


def fo_stocks() -> list[str]:
    return [s for s in FO_UNIVERSE if s not in INDEX_SYMBOLS]


def _all_stocks() -> list[str]:
    from .brokers.upstox import get_upstox

    return sorted((getattr(get_upstox(), "_eq_names", None) or {}).keys())


def want_all(seconds: float = 300) -> None:
    global _all_wanted_until
    _all_wanted_until = max(_all_wanted_until, time.time() + seconds)


def viewed(seconds: float = 120) -> None:
    global _viewed_until
    _viewed_until = max(_viewed_until, time.time() + seconds)


# ---------------------------------------------------------------- baseline
def _load_base() -> None:
    global _base, _base_date
    try:
        d = json.loads(_BASE_FILE.read_text("utf-8"))
        _base, _base_date = d.get("rows") or {}, d.get("date")
    except (FileNotFoundError, ValueError):
        pass


def _save_base() -> None:
    try:
        tmp = _BASE_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps({"date": _base_date, "rows": _base}, separators=(",", ":")), "utf-8")
        tmp.replace(_BASE_FILE)
    except Exception as exc:  # noqa: BLE001
        log.warning("baseline save failed: %s", exc)


async def _baseline_one(ux, sym: str, today: date) -> bool:
    """Fetch ~6 weeks of daily candles for one stock, keep the ones before the session
    day `today`; True when Upstox said 429 (back off)."""
    from .upstox_data import _hc

    key = ux.underlying_key(sym)
    if not key:
        return False
    try:
        h = await ux.get(_hc(key, "days", 1, today.isoformat(), (today - timedelta(days=45)).isoformat()), v3=True)
    except Exception as exc:  # noqa: BLE001
        if getattr(getattr(exc, "response", None), "status_code", None) == 429:
            return True
        return False
    cs = (h.get("data") or {}).get("candles") or []  # newest first: [ts, o, h, l, c, v, oi]
    past = [c for c in cs if str(c[0])[:10] < today.isoformat()]
    vols = [_num(c[5]) for c in past[:AVG_DAYS] if len(c) > 5 and _num(c[5])]
    if not past or not vols:
        return False
    last = past[0]
    _base[sym] = {
        "avgVol": sum(vols) / len(vols),
        "days": len(vols),
        "pdh": _num(last[2]),
        "pdl": _num(last[3]),
        "pdc": _num(last[4]),
        "asOf": str(last[0])[:10],
    }
    return False


async def run_baseline(stop: asyncio.Event) -> None:
    """Rebuilt whenever the session day changes (08:30 IST on a trading day): F&O stocks
    first, then all NSE while that list is being asked for."""
    global _base_date
    from .brokers.upstox import get_upstox

    _load_base()
    await asyncio.sleep(20)  # let the instrument master load
    while not stop.is_set():
        try:
            ux = get_upstox()
            if ux.authed:
                today = _session_day()
                if _base_date != today.isoformat():
                    _base.clear()  # a new session: its baseline is the 20 days before it
                    _base_date = today.isoformat()
                    _alerted.clear()
                fo_l = fo_stocks()
                fo_set = set(fo_l)
                todo = [s for s in fo_l if s not in _base]
                if time.time() < _all_wanted_until:
                    todo += [s for s in _all_stocks() if s not in _base and s not in fo_set]
                done = 0
                for sym in todo:
                    if stop.is_set() or (sym not in fo_set and time.time() >= _all_wanted_until):
                        break  # stopping, or nobody wants the all-NSE list any more
                    throttled = await _baseline_one(ux, sym, today)
                    done += 1
                    if done % 50 == 0:
                        _save_base()
                    # Upstox: 500 historical calls a minute, 2000 per 30 min -- stay well inside
                    await asyncio.sleep(10 if throttled else 0.9)
                if done:
                    _save_base()
                    log.info("volume baseline: %d stocks (%s)", len(_base), _base_date)
        except Exception as exc:  # noqa: BLE001 -- the loop must survive
            log.warning("volume baseline loop: %s", exc)
        try:
            await asyncio.wait_for(stop.wait(), timeout=60)
        except asyncio.TimeoutError:
            pass


def _progress(universe: str) -> tuple[int, int]:
    if universe == "all":
        allst = _all_stocks()
        return sum(1 for s in allst if s in _base), len(allst)
    fo_l = fo_stocks()
    return sum(1 for s in fo_l if s in _base), len(fo_l)


# ---------------------------------------------------------------- quotes
async def _poll(ux, syms: list[str]) -> None:
    keys: dict[str, str] = {}
    for s in syms:
        k = ux.underlying_key(s)
        if k:
            keys[k] = s
    items = list(keys.items())
    for i in range(0, len(items), 500):
        chunk = items[i:i + 500]
        try:
            d = await ux.get("/market-quote/quotes", {"instrument_key": ",".join(k for k, _ in chunk)})
        except Exception as exc:  # noqa: BLE001
            log.debug("volume quotes failed: %s", exc)
            continue
        lookup = dict(chunk)
        for rkey, q in ((d or {}).get("data") or {}).items():
            sym = lookup.get(q.get("instrument_token") or "") or lookup.get(rkey.replace(":", "|"))
            if not sym:
                continue
            ltp = _num(q.get("last_price"))
            if ltp is None:
                continue
            net = _num(q.get("net_change"))
            base = ltp - net if net is not None else None
            ohlc = q.get("ohlc") or {}
            vol = _num(q.get("volume")) or 0.0
            avgpx = _num(q.get("average_price")) or ltp
            _live[sym] = {
                "ltp": ltp,
                "chgPct": round(net / base * 100, 2) if base else None,
                "vol": vol,
                "value": vol * avgpx,
                "dayHigh": _num(ohlc.get("high")),
                "dayLow": _num(ohlc.get("low")),
                "open": _num(ohlc.get("open")),
                "ts": time.time(),
            }
        await asyncio.sleep(0.3)


def _row(sym: str, fo: set[str]) -> dict | None:
    q = _live.get(sym)
    if not q:
        return None
    b = _base.get(sym) or {}
    avg = b.get("avgVol")
    frac = _session_fraction()
    rvol = round(q["vol"] / (avg * frac), 2) if avg else None
    ltp, pdh, pdl = q["ltp"], b.get("pdh"), b.get("pdl")
    sig = None
    if rvol is not None and rvol >= 1.5:
        if pdh and ltp > pdh:
            sig = "PDH"  # above yesterday's high
        elif pdl and ltp < pdl:
            sig = "PDL"  # below yesterday's low
        elif q["dayHigh"] and ltp >= q["dayHigh"] * 0.998:
            sig = "HIGH"  # at today's high
        elif q["dayLow"] and ltp <= q["dayLow"] * 1.002:
            sig = "LOW"  # at today's low
    return {
        "symbol": sym,
        "fo": sym in fo,
        "ltp": ltp,
        "chgPct": q["chgPct"],
        "vol": q["vol"],
        "value": q["value"],
        "avgVol": avg,
        "rvol": rvol,  # vs usual volume by this time of day
        "volXAvg": round(q["vol"] / avg, 2) if avg else None,  # vs a whole usual day
        "pdh": pdh,
        "pdl": pdl,
        "dayHigh": q["dayHigh"],
        "dayLow": q["dayLow"],
        "signal": sig,
    }


def _check_alerts(rows: list[dict]) -> None:
    global _alert_day
    from .store import store

    c = cfg()
    lvl = int(c.get("alertLevel") or 0)
    now = _now()
    if not lvl or not _market_open(now) or (now.hour * 60 + now.minute) < 9 * 60 + 30:
        return  # first 15 minutes: too little volume for a ratio to mean much
    if _alert_day != now.date().isoformat():
        _alert_day = now.date().isoformat()
        _alerted.clear()
    min_val = float(c.get("minValueCr") or 0) * 1e7
    for r in rows:
        rv = r.get("rvol")
        if rv is None or r["value"] < min_val:
            continue
        hit = 5 if rv >= 5 and lvl <= 5 else (lvl if rv >= lvl else 0)
        if not hit or _alerted.get(r["symbol"], 0) >= hit:
            continue
        _alerted[r["symbol"]] = hit
        chg = r.get("chgPct")
        extra = {"PDH": " · above yesterday's high", "PDL": " · below yesterday's low",
                 "HIGH": " · at the day's high", "LOW": " · at the day's low"}.get(r.get("signal") or "", "")
        store.add_alert({
            "ts": time.time(),
            "symbol": r["symbol"],
            "kind": "volume-spike",
            "category": "volume",
            "severity": "critical" if hit >= 5 else "warning",
            "score": rv,
            "message": (
                f"{r['symbol']} volume {rv:.1f}x its usual for this time"
                f" ({r['value'] / 1e7:.1f} Cr traded)"
                f"{f' · {chg:+.2f}%' if chg is not None else ''} at ₹{r['ltp']:.2f}{extra}"
            ),
        })


async def run_quotes(stop: asyncio.Event) -> None:
    from .brokers.upstox import get_upstox

    await asyncio.sleep(25)
    while not stop.is_set():
        try:
            ux = get_upstox()
            now = time.time()
            live = _market_open()
            if ux.authed:
                # F&O: every 30 s in market hours; off-hours only while the tab is open (every 5 min)
                if live or (now < _viewed_until and now - _live_ts["fo"] > 300):
                    await _poll(ux, fo_stocks())
                    _live_ts["fo"] = time.time()
                    if live:
                        fo = set(fo_stocks())
                        _check_alerts([r for s in fo_stocks() if (r := _row(s, fo))])
                # all NSE: every 90 s while asked for (5 min off-hours)
                gap = 90 if live else 300
                if now < _all_wanted_until and now - _live_ts["all"] > gap:
                    fo = set(fo_stocks())
                    await _poll(ux, [s for s in _all_stocks() if s not in fo])
                    _live_ts["all"] = time.time()
        except Exception as exc:  # noqa: BLE001
            log.warning("volume quotes loop: %s", exc)
        try:
            await asyncio.wait_for(stop.wait(), timeout=30)
        except asyncio.TimeoutError:
            pass


def snapshot(universe: str) -> dict:
    fo_list = fo_stocks()
    fo = set(fo_list)
    syms = fo_list if universe != "all" else [*fo_list, *(s for s in _all_stocks() if s not in fo)]
    rows = [r for s in syms if (r := _row(s, fo))]
    names = {}
    if universe == "all":
        from .brokers.upstox import get_upstox

        names = getattr(get_upstox(), "_eq_names", None) or {}
    for r in rows:
        if names:
            r["name"] = names.get(r["symbol"])
    prog = _progress(universe)
    return {
        "universe": "all" if universe == "all" else "fo",
        "asOf": _live_ts["all" if universe == "all" else "fo"] or None,
        "market": "open" if _market_open() else "closed",
        "sessionFraction": round(_session_fraction(), 3),
        "baseline": {"ready": prog[0], "total": prog[1] or len(syms), "date": _base_date},
        "cfg": cfg(),
        "rows": rows,
    }
