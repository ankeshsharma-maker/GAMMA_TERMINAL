"""Download NSE's daily F&O bhavcopy (UDiFF) again and keep the STOCK OPTION rows (STO) the ITM / ATM / OTM buying backtest needs:
per day, per stock, the nearest two expiries, strikes within +-15% of the underlying:

    {SYM: {"u": underlying price, "lot": lot size,
           "e": {"2026-10-27": {"C": [[strike, open, settle, volume, OI], ...], "P": [...]}, ...}}}

One gzip-JSON per trading day in data/nse_opt_hist/YYYYMMDD.json.gz (a holiday is recorded as {}); existing days are skipped,
so it can be stopped and resumed.   python tools/fo_opt_fetch.py [FROM YYYY-MM-DD] [TO YYYY-MM-DD]
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

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import positional  # noqa: E402
from app.config import DATA_DIR  # noqa: E402

OUT = DATA_DIR / "nse_opt_hist"
BAND = 0.15


def _f(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def parse(raw: bytes) -> dict:
    rows: dict = {}
    with zipfile.ZipFile(io.BytesIO(raw)) as z, z.open(z.namelist()[0]) as f:
        for r in csv.DictReader(io.TextIOWrapper(f, encoding="utf-8")):
            if r.get("FinInstrmTp") != "STO":
                continue
            und, k = _f(r.get("UndrlygPric")), _f(r.get("StrkPric"))
            if not und or not k or abs(k / und - 1) > BAND:
                continue
            sym = r["TckrSymb"]
            cur = rows.setdefault(sym, {"u": und, "lot": int(_f(r.get("NewBrdLotQty")) or 0), "e": {}})
            ex = cur["e"].setdefault(r["XpryDt"], {"C": [], "P": []})
            ex["C" if r["OptnTp"] == "CE" else "P"].append(
                [k, _f(r.get("OpnPric")), _f(r.get("SttlmPric")), int(_f(r.get("TtlTradgVol")) or 0), int(_f(r.get("OpnIntrst")) or 0)])
    for cur in rows.values():  # nearest two expiries only
        for e in sorted(cur["e"])[2:]:
            del cur["e"][e]
        for ex in cur["e"].values():
            ex["C"].sort()
            ex["P"].sort()
    return rows


async def main() -> None:
    a = sys.argv[1:]
    d0 = date.fromisoformat(a[0]) if a else date(2024, 7, 8)
    d1 = date.fromisoformat(a[1]) if len(a) > 1 else date.today() - timedelta(days=1)
    OUT.mkdir(parents=True, exist_ok=True)
    d, n, miss = d0, 0, 0
    while d <= d1:
        f = OUT / f"{d.strftime('%Y%m%d')}.json.gz"
        if d.weekday() < 5 and not f.exists():
            raw = await positional._get(f"https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{d.strftime('%Y%m%d')}_F_0000.csv.zip")
            if raw:
                try:
                    f.write_bytes(gzip.compress(json.dumps(parse(raw), separators=(",", ":")).encode(), 6))
                    n += 1
                except Exception as exc:  # noqa: BLE001
                    print(d, "parse failed:", exc, flush=True)
            else:
                f.write_bytes(gzip.compress(b"{}"))
                miss += 1
            if (n + miss) % 20 == 0:
                print(d, "files:", n, "no-file days:", miss, flush=True)
            await asyncio.sleep(1.0)
        d += timedelta(days=1)
    print("done:", n, "files,", miss, "days without a file")


if __name__ == "__main__":
    asyncio.run(main())
