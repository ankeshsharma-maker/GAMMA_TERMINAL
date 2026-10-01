"""Own copy of the index candles, so a chart never has to ask Upstox for old data.

  * 1-minute candles (2 years) and daily candles (5 years) for the indices, in data/candles.db (SQLite);
  * a nightly job (after the close) adds the day, and a catch-up fills any missed days;
  * serve() answers a chart request from the store plus TODAY's candles live (Flattrade TPSeries when it is
    logged in, Upstox intraday otherwise). With nothing stored (or a gap) it returns None and the old
    Upstox path runs as before.

Storage: see status() -- bytes per row and rows per index per trading day."""
from __future__ import annotations

import asyncio
import logging
import sqlite3
import threading
import time
from datetime import date, datetime, timedelta, timezone

from .config import DATA_DIR

log = logging.getLogger("candle_store")

IST = timezone(timedelta(hours=5, minutes=30))
SYMBOLS = ("NIFTY", "BANKNIFTY", "SENSEX", "FINNIFTY", "MIDCPNIFTY", "BANKEX", "NIFTYNXT50", "INDIA VIX")
TF_1M, TF_D = 60, 86400
MIN_DAYS_BACK = 730  # 1-minute history kept
DAY_DAYS_BACK = 1825  # daily history kept
WINDOW = 25  # days per 1-minute request (Upstox caps a request at about a month)
# Flattrade (Noren) tokens for today's live candles that are not in INDEX_FEED_TOKENS; anything else uses Upstox intraday
_BROKER_TOKENS = {"SENSEX": ("BSE", "1")}

_DB = DATA_DIR / "candles.db"
_lock = threading.Lock()
_conn: sqlite3.Connection | None = None


def _db() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        _conn = sqlite3.connect(str(_DB), check_same_thread=False)
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.execute(
            "CREATE TABLE IF NOT EXISTS bars (sym TEXT, tf INTEGER, ts INTEGER, o REAL, h REAL, l REAL, c REAL, v REAL, "
            "PRIMARY KEY (sym, tf, ts)) WITHOUT ROWID"
        )
        _conn.execute("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)")
        _conn.commit()
    return _conn


def _q(sql: str, args: tuple = ()) -> list:
    with _lock:
        return _db().execute(sql, args).fetchall()


def _meta(k: str, default: str | None = None) -> str | None:
    r = _q("SELECT v FROM meta WHERE k=?", (k,))
    return r[0][0] if r else default


def _set_meta(k: str, v: str) -> None:
    with _lock:
        _db().execute("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)", (k, v))
        _db().commit()


def _upsert(sym: str, tf: int, rows: list[dict]) -> int:
    if not rows:
        return 0
    with _lock:
        c = _db()
        c.executemany(
            "INSERT OR REPLACE INTO bars (sym, tf, ts, o, h, l, c, v) VALUES (?,?,?,?,?,?,?,?)",
            [(sym, tf, int(r["time"]), r["open"], r["high"], r["low"], r["close"], r.get("volume") or 0.0) for r in rows],
        )
        c.commit()
    return len(rows)


def _rows(sym: str, tf: int, since: int) -> list[dict]:
    return [
        {"time": ts, "open": o, "high": h, "low": lo, "close": c, "volume": v}
        for ts, o, h, lo, c, v in _q("SELECT ts,o,h,l,c,v FROM bars WHERE sym=? AND tf=? AND ts>=? ORDER BY ts", (sym, tf, since))
    ]


def _last_ts(sym: str, tf: int) -> int | None:
    r = _q("SELECT MAX(ts) FROM bars WHERE sym=? AND tf=?", (sym, tf))
    return r[0][0] if r and r[0][0] is not None else None


def _day_of(ts: int) -> date:
    return datetime.fromtimestamp(ts, IST).date()


def _expected_last_day(today: date) -> date:
    """The latest weekday before today: the store must reach it (today itself comes live)."""
    d = today - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


