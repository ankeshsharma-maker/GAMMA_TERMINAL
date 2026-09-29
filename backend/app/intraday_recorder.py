"""One-minute option-chain snapshots for intraday backtests (stop-losses, targets, AutoBot rules).

Nobody publishes past INTRADAY option prices for free, and an expired contract can't be fetched
later, so this records them ourselves from the chains the poller already keeps fresh (no extra
exchange calls): every minute of the session, for each symbol, its two nearest expiries, the
strikes within +/-STRIKES of the ATM -- price, bid / ask, IV, OI and volume for the call and put.

    data/intraday/<SYMBOL>/<YYYY-MM-DD>.csv      (today, appended to)
    data/intraday/<SYMBOL>/<YYYY-MM-DD>.csv.gz   (earlier days, compressed after the close)

A snapshot whose chain hasn't been re-fetched since the last one is skipped, so the file never
holds the same numbers twice under two times. Roughly 2-3 MB a day for the three indices, gzipped.
Asked 29-Sep with the EOD archive (eod_archive.py): data for faster backtests.
"""
from __future__ import annotations

import asyncio
import csv
import gzip
import logging
import os
import shutil
import time
from datetime import datetime, timedelta, timezone

from .config import DATA_DIR
from .store import store

log = logging.getLogger("intraday_recorder")

IST = timezone(timedelta(hours=5, minutes=30))
_DIR = DATA_DIR / "intraday"
SYMBOLS = [s.strip().upper() for s in os.getenv("INTRADAY_REC_SYMBOLS", "NIFTY,BANKNIFTY,SENSEX").split(",") if s.strip()]
STRIKES = int(os.getenv("INTRADAY_REC_STRIKES", "20"))  # each side of the ATM
EXPIRIES = 2
STALE_S = 300  # a chain older than this at snapshot time is not recorded

HEADER = [
    "time", "expiry", "spot", "atm", "strike",
    "ce_ltp", "ce_bid", "ce_ask", "ce_iv", "ce_oi", "ce_vol",
    "pe_ltp", "pe_bid", "pe_ask", "pe_iv", "pe_oi", "pe_vol",
    "fetched",
]
_last_fetch: dict[tuple[str, str], float] = {}


def _in_session(dt: datetime) -> bool:
    if dt.weekday() >= 5:
        return False
    m = dt.hour * 60 + dt.minute
    return 9 * 60 + 15 <= m <= 15 * 60 + 30


def _v(x):
    return "" if x is None else x


def _iv(leg: dict):
    return leg.get("iv") if leg.get("iv") is not None else leg.get("ivCalc")


def snapshot(now: datetime) -> int:
    """Append one minute's rows for every symbol / expiry whose chain is fresh. Returns rows written."""
    written = 0
    day = now.strftime("%Y-%m-%d")
    hhmm = now.strftime("%H:%M")
    for sym in SYMBOLS:
        exps = (store.expiries.get(sym) or [])[:EXPIRIES]
        lines: list[list] = []
        for exp in exps:
            chain = store.get_chain(sym, exp)
            if not chain or not chain.get("rows"):
                continue
            fa = chain.get("fetchedAt") or 0.0
            if time.time() - fa > STALE_S or _last_fetch.get((sym, exp)) == fa:
                continue
            _last_fetch[(sym, exp)] = fa
            spot = chain.get("spot")
            atm = chain.get("atmStrike") or 0
            step = chain.get("strikeStep") or 50
            lo, hi = atm - STRIKES * step, atm + STRIKES * step
            fetched = datetime.fromtimestamp(fa, IST).strftime("%H:%M:%S")
            for r in chain["rows"]:
                k = r.get("strike")
                if k is None or not lo <= k <= hi:
                    continue
                c, p = r.get("call") or {}, r.get("put") or {}
                lines.append([
                    hhmm, exp, spot, atm, k,
                    _v(c.get("ltp")), _v(c.get("bid")), _v(c.get("ask")), _v(_iv(c)), _v(c.get("oi")), _v(c.get("volume")),
                    _v(p.get("ltp")), _v(p.get("bid")), _v(p.get("ask")), _v(_iv(p)), _v(p.get("oi")), _v(p.get("volume")),
                    fetched,
                ])
        if not lines:
            continue
        d = _DIR / sym
        d.mkdir(parents=True, exist_ok=True)
        f = d / f"{day}.csv"
        new = not f.exists()
        with open(f, "a", newline="", encoding="utf-8") as fh:
            w = csv.writer(fh)
            if new:
                w.writerow(HEADER)
            w.writerows(lines)
        written += len(lines)
    return written


def compress_old(today: str) -> int:
    """gzip every finished day's file (anything before `today`)."""
    n = 0
    for f in _DIR.glob("*/*.csv"):
        if f.stem >= today:
            continue
        gz = f.with_suffix(".csv.gz")
        try:
            with open(f, "rb") as src, gzip.open(gz.with_suffix(".gz.part"), "wb", 6) as dst:
                shutil.copyfileobj(src, dst)
            os.replace(gz.with_suffix(".gz.part"), gz)
            f.unlink()
            n += 1
        except OSError as exc:
            log.warning("intraday gzip %s: %s", f, exc)
    return n


def status() -> dict:
    out = {}
    for sym in SYMBOLS:
        files = sorted((_DIR / sym).glob("*.csv*")) if (_DIR / sym).exists() else []
        days = sorted(f.name[:10] for f in files)
        out[sym] = {"days": len(days), "first": days[0] if days else None, "last": days[-1] if days else None,
                    "mb": round(sum(f.stat().st_size for f in files) / 1e6, 1)}
    return out


async def run(stop: asyncio.Event) -> None:
    last_min = ""
    compressed_for = ""
    while not stop.is_set():
        now = datetime.now(IST)
        try:
            day = now.strftime("%Y-%m-%d")
            if _in_session(now):
                m = now.strftime("%H:%M")
                if m != last_min:
                    last_min = m
                    # a thread: 6 chains x 41 strikes of formatting + a file append must not hold the loop
                    await asyncio.to_thread(snapshot, now)
            elif compressed_for != day and (now.hour * 60 + now.minute > 15 * 60 + 35 or now.hour < 9):
                compressed_for = day
                n = await asyncio.to_thread(compress_old, day if now.hour < 9 else (now + timedelta(days=1)).strftime("%Y-%m-%d"))
                if n:
                    log.info("intraday recorder: compressed %d day file(s)", n)
        except Exception as exc:  # noqa: BLE001 -- the loop must survive
            log.warning("intraday recorder: %s", exc)
        # wake at the start of the next minute (+2 s so the poller's chain has landed)
        secs = 62 - datetime.now(IST).second
        try:
            await asyncio.wait_for(stop.wait(), timeout=max(5, secs))
        except asyncio.TimeoutError:
            pass
