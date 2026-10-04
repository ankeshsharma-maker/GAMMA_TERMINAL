"""Five years of daily candles for the F&O stocks and the ~500 most traded cash stocks, kept on disk
for the Scan tabs' Backtest button (scan_backtest.py).

    data/daily_candles/fo/SYM.json     F&O stocks
    data/daily_candles/cash/SYM.json   the 500 most traded NSE stocks that are not in F&O
    data/daily_candles/cash_universe.json   {"asOf", "symbols"} -- the cash list, rebuilt monthly from
                                            NSE's end-of-day file (traded value)

Each file is Upstox's own list [ts, o, h, l, c, v, oi], newest first. A file that is missing is fetched in
full (5 years, one request); an existing one is topped up from the last ~30 days. The job runs once a
trading day after 16:30 IST (the day's candle is complete by then), paced like the volume baseline
(0.9 s apart, waits while Upstox is refusing calls), and never on a closed-market day it already did.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import time
from datetime import date, datetime, timedelta, timezone

from .config import DATA_DIR

log = logging.getLogger("daily_history")

IST = timezone(timedelta(hours=5, minutes=30))
DIR = DATA_DIR / "daily_candles"
YEARS = 5
CASH_N = 500
_state: dict = {"last": None, "running": False, "done": 0, "total": 0}


def _now() -> datetime:
    return datetime.now(IST)


def folder(kind: str):
    return DIR / kind


def files(kind: str) -> list:
    d = folder(kind)
    return sorted(d.glob("*.json")) if d.exists() else []


def status() -> dict:
    return {
        "fo": len(files("fo")), "cash": len(files("cash")), "lastRun": _state["last"],
        "running": _state["running"], "progress": [_state["done"], _state["total"]],
    }


# ---------------------------------------------------------------- the cash universe
async def _cash_symbols(fo: set[str]) -> list[str]:
    """The 500 most traded non-F&O EQ stocks of the latest NSE file; cached a month."""
    from . import positional

    f = DIR / "cash_universe.json"
    try:
        c = json.loads(f.read_text("utf-8"))
        if c.get("symbols") and (date.today() - date.fromisoformat(c["asOf"])).days < 30:
            return c["symbols"]
    except (FileNotFoundError, ValueError, KeyError):
        c = None
    raw = None
    for back in range(0, 8):
        d = date.today() - timedelta(days=back)
        raw = await positional._get(f"https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{d.strftime('%d%m%Y')}.csv")
        if raw:
            as_of = d.isoformat()
            break
    if not raw:
        return (c or {}).get("symbols") or []
    rows = []
    for r in csv.DictReader(io.StringIO(raw.decode("utf-8", "replace"))):
        r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
        if r.get("SERIES") != "EQ" or r.get("SYMBOL") in fo:
            continue
        try:
            rows.append((float(r["TURNOVER_LACS"]), r["SYMBOL"]))
        except (KeyError, ValueError):
            continue
    syms = [s for _, s in sorted(rows, reverse=True)[:CASH_N]]
    DIR.mkdir(parents=True, exist_ok=True)
    f.write_text(json.dumps({"asOf": as_of, "symbols": syms}), "utf-8")
    return syms


# ---------------------------------------------------------------- fetch / merge
def _merge(old: list, new: list) -> list:
    by = {str(c[0])[:10]: c for c in old}
    by.update({str(c[0])[:10]: c for c in new})
    return [by[k] for k in sorted(by, reverse=True)]


async def _one(ux, sym: str, kind: str, today: date, stop: asyncio.Event) -> str:
    """'ok' | 'skip' | 'throttled'"""
    from .upstox_data import _hc

    key = ux.underlying_key(sym)
    if not key:
        return "skip"
    f = folder(kind) / f"{sym}.json"
    old: list = []
    try:
        old = json.loads(f.read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        pass
    back = 30 if len(old) > 200 else 365 * YEARS + 30
    try:
        h = await ux.get(_hc(key, "days", 1, today.isoformat(), (today - timedelta(days=back)).isoformat()), v3=True)
    except Exception as exc:  # noqa: BLE001
        if getattr(getattr(exc, "response", None), "status_code", None) == 429:
            return "throttled"
        log.debug("daily history %s: %s", sym, exc)
        return "skip"
    cs = (h.get("data") or {}).get("candles") or []
    if not cs:
        return "skip"
    merged = _merge(old, cs)
    f.parent.mkdir(parents=True, exist_ok=True)
    tmp = f.with_suffix(".tmp")
    tmp.write_text(json.dumps(merged, separators=(",", ":")), "utf-8")
    tmp.replace(f)
    return "ok"


async def refresh(stop: asyncio.Event) -> int:
    from .brokers.upstox import get_upstox
    from .upstox_data import rate_limited
    from .volume_screener import fo_stocks

    ux = get_upstox()
    if not ux.authed:
        return 0
    await ux.load_instruments()
    fo = fo_stocks()
    jobs = [(s, "fo") for s in fo] + [(s, "cash") for s in await _cash_symbols(set(fo))]
    _state.update(running=True, done=0, total=len(jobs))
    today = _now().date()
    n = 0
    try:
        for sym, kind in jobs:
            if stop.is_set():
                break
            while rate_limited() and not stop.is_set():
                await asyncio.sleep(5)  # let the charts have Upstox's allowance
            r = await _one(ux, sym, kind, today, stop)
            if r == "throttled":
                await asyncio.sleep(10)
            n += r == "ok"
            _state["done"] += 1
            await asyncio.sleep(0.9)  # Upstox: well inside 500 / minute
    finally:
        _state["running"] = False
    return n


async def run(stop: asyncio.Event) -> None:
    """Once per trading day after 16:30 IST (or at start-up while files are missing / a day behind)."""
    await asyncio.sleep(120)  # the instrument master + the volume baseline go first
    while not stop.is_set():
        try:
            now = _now()
            marker = DIR / f"_done_{now.date().isoformat()}"
            have = len(files("fo")) + len(files("cash"))
            after_close = now.weekday() < 5 and now.hour * 60 + now.minute >= 16 * 60 + 30
            weekend_catchup = now.weekday() == 5  # one Saturday catch-up pass
            missing = have < 100
            if not marker.exists() and (missing or after_close or weekend_catchup):
                n = await refresh(stop)
                if n and not stop.is_set():
                    DIR.mkdir(parents=True, exist_ok=True)
                    for old in DIR.glob("_done_*"):
                        old.unlink(missing_ok=True)
                    marker.write_text(str(n), "utf-8")
                    _state["last"] = now.isoformat(timespec="minutes")
                    log.info("daily history: %d files refreshed", n)
        except Exception as exc:  # noqa: BLE001 -- the loop must survive
            log.warning("daily history loop: %s", exc)
        try:
            await asyncio.wait_for(stop.wait(), timeout=1800)
        except asyncio.TimeoutError:
            pass