# ----------------------------------------------------------------- serving
def _resample(rows: list[dict], secs: int) -> list[dict]:
    """1-minute rows -> `secs` buckets aligned to the 09:15 IST session open."""
    out: list[dict] = []
    cur = None
    for r in rows:
        d = _day_of(r["time"])
        open_ts = int(datetime(d.year, d.month, d.day, 9, 15, tzinfo=IST).timestamp())
        b = open_ts + ((r["time"] - open_ts) // secs) * secs
        if cur is None or cur["time"] != b:
            cur = {"time": b, "open": r["open"], "high": r["high"], "low": r["low"], "close": r["close"], "volume": r["volume"]}
            out.append(cur)
        else:
            cur["high"] = max(cur["high"], r["high"])
            cur["low"] = min(cur["low"], r["low"])
            cur["close"] = r["close"]
            cur["volume"] += r["volume"]
    return out


_live_cache: dict[str, tuple[float, list]] = {}
_live_locks: dict[str, asyncio.Lock] = {}


async def _live_today(sym: str) -> list[dict] | None:
    """Today's 1-minute candles: Flattrade when logged in, else Upstox intraday. None when neither answered.
    Cached 8 s so several chart refreshes share one call."""
    hit = _live_cache.get(sym)
    if hit and time.time() - hit[0] < 8:
        return hit[1]
    lock = _live_locks.setdefault(sym, asyncio.Lock())
    async with lock:
        hit = _live_cache.get(sym)
        if hit and time.time() - hit[0] < 8:
            return hit[1]
        from .brokers import get_broker
        from .config import INDEX_FEED_TOKENS

        today = datetime.now(IST).date()
        rows: list[dict] | None = None
        broker = get_broker()
        tok = INDEX_FEED_TOKENS.get(sym) or _BROKER_TOKENS.get(sym)
        if tok and broker.authed:
            try:
                got = await broker.tpseries(tok[0], tok[1], minutes_back=1800, interval="1")
                rows = [c for c in (got or []) if _day_of(c["time"]) == today]
            except Exception as exc:  # noqa: BLE001
                log.debug("live candles %s via broker: %s", sym, exc)
        if rows is None:
            from . import upstox_data as ud
            from .brokers.upstox import get_upstox

            ux = get_upstox()
            key = ux.underlying_key(sym) if ux.authed else None
            if key and not ud.rate_limited():
                try:
                    h = await ud._get_retry(ux, ud._hc_intraday(key, "minutes", 1))
                    rows = [r for r in _to_rows(h.get("data", {}).get("candles") or []) if _day_of(r["time"]) == today]
                except Exception as exc:  # noqa: BLE001
                    log.debug("live candles %s via upstox: %s", sym, exc)
        if rows is not None:
            rows.sort(key=lambda r: r["time"])
            _live_cache[sym] = (time.time(), rows)
        return rows


def _usable(sym: str) -> bool:
    if sym not in SYMBOLS or _meta(f"ready:{sym}") != "1":
        return False
    need = _expected_last_day(datetime.now(IST).date())
    last = _last_ts(sym, TF_1M)
    checked = _meta(f"checked:{sym}")
    have = max(filter(None, [_day_of(last) if last else None, date.fromisoformat(checked) if checked else None]), default=None)
    return have is not None and have >= need


async def serve(symbol: str, interval_s: int) -> list[dict] | None:
    """Candles for a chart from the store + today live, shaped like upstox_data.fetch_underlying_candles; None = use Upstox."""
    sym = symbol.upper()
    try:
        if not await asyncio.to_thread(_usable, sym):
            return None
        live = await _live_today(sym)
        if live is None:
            return None  # cannot see today: let the old path answer rather than show a chart that ends yesterday
        now = int(time.time())
        first_live = live[0]["time"] if live else None
        if interval_s <= 3600:
            stored = await asyncio.to_thread(_rows, sym, TF_1M, now - 20 * 86400)
            merged = [r for r in stored if first_live is None or r["time"] < first_live] + live
            return merged if len(merged) >= 40 else None
        if interval_s <= 21600:
            stored = await asyncio.to_thread(_rows, sym, TF_1M, now - 90 * 86400)
            merged = [r for r in stored if first_live is None or r["time"] < first_live] + live
            out = _resample(merged, 1800)
            return out if len(out) >= 40 else None
        daily = await asyncio.to_thread(_rows, sym, TF_D, now - DAY_DAYS_BACK * 86400)
        today = datetime.now(IST).date()
        if live:
            t0 = int(datetime(today.year, today.month, today.day, tzinfo=IST).timestamp())
            daily = [r for r in daily if r["time"] != t0]
            daily.append({
                "time": t0, "open": live[0]["open"], "high": max(r["high"] for r in live), "low": min(r["low"] for r in live),
                "close": live[-1]["close"], "volume": sum(r["volume"] for r in live),
            })
        return daily if len(daily) >= 40 else None
    except Exception as exc:  # noqa: BLE001
        log.warning("candle store serve %s failed: %s", sym, exc)
        return None


# ----------------------------------------------------------------- updating
def _to_rows(cs: list) -> list[dict]:
    from . import upstox_data as ud

    out = []
    for c in cs or []:
        ts = ud._candle_ts(c[0])
        o, h, lo, cl = (ud._num(c[i]) for i in (1, 2, 3, 4))
        if ts and None not in (o, h, lo, cl):
            out.append({"time": ts, "open": o, "high": h, "low": lo, "close": cl, "volume": ud._num(c[5]) if len(c) > 5 else 0.0})
    return out


async def _get(ux, path: str) -> list:
    from . import upstox_data as ud

    while ud.rate_limited():
        await asyncio.sleep(5)
    h = await ud._get_retry(ux, path)
    return (h.get("data") or {}).get("candles") or []


def _after_close() -> bool:
    n = datetime.now(IST)
    return n.weekday() < 5 and n.hour * 60 + n.minute >= 15 * 60 + 45


async def update_symbol(ux, sym: str) -> int:
    """Bring one index up to date: the first run backfills, later runs add what is missing. Returns rows written."""
    from . import upstox_data as ud

    key = ux.underlying_key(sym)
    if not key:
        return 0
    now_d = datetime.now(IST).date()
    wrote = 0
    try:  # daily
        last_d = _last_ts(sym, TF_D)
        frm = (now_d - timedelta(days=DAY_DAYS_BACK)) if last_d is None else (_day_of(last_d) - timedelta(days=5))
        wrote += _upsert(sym, TF_D, _to_rows(await _get(ux, ud._hc(key, "days", 1, now_d.isoformat(), frm.isoformat()))))
    except Exception as exc:  # noqa: BLE001
        log.warning("candle store daily %s: %s", sym, exc)
        return wrote
    last = _last_ts(sym, TF_1M)
    start = (now_d - timedelta(days=MIN_DAYS_BACK)) if last is None else (_day_of(last) - timedelta(days=1))
    d1 = now_d
    try:  # 1-minute, in windows from today backwards
        while d1 >= start:
            d0 = max(start, d1 - timedelta(days=WINDOW - 1))
            wrote += _upsert(sym, TF_1M, _to_rows(await _get(ux, ud._hc(key, "minutes", 1, d1.isoformat(), d0.isoformat()))))
            d1 = d0 - timedelta(days=1)
            await asyncio.sleep(0.8)
        # today's candles (history stops at yesterday for sub-day units)
        wrote += _upsert(sym, TF_1M, _to_rows(await _get(ux, ud._hc_intraday(key, "minutes", 1))))
    except Exception as exc:  # noqa: BLE001
        log.warning("candle store 1m %s: %s", sym, exc)
        return wrote
    _set_meta(f"ready:{sym}", "1")
    # verified up to the last finished session (today's own bars are stored once the market has closed)
    _set_meta(f"checked:{sym}", (now_d if _after_close() else _expected_last_day(now_d)).isoformat())
    return wrote


async def run_updater(stop: asyncio.Event) -> None:
    """Every 10 minutes: an index that is not ready (first backfill) or is behind gets updated, and once after the close
    each trading day so the day just finished is stored."""
    from .brokers.upstox import get_upstox

    await asyncio.sleep(45)
    while not stop.is_set():
        try:
            ux = get_upstox()
            if ux.authed:
                await ux.load_instruments()
                today = datetime.now(IST).date().isoformat()
                for sym in SYMBOLS:
                    if stop.is_set():
                        break
                    need_close_run = _after_close() and _meta(f"closed:{sym}") != today
                    behind = not await asyncio.to_thread(_usable, sym)
                    if need_close_run or behind:
                        n = await update_symbol(ux, sym)
                        if _after_close() and _meta(f"ready:{sym}") == "1":
                            _set_meta(f"closed:{sym}", today)
                        log.info("candle store: %s +%d rows", sym, n)
        except Exception as exc:  # noqa: BLE001
            log.warning("candle store updater: %s", exc)
        try:
            await asyncio.wait_for(stop.wait(), timeout=600)
        except asyncio.TimeoutError:
            pass


def status() -> dict:
    out: dict = {"file": str(_DB), "bytes": _DB.stat().st_size if _DB.exists() else 0, "symbols": {}}
    for sym in SYMBOLS:
        m = _q("SELECT COUNT(*), MIN(ts), MAX(ts) FROM bars WHERE sym=? AND tf=?", (sym, TF_1M))[0]
        d = _q("SELECT COUNT(*), MIN(ts), MAX(ts) FROM bars WHERE sym=? AND tf=?", (sym, TF_D))[0]
        out["symbols"][sym] = {
            "ready": _meta(f"ready:{sym}") == "1",
            "minuteRows": m[0],
            "minuteFrom": _day_of(m[1]).isoformat() if m[1] else None,
            "minuteTo": _day_of(m[2]).isoformat() if m[2] else None,
            "dailyRows": d[0],
            "dailyFrom": _day_of(d[1]).isoformat() if d[1] else None,
            "dailyTo": _day_of(d[2]).isoformat() if d[2] else None,
        }
    tot = sum(v["minuteRows"] + v["dailyRows"] for v in out["symbols"].values())
    out["rows"] = tot
    out["bytesPerRow"] = round(out["bytes"] / tot, 1) if tot else None
    return out
