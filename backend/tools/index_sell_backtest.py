"""SELLING weekly NIFTY / SENSEX options: what does a seller keep, and what is the tail?

    python tools/index_sell_backtest.py [--cost 1.5] [--dte 3] [--minvol 200] [--stop 2.0]

Same data as tools/index_itm_backtest.py (data/idx_opt_hist, NSE / BSE UDiFF) and the same conventions: signal day t, nearest expiry with
>= --dte calendar days left, the option is SOLD at its OPEN on day t+1 (needs >= --minvol traded), strike = the listed strike nearest
spot*(1 +- m) for m % out of the money. Two exits:
  * HOLD TO EXPIRY: pay back the intrinsic value on the expiry day (the index's own price that day);
  * STOP: buy it back the first day its settlement price is >= --stop x the sold price (checked on daily settlements, so a
    spike inside the day is not seen -- a real stop is no better), else hold to expiry.
Result = % of the premium kept, after --cost % (spread / fees). Positive = the seller won. Also shown: the share of trades that lost,
the average loss when losing, the 5th-percentile trade, and the worst trade. Put sales are also split by the index's own trend
(close > 50-DMA > 200-DMA = up, close < 50-DMA < 200-DMA = down).
"""
from __future__ import annotations

import bisect
import statistics as st
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import index_itm_backtest as T  # noqa: E402  (same folder: load_day, contract, pick_expiry, ...)
from app import scan_backtest as B  # noqa: E402

OFFS = (0.0, 0.5, 1.0, 1.5, 2.0, 3.0)


def sell(idx: str, t: str, side: str, off: float, cost: float, minvol: int, dte: int, stop: float):
    """-> (ret_hold, ret_stop, stopped) for one sale or None."""
    DAYS = T.DAYS
    di = bisect.bisect_left(DAYS, t)
    if di >= len(DAYS) or DAYS[di] != t or di + 1 >= len(DAYS):
        return None
    d0, d1 = T.load_day(DAYS[di]), T.load_day(DAYS[di + 1])
    chain = d0.get(idx)
    if not chain or not chain.get("u"):
        return None
    ex = T.pick_expiry(chain, t, dte)
    if not ex:
        return None
    spot = chain["u"]
    rows = chain["e"][ex][side]
    if len(rows) < 5:
        return None
    target = spot * (1 + off / 100) if side == "C" else spot * (1 - off / 100)
    k = min((r[0] for r in rows), key=lambda x: abs(x - target))
    e1 = T.contract(d1, idx, ex, side, k)
    if not e1 or not e1[1] or e1[1] <= 0 or e1[3] < minvol:
        return None
    entry = e1[1]
    # the walk from the day after entry to expiry
    j0 = di + 1
    jex = bisect.bisect_right(DAYS, ex) - 1
    if jex <= j0:
        return None  # expired the day it was sold
    ux = (T.load_day(DAYS[jex]).get(idx) or {}).get("u")
    if not ux:
        return None
    val_exp = max(0.0, (ux - k) if side == "C" else (k - ux))
    hold = (entry - val_exp) / entry * 100 - cost
    stopped, ret_stop = False, hold
    for j in range(j0 + 1, jex):  # settlements between entry day and the expiry day
        c = T.contract(T.load_day(DAYS[j]), idx, ex, side, k)
        if c and c[2] is not None and c[2] >= stop * entry:
            ret_stop = (entry - c[2]) / entry * 100 - cost
            stopped = True
            break
    return hold, ret_stop, stopped


def line(rows: list[float], n_stop: int | None = None) -> str:
    if not rows:
        return "no trades"
    n = len(rows)
    losses = [x for x in rows if x < 0]
    s = sorted(rows)
    return (f"n={n:<4} win {sum(1 for x in rows if x > 0) / n * 100:4.0f}%  avg {st.mean(rows):+6.1f}%  med {st.median(rows):+6.1f}%  "
            f"avg loss {st.mean(losses) if losses else 0:+7.1f}%  p5 {s[int(n * 0.05)]:+7.1f}%  worst {s[0]:+8.1f}%"
            + (f"  stopped {n_stop / n * 100:3.0f}%" if n_stop is not None else ""))


def regimes(s: B.Stock) -> dict[str, str]:
    out = {}
    for i in range(200, s.n):
        a50, a200 = sum(s.c[i - 49 : i + 1]) / 50, sum(s.c[i - 199 : i + 1]) / 200
        out[s.d[i]] = "up" if s.c[i] > a50 > a200 else "down" if s.c[i] < a50 < a200 else "mixed"
    return out


def main() -> None:
    a = sys.argv[1:]

    def opt(name, default, cast=float):
        if name in a:
            i = a.index(name)
            v = cast(a[i + 1])
            del a[i : i + 2]
            return v
        return default

    cost, dte, minvol, stop = opt("--cost", 1.5), opt("--dte", 3, int), opt("--minvol", 200, int), opt("--stop", 2.0)
    T.DAYS = T.list_days("")
    print(f"option history {T.DAYS[0]} -> {T.DAYS[-1]} ({len(T.DAYS)} sessions), weekly (expiry >= {dte} days away), cost {cost}%, stop at {stop}x the sold price\n")
    for idx in ("NIFTY", "SENSEX"):
        s = T.load_index(idx.lower())
        reg = regimes(s)
        print(f"################ {idx}")
        for side, name in (("P", "SELL PUTS"), ("C", "SELL CALLS")):
            print(f"\n== {name} (every trading day, held to expiry unless stopped) -- result = % of premium kept")
            for off in OFFS:
                hold, stp, nst = [], [], 0
                by_reg = {"up": [], "down": [], "mixed": []}
                for day in T.DAYS:
                    if not (T.DAYS[0] <= day):
                        continue
                    r = sell(idx, day, side, off, cost, minvol, dte, stop)
                    if r is None:
                        continue
                    hold.append(r[0])
                    stp.append(r[1])
                    nst += r[2]
                    g = reg.get(day)
                    if g:
                        by_reg[g].append(r[0])
                tag = "ATM " if off == 0 else f"{off:g}% OTM"
                print(f"  {tag:<8} hold  {line(hold)}")
                print(f"  {'':<8} stop  {line(stp, nst)}")
                if side == "P":
                    print(f"  {'':<8} hold, index up-trend {line(by_reg['up'])}")
                    print(f"  {'':<8} hold, index down-trend {line(by_reg['down'])}")
                else:
                    print(f"  {'':<8} hold, index up-trend {line(by_reg['up'])}")
                    print(f"  {'':<8} hold, index down-trend {line(by_reg['down'])}")
        print()


if __name__ == "__main__":
    main()
