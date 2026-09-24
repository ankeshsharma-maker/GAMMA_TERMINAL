"""Where the OI walls sit through the day -- the strike with the most call OI
(resistance) and the most put OI (support), plus the runners-up and spot --
for the OI tab's Walls view ("did resistance / support move?").

Recorded from every chain poll, at most once a minute per (symbol, expiry),
from 09:15 to 16:00 IST (NSE settles OI after the close, so the last half
hour catches the day's final walls). Kept in memory and appended to one JSONL
file per symbol per IST day (data/oi_walls/<SYMBOL>/<YYYY-MM-DD>.jsonl), so a
backend restart mid-session doesn't wipe the day. Past days can't be rebuilt
from Upstox history: its per-contract candles come back empty for exactly the
big round strikes (23000 / 23500 / 24000 on 24-Sep) that hold the walls.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone

from .config import DATA_DIR

log = logging.getLogger(__name__)

_IST = timezone(timedelta(hours=5, minutes=30))
_DIR = DATA_DIR / "oi_walls"
MIN_GAP_S = 60.0
KEEP_DAYS = 30

# (SYMBOL, day) -> rows (all expiries); loaded from disk on first read
_rows: dict[tuple[str, str], list[dict]] = {}
_last_t: dict[tuple[str, str], float] = {}
_pruned_day: str | None = None


def _day(t: float) -> str:
    return datetime.fromtimestamp(t, _IST).strftime("%Y-%m-%d")


def in_window(t: float) -> bool:
    """Mon-Fri 09:15-16:00 IST."""
    dt = datetime.fromtimestamp(t, _IST)
    if dt.weekday() >= 5:
        return False
    m = dt.hour * 60 + dt.minute
    return 9 * 60 + 15 <= m <= 16 * 60


def walls(snap: dict[int, tuple[float, float]]) -> dict | None:
    """{strike: (callOI, putOI)} -> the top two call and put strikes with their OI."""
    if not snap:
        return None
    ce = sorted(((oi[0], k) for k, oi in snap.items() if oi[0] > 0), reverse=True)[:2]
    pe = sorted(((oi[1], k) for k, oi in snap.items() if oi[1] > 0), reverse=True)[:2]
    if not ce or not pe:
        return None
    return {
        "cw": ce[0][1], "cwOI": ce[0][0], "cw2": ce[1][1] if len(ce) > 1 else None, "cw2OI": ce[1][0] if len(ce) > 1 else None,
        "pw": pe[0][1], "pwOI": pe[0][0], "pw2": pe[1][1] if len(pe) > 1 else None, "pw2OI": pe[1][0] if len(pe) > 1 else None,
    }


def _load(symbol: str, day: str) -> list[dict]:
    key = (symbol, day)
    if key not in _rows:
        rows: list[dict] = []
        f = _DIR / symbol / f"{day}.jsonl"
        if f.exists():
            for line in f.read_text(encoding="utf-8").splitlines():
                try:
                    rows.append(json.loads(line))
                except ValueError:
                    continue
        _rows[key] = rows
    return _rows[key]


def _prune(today: str) -> None:
    global _pruned_day
    if _pruned_day == today:
        return
    _pruned_day = today
    cutoff = (datetime.strptime(today, "%Y-%m-%d") - timedelta(days=KEEP_DAYS)).strftime("%Y-%m-%d")
    for f in _DIR.glob("*/*.jsonl"):
        if f.stem < cutoff:
            f.unlink(missing_ok=True)
    for k in [k for k in _rows if k[1] < today]:  # yesterday's rows out of memory
        del _rows[k]


def record(symbol: str, expiry: str, snap: dict[int, tuple[float, float]], spot: float | None, now: float) -> None:
    """One poll's walls. Never raises: recording must not break polling."""
    try:
        if not in_window(now):
            return
        symbol = symbol.upper()
        if now - _last_t.get((symbol, expiry), 0.0) < MIN_GAP_S:
            return
        w = walls(snap)
        if not w:
            return
        _last_t[(symbol, expiry)] = now
        day = _day(now)
        _prune(day)
        row = {"t": round(now, 1), "expiry": expiry, "spot": round(spot, 2) if spot else None, **w}
        _load(symbol, day).append(row)
        d = _DIR / symbol
        d.mkdir(parents=True, exist_ok=True)
        with open(d / f"{day}.jsonl", "a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")
    except Exception as exc:  # noqa: BLE001
        log.warning("oi_walls record %s %s failed: %s", symbol, expiry, exc)


def series(symbol: str, expiry: str, day: str | None = None) -> list[dict]:
    """The recorded rows for one expiry on `day` (default: today, IST)."""
    import time

    day = day or _day(time.time())
    return [r for r in _load(symbol.upper(), day) if r.get("expiry") == expiry]
