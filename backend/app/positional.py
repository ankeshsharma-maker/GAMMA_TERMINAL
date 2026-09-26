"""Positional-scanner data that only NSE's end-of-day files carry: each stock's delivery %
(sec_bhavdata_full) and its futures open interest across the last sessions (the F&O UDiFF
bhavcopy, stock futures only).

Both are public static files, published around 18:00-19:00 IST for the day. The last
~12 sessions are kept on disk (one small JSON per file per day) so a restart doesn't
re-download them; a loop checks every 30 minutes for the newest day.

Futures OI is summed over ALL of a stock's expiries: near expiry the front month's OI
collapses as positions roll to the next (26-Sep: ABCAPITAL's Sep future -9.9M in a day),
which on the front contract alone would read as heavy unwinding.
"""
from __future__ import annotations

import asyncio
import csv
import io
import json
import logging
import time
import zipfile
from datetime import date, datetime, timedelta, timezone

from .config import DATA_DIR

log = logging.getLogger("positional")

IST = timezone(timedelta(hours=5, minutes=30))
_DIR = DATA_DIR / "nse_daily"
KEEP = 12  # trading sessions kept
OI_DAYS = 5  # the build-up window, in sessions
_UA = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "*/*",
}

# "YYYYMMDD" -> {sym: [...]} ; an empty dict = no file that day (holiday) -- retried later for recent days
_deliv: dict[str, dict] = {}
_fo: dict[str, dict] = {}
_missing_at: dict[str, float] = {}  # "kind:YYYYMMDD" -> when we last found no file


def _num(v) -> float | None:
    try:
        x = float(str(v).strip())
        return x
    except (TypeError, ValueError):
        return None


# ------------------------------------------------------------------ fetch + parse
async def _get(url: str) -> bytes | None:
    import httpx

    try:
        async with httpx.AsyncClient(headers=_UA, timeout=httpx.Timeout(30.0), follow_redirects=True) as c:
            r = await c.get(url)
    except Exception as exc:  # noqa: BLE001
        log.debug("fetch %s: %s", url, exc)
        return None
    if r.status_code != 200 or len(r.content) < 1000:
        return None
    return r.content


def _parse_deliv(raw: bytes) -> dict:
    """sec_bhavdata_full: EQ series only -> {SYM: [deliv %, deliv qty, traded qty]}"""
    out: dict[str, list] = {}
    rdr = csv.DictReader(io.StringIO(raw.decode("utf-8", "replace")))
    for r in rdr:
        r = {(k or "").strip(): (v or "").strip() for k, v in r.items()}
        if r.get("SERIES") != "EQ":
            continue
        pct, dq, tq = _num(r.get("DELIV_PER")), _num(r.get("DELIV_QTY")), _num(r.get("TTL_TRD_QNTY"))
        if pct is None:
            continue
        out[r.get("SYMBOL", "")] = [round(pct, 2), dq or 0, tq or 0]
    return out


def _parse_fo(raw: bytes) -> dict:
    """UDiFF F&O bhavcopy, stock futures (STF): {SYM: [total OI over all expiries, underlying price,
    {expiry: [close, previous close]}]} -- NSE's previous close is already adjusted for a corporate
    action on its ex-date, which is how a bonus / split is told apart from a real move."""
    out: dict[str, list] = {}
    z = zipfile.ZipFile(io.BytesIO(raw))
    with z.open(z.namelist()[0]) as f:
        for r in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8")):
            if r.get("FinInstrmTp") != "STF":
                continue
            sym = r.get("TckrSymb", "")
            oi = _num(r.get("OpnIntrst")) or 0.0
            und = _num(r.get("UndrlygPric"))
            cur = out.setdefault(sym, [0.0, None, {}])
            cur[0] += oi
            if und:
                cur[1] = und
            cls, prv = _num(r.get("ClsPric")), _num(r.get("PrvsClsgPric"))
            if cls and prv:
                cur[2][r.get("XpryDt", "")] = [cls, prv]
    return out


def _path(kind: str, ymd: str):
    return _DIR / f"{kind}_{ymd}.json"


def _load_disk() -> None:
    _DIR.mkdir(parents=True, exist_ok=True)
    for p in _DIR.glob("*.json"):
        try:
            kind, ymd = p.stem.split("_", 1)
            data = json.loads(p.read_text("utf-8"))
        except (ValueError, OSError):
            continue
        (_deliv if kind == "deliv" else _fo if kind == "fo" else {})[ymd] = data


def _save(kind: str, ymd: str, data: dict) -> None:
    try:
        _DIR.mkdir(parents=True, exist_ok=True)
        _path(kind, ymd).write_text(json.dumps(data, separators=(",", ":")), "utf-8")
    except OSError as exc:
        log.warning("positional save %s %s: %s", kind, ymd, exc)


def _prune() -> None:
    for store, kind in ((_deliv, "deliv"), (_fo, "fo")):
        real = sorted(k for k, v in store.items() if v)
        for old in real[:-KEEP]:
            store.pop(old, None)
            try:
                _path(kind, old).unlink()
            except OSError:
                pass


def _days_wanted(now: datetime) -> list[date]:
    """The last ~KEEP+4 weekdays up to the newest one whose files could be out (after 18:30)."""
    d = now.date() if now.hour * 60 + now.minute >= 18 * 60 + 30 else now.date() - timedelta(days=1)
    out: list[date] = []
    while len(out) < KEEP + 4:
        if d.weekday() < 5:
            out.append(d)
        d -= timedelta(days=1)
    return out


