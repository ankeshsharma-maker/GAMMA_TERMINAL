"""Permanent archive of the exchanges' end-of-day files, for backtesting.

Every file is saved exactly as the exchange publishes it (zips as they are, CSVs gzipped), one per
kind per trading day, and kept for good:

    data/eod/<kind>/<YYYY>/<file>

    nse_fo       NSE F&O UDiFF bhavcopy (every option / future: OHLC, settle, OI, underlying)
    nse_cm       NSE cash-market UDiFF bhavcopy (every stock)
    nse_deliv    NSE sec_bhavdata_full (delivery quantity / %)
    nse_indices  NSE ind_close_all (every index's OHLC)
    bse_fo       BSE F&O UDiFF bhavcopy (SENSEX / BANKEX options, same columns as NSE's)
    bse_cm       BSE cash-market UDiFF bhavcopy

About 2.9 MB a trading day (~0.7 GB a year). The files are published around 18:00-19:00 IST; a
loop checks every 30 minutes and fills any of the last ~10 trading days that is missing, so a
restart or a slow evening never leaves a gap. A day with no file (a holiday, or not out yet) is
asked again after 2 h while it is recent. Other code reads through `read_bytes` first (e.g. the
bhavcopy gamma-flip history) instead of downloading the same file again.
Asked 29-Sep: "download daily data for backtesting ... output in less time".
"""
from __future__ import annotations

import asyncio
import gzip
import logging
import os
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from .config import DATA_DIR

log = logging.getLogger("eod_archive")

IST = timezone(timedelta(hours=5, minutes=30))
_DIR = DATA_DIR / "eod"
_DAYS_BACK = 10  # trading days the loop keeps complete
_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "*/*",
}
_NSE = "https://nsearchives.nseindia.com"
_BSE = "https://www.bseindia.com"

# kind -> (url for a day, file name for a day, gzip it?, extra headers). All verified 29-Sep 22:55 IST.
KINDS: dict[str, tuple] = {
    "nse_fo": (lambda d: f"{_NSE}/content/fo/BhavCopy_NSE_FO_0_0_0_{d:%Y%m%d}_F_0000.csv.zip",
               lambda d: f"BhavCopy_NSE_FO_{d:%Y%m%d}.csv.zip", False, {}),
    "nse_cm": (lambda d: f"{_NSE}/content/cm/BhavCopy_NSE_CM_0_0_0_{d:%Y%m%d}_F_0000.csv.zip",
               lambda d: f"BhavCopy_NSE_CM_{d:%Y%m%d}.csv.zip", False, {}),
    "nse_deliv": (lambda d: f"{_NSE}/products/content/sec_bhavdata_full_{d:%d%m%Y}.csv",
                  lambda d: f"sec_bhavdata_full_{d:%Y%m%d}.csv.gz", True, {}),
    "nse_indices": (lambda d: f"{_NSE}/content/indices/ind_close_all_{d:%d%m%Y}.csv",
                    lambda d: f"ind_close_all_{d:%Y%m%d}.csv.gz", True, {}),
    "bse_fo": (lambda d: f"{_BSE}/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_{d:%Y%m%d}_F_0000.CSV",
               lambda d: f"BhavCopy_BSE_FO_{d:%Y%m%d}.csv.gz", True, {"Referer": f"{_BSE}/"}),
    "bse_cm": (lambda d: f"{_BSE}/download/BhavCopy/Equity/BhavCopy_BSE_CM_0_0_0_{d:%Y%m%d}_F_0000.CSV",
               lambda d: f"BhavCopy_BSE_CM_{d:%Y%m%d}.csv.gz", True, {"Referer": f"{_BSE}/"}),
}
_missing_at: dict[str, float] = {}  # "kind:YYYYMMDD" -> when the exchange last had no file


def path_for(kind: str, d: date) -> Path:
    return _DIR / kind / f"{d:%Y}" / KINDS[kind][1](d)


