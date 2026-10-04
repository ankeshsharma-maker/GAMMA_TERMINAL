"""Download NSE's (NIFTY) and BSE's (SENSEX) daily F&O bhavcopy (UDiFF, from July 2024) and keep the INDEX OPTION rows (IDO):
per day, per index, the expiries within 60 days, strikes within +-10% of the underlying:

    {"NIFTY": {"u": underlying, "lot": lot, "e": {"2026-10-06": {"C": [[strike, open, settle, volume, OI], ...], "P": [...]}, ...}}, "SENSEX": {...}}

One gzip-JSON per trading day in data/idx_opt_hist/YYYYMMDD.json.gz (a day with neither file = {}); existing days are skipped.
    python tools/fo_index_fetch.py [FROM YYYY-MM-DD] [TO YYYY-MM-DD]
"""
from __future__ import annotations

import asyncio
import csv
import gzip
import io
import json
import sys
import zipfile
from datetime import date, timedelta
from pathlib import Path

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.config import DATA_DIR  # noqa: E402

OUT = DATA_DIR / "idx_opt_hist"
BAND, SPAN = 0.10, 60
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", "Accept": "*/*"}


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse(rd, sym: str, day: date, into: dict) -> None:
    for r in rd:
        if r.get("FinInstrmTp") != "IDO" or r.get("TckrSymb") != sym:
            continue
        und, k = _f(r.get("UndrlygPric")), _f(r.get("StrkPric"))
        if not und or not k or abs(k / und - 1) > BAND:
            continue
        ex = r["XpryDt"]
        if (date.fromisoformat(ex) - day).days > SPAN:
            continue
        cur = into.setdefault(sym, {"u": und, "lot": int(_f(r.get("NewBrdLotQty")) or 0), "e": {}})
        e = cur["e"].setdefault(ex, {"C": [], "P": []})
        e["C" if r["OptnTp"] == "CE" else "P"].append(
            [k, _f(r.get("OpnPric")), _f(r.get("SttlmPric")), int(_f(r.get("TtlTradgVol")) or 0), int(_f(r.get("OpnIntrst")) or 0)])
    for cur in into.values():
        for e in cur["e"].values():
            e["C"].sort()
            e["P"].sort()


async def get(c: httpx.AsyncClient, url: str, referer: str | None = None) -> bytes | None:
    try:
        r = await c.get(url, headers={"Referer": referer} if referer else None)
    except Exception:  # noqa: BLE001
        return None
    return r.content if r.status_code == 200 and len(r.content) > 1000 else None


async def main() -> None:
    a = sys.argv[1:]
    d0 = date.fromisoformat(a[0]) if a else date(2024, 7, 8)
    d1 = date.fromisoformat(a[1]) if len(a) > 1 else date.today() - timedelta(days=1)
    OUT.mkdir(parents=True, exist_ok=True)
    n = miss = 0
    async with httpx.AsyncClient(headers=UA, timeout=httpx.Timeout(40.0), follow_redirects=True) as c:
        d = d0
        while d <= d1:
            f = OUT / f"{d.strftime('%Y%m%d')}.json.gz"
            if d.weekday() < 5 and not f.exists():
                day: dict = {}
                nse = await get(c, f"https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{d.strftime('%Y%m%d')}_F_0000.csv.zip")
                if nse:
                    with zipfile.ZipFile(io.BytesIO(nse)) as z, z.open(z.namelist()[0]) as fh:
                        parse(csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8")), "NIFTY", d, day)
                bse = await get(c, f"https://www.bseindia.com/download/Bhavcopy/Derivative/BhavCopy_BSE_FO_0_0_0_{d.strftime('%Y%m%d')}_F_0000.CSV", "https://www.bseindia.com/")
                if bse:
                    parse(csv.DictReader(io.StringIO(bse.decode("utf-8", "replace"))), "SENSEX", d, day)
                f.write_bytes(gzip.compress(json.dumps(day, separators=(",", ":")).encode(), 6))
                if day:
                    n += 1
                else:
                    miss += 1
                if (n + miss) % 20 == 0:
                    print(d, "days:", n, "empty:", miss, flush=True)
                await asyncio.sleep(0.6)
            d += timedelta(days=1)
    print("done:", n, "days,", miss, "empty")


if __name__ == "__main__":
    asyncio.run(main())
