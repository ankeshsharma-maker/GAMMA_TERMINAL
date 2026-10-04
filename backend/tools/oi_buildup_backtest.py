"""Long / short build-up (futures OI) backtest, with the market's trend as a filter.

    python tools/oi_buildup_backtest.py [--min-cr 5] [--json out.json]

Needs: data/daily_candles/fo (stock candles), data/nse_fo_hist (tools/fo_hist_fetch.py), data/nifty_daily.json
([[ts,o,h,l,c], ...] from the server's candle_store). Window = how many sessions the OI / price change is measured over.

Signal (same classification as the Positional tab, app/positional.py): over the last N sessions the stock's
futures OI (all expiries, bonus / split adjusted) changed by >= X%, and the price moved >= 0.25%:
    LONG build-up   OI up,   price up        SHORT build-up   OI up,   price down
    SHORT covering  OI down, price up        LONG unwinding   OI down, price down
It fires on the day it ENTERS the list. Outcome engine = app/scan_backtest.py (entry next open, 1-20 sessions, vs ALL stocks'
average on the same days). Market trend (NIFTY at that day's close): UP = close > 50-DMA > 200-DMA, DOWN = close < 50-DMA < 200-DMA, else MIXED.
"""
from __future__ import annotations

import datetime as dt
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import scan_backtest as B  # noqa: E402
from app.config import DATA_DIR  # noqa: E402


def load_oi() -> tuple[list[str], dict[str, list]]:
    """days (sorted, with data) and per symbol a list aligned to days: [oi, price] after the corporate-action rescale, or None."""
    files = sorted((DATA_DIR / "nse_fo_hist").glob("*.json"))
    days, rows_by_day = [], []
    for f in files:
        d = json.loads(f.read_text("utf-8"))
        if d:
            days.append(f.stem)
            rows_by_day.append(d)
    syms = {s for d in rows_by_day for s in d}
    out = {}
    for sym in syms:
        rows = [d.get(sym) for d in rows_by_day]
        ser = [[r[0], r[1]] if r and r[1] else None for r in rows]
        for i in range(len(rows) - 1, 0, -1):  # same ex-date rescale as positional._adjusted
            new, old = rows[i], rows[i - 1]
            if not new or not old or len(new) < 3 or len(old) < 3:
                continue
            common = [e for e in new[2] if e in old[2]]
            if not common:
                continue
            r = new[2][common[0]][1] / old[2][common[0]][0]
            if abs(r - 1) > 0.02:
                for j in range(i):
                    if ser[j]:
                        ser[j] = [ser[j][0] / r, ser[j][1] * r]
        out[sym] = ser
    return days, out


def market_regimes() -> dict[str, set[str]]:
    rows = json.load(open(DATA_DIR / "nifty_daily.json"))
    d = [dt.datetime.fromtimestamp(r[0]).date().isoformat() for r in rows]
    c = [float(r[4]) for r in rows]
    out = {"UP": set(), "DOWN": set(), "MIXED": set()}
    for i in range(200, len(c)):
        s50 = sum(c[i - 49 : i + 1]) / 50
        s200 = sum(c[i - 199 : i + 1]) / 200
        k = "UP" if c[i] > s50 > s200 else "DOWN" if c[i] < s50 < s200 else "MIXED"
        out[k].add(d[i])
    return out


def make_signal(oi_days: list[str], oi: dict[str, list], kind: str, n: int, x: float):
    didx = {d: i for i, d in enumerate(oi_days)}
    want = {"LONG": (True, True), "SHORT": (True, False), "COVER": (False, True), "UNWIND": (False, False)}[kind]

    def fn(s: B.Stock, p: dict):
        ser = oi.get(s.sym)
        flags = [False] * s.n
        if not ser:
            return flags, 0
        for i in range(s.n):
            j = didx.get(s.d[i].replace("-", ""))
            if j is None or j < n or not ser[j] or not ser[j - n]:
                continue
            oi_l, px_l = ser[j]
            oi_b, px_b = ser[j - n]
            if not oi_b or not px_b:
                continue
            oc, pc = (oi_l / oi_b - 1) * 100, (px_l / px_b - 1) * 100
            if abs(pc) < 0.25:
                continue
            up_oi = oc >= x
            dn_oi = oc <= -x
            if (want[0] and not up_oi) or (not want[0] and not dn_oi):
                continue
            flags[i] = (pc >= 0) == want[1]
        return flags, (1 if want[1] else -1)  # direction: bullish when price is rising (long build-up / short covering)

    return fn


def main() -> None:
    a = sys.argv[1:]
    min_cr = float(a[a.index("--min-cr") + 1]) if "--min-cr" in a else 5.0
    out_json = a[a.index("--json") + 1] if "--json" in a else ""
    stocks = B.load_dir(DATA_DIR / "daily_candles" / "fo")
    oi_days, oi = load_oi()
    reg = market_regimes()
    first, last = oi_days[0], oi_days[-1]
    print(f"{len(stocks)} F&O stocks, OI history {first} -> {last} ({len(oi_days)} sessions), min traded {min_cr} Cr/day")
    lo, hi = f"{first[:4]}-{first[4:6]}-{first[6:]}", f"{last[:4]}-{last[4:6]}-{last[6:]}"
    in_range = {d for s in stocks for d in s.d if lo <= d <= hi}
    reg = {k: v & in_range for k, v in reg.items()}
    print("market days in range:", {k: len(v) for k, v in reg.items()}, "\n")
    sets = {"ALL days": in_range, "market UP": reg["UP"], "market DOWN": reg["DOWN"], "market MIXED": reg["MIXED"]}
    bases = {k: B.baseline(stocks, min_cr * 1e7, None, v) for k, v in sets.items()}
    results = {}
    hdr = f"{'':<26}{'fires':>6} | " + " | ".join(f"{h:>2}d   n     avg   edge    tc" for h in (1, 5, 10))
    for kind, label in (("LONG", "LONG build-up"), ("SHORT", "SHORT build-up"), ("COVER", "short covering"), ("UNWIND", "long unwinding")):
        for n, x in ((1, 5.0), (5, 5.0), (5, 10.0)):
            B.SIGNALS["oi"] = make_signal(oi_days, oi, kind, n, x)
            print(f"== {label}, OI {'+' if kind in ('LONG', 'SHORT') else '-'}{x:g}% over {n} session{'s' if n > 1 else ''}")
            print(hdr)
            for name, dates in sets.items():
                r = B.run(stocks, "oi", {}, min_cr, bases[name], dates)
                results[f"{kind}|{n}|{x}|{name}"] = r
                cells = []
                for hz in r["horizons"]:
                    if hz["h"] in (1, 5, 10):
                        cells.append(f"{hz['n']:>5} {hz.get('avg', 0):+7.2f} {hz.get('edge', 0):+6.2f} {hz.get('tc') or 0:+5.1f}" if hz["n"] else "    -")
                print(f"{name:<26}{r['fires']:>6} | " + " | ".join(cells))
            print()
    if out_json:
        Path(out_json).write_text(json.dumps(results), "utf-8")


if __name__ == "__main__":
    main()
