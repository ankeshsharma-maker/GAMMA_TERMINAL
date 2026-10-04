"""Download NSE's daily F&O bhavcopy (UDiFF, available from July 2024) and keep, per day, what the futures
OI build-up needs: stock futures only -> {SYM: [total OI over all expiries, underlying price, {expiry: [close, prev close]}]}
(the same shape app/positional.py uses). One small JSON per trading day in data/nse_fo_hist/YYYYMMDD.json;
holidays are recorded as {} so a re-run skips them. Existing days are skipped, so it can be stopped and resumed.

    python tools/fo_hist_fetch.py [FROM YYYY-MM-DD] [TO YYYY-MM-DD]
"""
from __future__ import annotations

import asyncio
import json
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import positional  # noqa: E402
from app.config import DATA_DIR  # noqa: E402

OUT = DATA_DIR / "nse_fo_hist"


async def main() -> None:
    a = sys.argv[1:]
    d0 = date.fromisoformat(a[0]) if a else date(2024, 7, 8)
    d1 = date.fromisoformat(a[1]) if len(a) > 1 else date.today() - timedelta(days=1)
    OUT.mkdir(parents=True, exist_ok=True)
    d, n, miss = d0, 0, 0
    while d <= d1:
        f = OUT / f"{d.strftime('%Y%m%d')}.json"
        if d.weekday() < 5 and not f.exists():
            raw = await positional._get(f"https://nsearchives.nseindia.com/content/fo/BhavCopy_NSE_FO_0_0_0_{d.strftime('%Y%m%d')}_F_0000.csv.zip")
            if raw:
                try:
                    f.write_text(json.dumps(positional._parse_fo(raw), separators=(",", ":")), "utf-8")
                    n += 1
                except Exception as exc:  # noqa: BLE001
                    print(d, "parse failed:", exc, flush=True)
            else:
                f.write_text("{}", "utf-8")  # holiday / not published
                miss += 1
            if (n + miss) % 20 == 0:
                print(d, "files:", n, "no-file days:", miss, flush=True)
            await asyncio.sleep(1.2)
        d += timedelta(days=1)
    print("done:", n, "files,", miss, "days without a file")


if __name__ == "__main__":
    asyncio.run(main())