def read_bytes(kind: str, yyyymmdd: str) -> bytes | None:
    """The archived file as the exchange published it (gunzipped for the CSVs), or None."""
    try:
        d = datetime.strptime(yyyymmdd, "%Y%m%d").date()
        p = path_for(kind, d)
        if not p.exists():
            return None
        raw = p.read_bytes()
        return gzip.decompress(raw) if KINDS[kind][2] else raw
    except Exception as exc:  # noqa: BLE001
        log.debug("eod read %s %s: %s", kind, yyyymmdd, exc)
        return None


def save_bytes(kind: str, d: date, content: bytes) -> bool:
    """Store one file (atomically: a crash never leaves half a file that looks complete)."""
    try:
        p = path_for(kind, d)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_suffix(p.suffix + ".part")
        tmp.write_bytes(gzip.compress(content, 6) if KINDS[kind][2] else content)
        os.replace(tmp, p)
        return True
    except OSError as exc:
        log.warning("eod save %s %s: %s", kind, d, exc)
        return False


async def _get(client, url: str, headers: dict) -> bytes | None:
    try:
        r = await client.get(url, headers=headers)
    except Exception as exc:  # noqa: BLE001
        log.debug("eod fetch %s: %s", url, exc)
        return None
    if r.status_code != 200 or len(r.content) < 1000:
        return None
    return r.content


def _days_wanted(now: datetime) -> list[date]:
    """The last _DAYS_BACK weekdays, up to today once the files can be out (after 18:30 IST)."""
    d = now.date() if now.hour * 60 + now.minute >= 18 * 60 + 30 else now.date() - timedelta(days=1)
    out: list[date] = []
    while len(out) < _DAYS_BACK:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    return out


async def fill(days: list[date], stop: asyncio.Event | None = None) -> int:
    """Download whatever of `days` x KINDS is missing. Gentle on the exchanges: one file at a time."""
    import httpx

    got = 0
    now = datetime.now(IST)
    async with httpx.AsyncClient(headers=_UA, timeout=httpx.Timeout(60.0), follow_redirects=True) as client:
        for d in days:
            recent = (now.date() - d).days <= 3
            for kind, (url, _name, _gz, hdr) in KINDS.items():
                if stop is not None and stop.is_set():
                    return got
                if path_for(kind, d).exists():
                    continue
                key = f"{kind}:{d:%Y%m%d}"
                if key in _missing_at and (not recent or time.time() - _missing_at[key] < 7200):
                    continue
                content = await _get(client, url(d), hdr)
                await asyncio.sleep(1.5)
                if not content:
                    _missing_at[key] = time.time()
                    continue
                if save_bytes(kind, d, content):
                    got += 1
    return got


def status() -> dict:
    """What is archived: per kind, the number of days, first / last day and size on disk."""
    out: dict[str, dict] = {}
    total = 0
    for kind in KINDS:
        files = sorted((_DIR / kind).glob("*/*")) if (_DIR / kind).exists() else []
        files = [f for f in files if not f.name.endswith(".part")]
        size = sum(f.stat().st_size for f in files)
        total += size
        days = sorted("".join(ch for ch in f.name if ch.isdigit())[-8:] for f in files)
        out[kind] = {"days": len(files), "first": days[0] if days else None, "last": days[-1] if days else None,
                     "mb": round(size / 1e6, 1)}
    return {"kinds": out, "totalMb": round(total / 1e6, 1), "dir": str(_DIR)}


async def run(stop: asyncio.Event) -> None:
    await asyncio.sleep(60)  # let the live feeds settle after a restart first
    while not stop.is_set():
        try:
            n = await fill(_days_wanted(datetime.now(IST)), stop)
            if n:
                log.info("eod archive: +%d files (%s MB total)", n, status()["totalMb"])
        except Exception as exc:  # noqa: BLE001 -- the loop must survive
            log.warning("eod archive loop: %s", exc)
        try:
            await asyncio.wait_for(stop.wait(), timeout=1800)
        except asyncio.TimeoutError:
            pass