async def _fill(stop: asyncio.Event) -> int:
    got = 0
    now = datetime.now(IST)
    for d in _days_wanted(now):
        if stop.is_set():
            break
        ymd = d.strftime("%Y%m%d")
        recent = (now.date() - d).days <= 3
        for kind, store, url, parse in (
            ("deliv", _deliv, f"https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{d.strftime('%d%m%Y')}.csv", _parse_deliv),
            ("fo", _fo, f"https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{ymd}_F_0000.csv.zip", _parse_fo),
        ):
            if store.get(ymd):
                continue
            key = f"{kind}:{ymd}"
            # a day with no file: holiday -- or not published yet, so recent days are retried after 2 h
            if key in _missing_at and (not recent or time.time() - _missing_at[key] < 7200):
                continue
            raw = await _get(url)
            await asyncio.sleep(2.0)  # gentle on NSE
            if not raw:
                _missing_at[key] = time.time()
                continue
            try:
                data = parse(raw)
            except Exception as exc:  # noqa: BLE001
                log.warning("positional parse %s: %s", key, exc)
                _missing_at[key] = time.time()
                continue
            if data:
                store[ymd] = data
                _save(kind, ymd, data)
                got += 1
    _prune()
    return got


async def run(stop: asyncio.Event) -> None:
    _load_disk()
    await asyncio.sleep(30)
    while not stop.is_set():
        try:
            n = await _fill(stop)
            if n:
                log.info("positional: +%d NSE day files (deliv %d, fo %d days)", n,
                         sum(1 for v in _deliv.values() if v), sum(1 for v in _fo.values() if v))
        except Exception as exc:  # noqa: BLE001 -- the loop must survive
            log.warning("positional loop: %s", exc)
        try:
            await asyncio.wait_for(stop.wait(), timeout=1800)
        except asyncio.TimeoutError:
            pass


# ------------------------------------------------------------------ per-stock summary
def _classify(oi_chg: float, px_chg: float) -> str | None:
    if abs(px_chg) < 0.25:
        return None  # price flat: no side to read into the OI change
    if oi_chg >= 0:
        return "LONG_BUILDUP" if px_chg >= 0 else "SHORT_BUILDUP"
    return "SHORT_COVERING" if px_chg >= 0 else "LONG_UNWINDING"


def _adjusted(sym: str, days: list[str]) -> list:
    """[oi, price] per day (None where the stock had no futures), with days before a corporate action
    rescaled when NSE's adjusted previous close says a bonus / split went ex that day. (A plain price
    x OI test is not enough: 24-Sep POLICYBZR 1886 -> 1207 with OI 9.0M -> 13.9M looked like a 1:2
    bonus but was a real crash -- it opened at 1697 and traded 27M shares vs ~1M.)"""
    rows = [_fo[d].get(sym) for d in days]
    ser = [[r[0], r[1]] if r and r[1] else None for r in rows]
    for i in range(len(rows) - 1, 0, -1):
        new, old = rows[i], rows[i - 1]
        if not new or not old or len(new) < 3 or len(old) < 3:
            continue
        # the same contract on both days: NSE's (adjusted) previous close vs that day's actual close
        common = [e for e in new[2] if e in old[2]]
        if not common:
            continue
        r = new[2][common[0]][1] / old[2][common[0]][0]
        if abs(r - 1) > 0.02:  # an ex-date: everything before it into the new units
            for j in range(i):
                if ser[j]:
                    ser[j] = [ser[j][0] / r, ser[j][1] * r]
    return ser


def summary(sym: str) -> dict:
    """Delivery (the latest file; x its average over the sessions before) and futures OI change
    over 1 and OI_DAYS sessions, with the underlying's move over the same stretch."""
    out: dict = {}
    days = sorted(k for k, v in _deliv.items() if v)
    if days:
        last = _deliv[days[-1]].get(sym)
        if last:
            prev = [_deliv[d][sym][0] for d in days[-11:-1] if sym in _deliv[d]]
            avg = sum(prev) / len(prev) if prev else None
            out["deliv"] = last[0]
            out["delivX"] = round(last[0] / avg, 2) if avg else None
            out["delivDate"] = days[-1]
    fdays = sorted(k for k, v in _fo.items() if v)
    if fdays and sym in _fo[fdays[-1]]:
        ser = _adjusted(sym, fdays[-(OI_DAYS + 1):])
        oi_l, px_l = ser[-1]
        out["oiDate"] = fdays[-1]
        out["oi"] = oi_l
        for n, tag in ((1, "1"), (OI_DAYS, "5")):
            if len(ser) > n and ser[-1 - n]:
                oi_b, px_b = ser[-1 - n]
                if oi_b and px_b and px_l:
                    oc = (oi_l / oi_b - 1) * 100
                    pc = (px_l / px_b - 1) * 100
                    out[f"oiChg{tag}"] = round(oc, 2)
                    out[f"pxChg{tag}"] = round(pc, 2)
                    out[f"oiType{tag}"] = _classify(oc, pc)
    return out


def status() -> dict:
    d = sorted(k for k, v in _deliv.items() if v)
    f = sorted(k for k, v in _fo.items() if v)
    return {"delivDays": len(d), "delivLast": d[-1] if d else None, "foDays": len(f), "foLast": f[-1] if f else None}
