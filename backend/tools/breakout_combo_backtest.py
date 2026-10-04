"""Breakout + volume + market-up, and each piece alone (daily timeframe, 5y candles).

    python tools/breakout_combo_backtest.py [--min-cr 5] [--only fo|cash]

Market UP = NIFTY close > its 50-DMA > its 200-DMA at that day's close (data/nifty_daily.json). The "average stock" baseline for a
market-up run is measured on the market-up days only, so the comparison is fair. Everything else as in app/scan_backtest.py.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import scan_backtest as B  # noqa: E402
from app.config import DATA_DIR  # noqa: E402


def up_days() -> set[str]:
    rows = json.load(open(DATA_DIR / "nifty_daily.json"))
    d = [dt.datetime.fromtimestamp(r[0]).date().isoformat() for r in rows]
    c = [float(r[4]) for r in rows]
    out = set()
    for i in range(200, len(c)):
        if c[i] > sum(c[i - 49 : i + 1]) / 50 > sum(c[i - 199 : i + 1]) / 200:
            out.add(d[i])
    return out


def cell(r, h):
    z = next(x for x in r["horizons"] if x["h"] == h)
    if not z["n"]:
        return "      -"
    flag = "*" if (z.get("tc") is not None and abs(z["tc"]) >= 2 and (z["tc"] > 0) == (z["edge"] > 0)) else " "
    return f"{z['n']:>5} {z['avg']:+6.2f} {z['edge']:+6.2f}{flag}"


def main() -> None:
    a = sys.argv[1:]
    min_cr = float(a[a.index("--min-cr") + 1]) if "--min-cr" in a else 5.0
    only = a[a.index("--only") + 1] if "--only" in a else None
    up = up_days()
    out = {}
    for uni in ("fo", "cash"):
        if only and uni != only:
            continue
        stocks = B.load_dir(DATA_DIR / "daily_candles" / uni)
        alld = {d for s in stocks for d in s.d if d >= "2022-07-20"}  # NIFTY's 200-DMA exists from here
        upd = up & alld
        print(f"\n##### {uni.upper()}: {len(stocks)} stocks, from 2022-07-20, market-UP days {len(upd)} of {len(alld)}, min traded {min_cr} Cr/day")
        bases = {"all": B.baseline(stocks, min_cr * 1e7, None, alld), "up": B.baseline(stocks, min_cr * 1e7, None, upd)}
        print(f"{'':<42}{'fires':>6} |   5d: n   avg   edge  |  10d: n   avg   edge  |  20d: n   avg   edge   (* = reliable)")
        for brk, bl in (("wk", "week high"), ("mo", "month high"), ("w52", "52-week high")):
            for k in (0, 1.5, 2, 3):
                for mk, dates in (("all", alld), ("up", upd)):
                    r = B.run(stocks, "breakvol", {"brk": brk, "min": k}, min_cr, bases[mk], dates)
                    name = f"{bl}{' + vol>=%gx' % k if k else ''}{' + MARKET UP' if mk == 'up' else ''}"
                    out[f"{uni}|{brk}|{k}|{mk}"] = r
                    print(f"{name:<42}{r['fires']:>6} | " + " | ".join(cell(r, h) for h in (5, 10, 20)))
            print()
    Path(DATA_DIR / "breakout_combo_results.json").write_text(json.dumps(out), "utf-8")


if __name__ == "__main__":
    main()
