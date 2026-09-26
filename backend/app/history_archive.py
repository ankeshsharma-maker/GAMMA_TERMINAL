"""Append-only, market-hours archive of the per-poll chain features that the
gamma-blast scanner reads, so its weights and thresholds can be back-tested on
real sessions.

`store.history` is a 720-sample ring buffer that off-hours polling overwrites
overnight, so nothing else keeps a past session. One JSONL file per symbol per
IST trading day: data/history_archive/<SYMBOL>/<YYYY-MM-DD>.jsonl
"""
from __future__ import annotations

import json
import logging
import os
import re
from datetime import datetime, timedelta, timezone

from .config import DATA_DIR

log = logging.getLogger(__name__)

_IST = timezone(timedelta(hours=5, minutes=30))
_DIR = DATA_DIR / "history_archive"

SYMBOLS = {
    s.strip().upper()
    for s in os.getenv("BLAST_ARCHIVE_SYMBOLS", "NIFTY,BANKNIFTY,FINNIFTY,SENSEX").split(",")
    if s.strip()
}
MIN_GAP_S = float(os.getenv("BLAST_ARCHIVE_MIN_GAP_S", "20"))
KEEP_DAYS = int(os.getenv("BLAST_ARCHIVE_KEEP_DAYS", "90"))

_FIELDS = (
    "t", "expiry", "dte", "spot", "atmIV", "atmCEIV", "atmPEIV", "atmStraddle",
    "atmGammaOI", "netGex", "gammaFlip", "maxPain", "pcr", "ceOI", "peOI",
    "ceOIChg", "peOIChg", "ceVol", "peVol",
)

_last_t: dict[str, float] = {}
_last_day: str | None = None


def in_session(t: float) -> bool:
    """NSE/BSE equity-derivatives hours: Mon-Fri 09:15-15:30 IST."""
    dt = datetime.fromtimestamp(t, _IST)
    if dt.weekday() >= 5:
        return False
    m = dt.hour * 60 + dt.minute
    return 9 * 60 + 15 <= m <= 15 * 60 + 30


def _prune(today: str) -> None:
    cutoff = (datetime.strptime(today, "%Y-%m-%d") - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    for f in _DIR.glob("*/*.jsonl"):
        if f.stem < cutoff:
            f.unlink(missing_ok=True)


def record(symbol: str, row: dict) -> None:
    """Archive one store.history row. Never raises: recording must not be able
    to break polling."""
    global _last_day
    try:
        if symbol not in SYMBOLS:
            return
        t = row.get("t")
        if not t or not in_session(t) or t - _last_t.get(symbol, 0.0) < MIN_GAP_S:
            return
        _last_t[symbol] = t
        day = datetime.fromtimestamp(t, _IST).strftime("%Y-%m-%d")
        d = _DIR / symbol
        d.mkdir(parents=True, exist_ok=True)
        with open(d / f"{day}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({k: row.get(k) for k in _FIELDS}, separators=(",", ":")) + "\n")
        if day != _last_day:
            _last_day = day
            _prune(day)
    except Exception as exc:  # noqa: BLE001
        log.debug("history archive write failed: %s", exc)


# ---------------------------------------------------------------- reading it back (the PCR chart)
_DAY_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def days(symbol: str) -> list[str]:
    """Trading days that have an archive file for `symbol`, newest first (empty for a symbol that is not archived)."""
    sym = (symbol or "").upper()
    if sym not in SYMBOLS:
        return []
    try:
        return sorted((f.stem for f in (_DIR / sym).glob("*.jsonl") if _DAY_RE.match(f.stem)), reverse=True)
    except OSError:
        return []


def read(symbol: str, day: str) -> list[dict]:
    """One archived day's rows, oldest first. A torn last line (a crash mid-write) or any bad line is skipped."""
    sym = (symbol or "").upper()
    if sym not in SYMBOLS or not _DAY_RE.match(day or ""):
        return []
    rows: list[dict] = []
    try:
        with open(_DIR / sym / f"{day}.jsonl", encoding="utf-8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if isinstance(r, dict) and r.get("t"):
                    rows.append(r)
    except OSError:
        return []
    # a reading in other OI units (the first chain after a restart came from NSE in lots,
    # Upstox gives shares) -- drop anything >20x off the day's median total
    tots = sorted((r.get("ceOI") or 0) + (r.get("peOI") or 0) for r in rows)
    med = tots[len(tots) // 2] if tots else 0
    if med > 0:
        rows = [r for r in rows if not (lambda t: t > 0 and (t / med > 20 or med / t > 20))((r.get("ceOI") or 0) + (r.get("peOI") or 0))]
    return rows
