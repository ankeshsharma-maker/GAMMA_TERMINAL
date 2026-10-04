"""Is the premium rich today (IV rank, IV vs realised volatility), and which entry day / exit rule keeps the most? -- weekly index STRANGLES.

    python tools/iv_entry_exit_study.py [--m 1.5] [--cost 1.5] [--minvol 200]

Data: data/idx_opt_hist (NSE NIFTY / BSE SENSEX option rows per day, tools/fo_index_fetch.py), data/nifty_daily.json, data/sensex_daily.json.

For every weekly expiry E and every entry DTE k (the entry day is k trading days before E): on the day BEFORE entry (the "signal" day t) the strikes are
chosen -- the listed put / call nearest spot*(1 -+ m%) -- and both are SOLD at their OPEN on the entry day (needs >= --minvol traded). The path is the
combined settlement price of the two legs on each later day (the expiry day's value is the intrinsic value: on its last day the exchange's 'settlement'
field holds the index price). Exits tested on the same path:
   expiry    hold to expiry                  tgt50   buy back the first day the strangle is worth <= 50% of the credit (else expiry)
   stop2x    buy back the first day it is worth >= 2x the credit (else expiry)   tgt50+stop2x   whichever comes first
   t+1 / t+2 close after 1 / 2 sessions (or at expiry if sooner)
Result = % of the credit kept after --cost % (spread / fees); also the loss in index points.
Premium richness measured on the signal day t:
   IV   ATM-straddle implied vol of the nearest expiry >= 3 days away  (straddle / (0.8 * spot * sqrt(T)));
   IV rank   where today's IV sits among the previous <= 250 days' (needs >= 100);
   RV20   the index's own 20-day realised vol;  IV - RV20  = how much more the market charges than the index has been moving.
"""
from __future__ import annotations

import bisect
import math
import statistics as st
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import index_itm_backtest as T  # noqa: E402  (load_day, load_index, contract, pick_expiry)

EXITS = ("expiry", "tgt50", "stop2x", "tgt50+stop2x", "t+1", "t+2")


def day_iv(idx: str, day: str) -> float | None:
    chain = T.load_day(day).get(idx)
    if not chain or not chain.get("u"):
        return None
    ex = T.pick_expiry(chain, day, 3)
    if not ex:
        return None
    u = chain["u"]
    cs, ps = chain["e"][ex]["C"], chain["e"][ex]["P"]
    if not cs or not ps:
        return None
    k = min((r[0] for r in cs), key=lambda x: abs(x - u))
    dd = T.load_day(day)
    c, p = T.contract(dd, idx, ex, "C", k), T.contract(dd, idx, ex, "P", k)
    if not c or not p or c[2] is None or p[2] is None or c[2] <= 0 or p[2] <= 0:
        return None
    t_years = max((date.fromisoformat(ex) - date.fromisoformat(day)).days, 1) / 365
    return (c[2] + p[2]) / (0.8 * u * math.sqrt(t_years)) * 100


def realised(closes: list[float], i: int, n: int = 20) -> float | None:
    if i < n:
        return None
    r = [math.log(closes[j] / closes[j - 1]) for j in range(i - n + 1, i + 1)]
    return st.pstdev(r) * math.sqrt(252) * 100


def strangle_path(idx: str, E: str, k: int, m: float, cost: float, minvol: int):
    """-> dict with the credit and the P&L (% of credit, after cost) under every exit rule, or None."""
    DAYS = T.DAYS
    iE = bisect.bisect_left(DAYS, E)
    if iE >= len(DAYS) or DAYS[iE] != E or iE - k - 1 < 0:
        return None
    t, d = DAYS[iE - k - 1], DAYS[iE - k]
    ch = T.load_day(t).get(idx)
    if not ch or E not in ch["e"] or not ch.get("u"):
        return None
    spot = ch["u"]
    cs, ps = ch["e"][E]["C"], ch["e"][E]["P"]
    if len(cs) < 3 or len(ps) < 3:
        return None
    kc = min((r[0] for r in cs), key=lambda x: abs(x - spot * (1 + m / 100)))
    kp = min((r[0] for r in ps), key=lambda x: abs(x - spot * (1 - m / 100)))
    d0 = T.load_day(d)
    c0, p0 = T.contract(d0, idx, E, "C", kc), T.contract(d0, idx, E, "P", kp)
    if not c0 or not p0 or not c0[1] or not p0[1] or c0[3] < minvol or p0[3] < minvol:
        return None
    credit = c0[1] + p0[1]
    uE = (T.load_day(E).get(idx) or {}).get("u")
    if not uE:
        return None
    path = []  # value of the strangle at each settlement from the entry day to the day before expiry, then the expiry value
    last = credit
    for j in range(iE - k, iE):
        dj = T.load_day(DAYS[j])
        cj, pj = T.contract(dj, idx, E, "C", kc), T.contract(dj, idx, E, "P", kp)
        if cj and pj and cj[2] is not None and pj[2] is not None:
            last = cj[2] + pj[2]
        path.append(last)  # a missing print keeps the last known value
    expiry_val = max(0.0, uE - kc) + max(0.0, kp - uE)
    fee = credit * cost / 100

    def res(exit_val: float) -> float:
        return (credit - exit_val - fee) / credit * 100

    out = {}
    out["expiry"] = res(expiry_val)

    def first(cond):
        for v in path:
            if cond(v):
                return v
        return None

    v = first(lambda x: x <= 0.5 * credit)
    out["tgt50"] = res(v if v is not None else expiry_val)
    v = first(lambda x: x >= 2.0 * credit)
    out["stop2x"] = res(v if v is not None else expiry_val)
    ex_val = expiry_val
    for x in path:
        if x <= 0.5 * credit:
            ex_val = x
            break
        if x >= 2.0 * credit:
            ex_val = x
            break
    out["tgt50+stop2x"] = res(ex_val)
    for n, name in ((1, "t+1"), (2, "t+2")):
        out[name] = res(path[n] if n < len(path) else expiry_val)
    out["credit"] = credit
    out["lossPts"] = credit - expiry_val
    out["signalDay"], out["entryDay"], out["spot"] = t, d, spot
    return out


def line(vals: list[float]) -> str:
    if not vals:
        return "no trades"
    s = sorted(vals)
    n = len(vals)
    loss = [x for x in vals if x < 0]
    return (f"n={n:<4} win {sum(1 for x in vals if x > 0) / n * 100:3.0f}%  avg {st.mean(vals):+7.1f}%  med {st.median(vals):+7.1f}%  "
            f"avg loss {st.mean(loss) if loss else 0:+7.1f}%  p5 {s[int(n * 0.05)]:+7.1f}%  worst {s[0]:+8.1f}%")


def main() -> None:
    a = sys.argv[1:]

    def opt(name, default, cast=float):
        if name in a:
            i = a.index(name)
            v = cast(a[i + 1])
            del a[i : i + 2]
            return v
        return default

    m, cost, minvol = opt("--m", 1.5), opt("--cost", 1.5), opt("--minvol", 200, int)
    T.DAYS = T.list_days("")
    DAYS = T.DAYS
    trades = []
    for idx in ("NIFTY", "SENSEX"):
        s = T.load_index(idx.lower())
        # IV series and ranks
        ivs: dict[str, float] = {}
        for d in DAYS:
            v = day_iv(idx, d)
            if v:
                ivs[d] = v
        keys = sorted(ivs)
        rank: dict[str, float] = {}
        for i, d in enumerate(keys):
            hist = [ivs[x] for x in keys[max(0, i - 250) : i]]
            if len(hist) >= 100:
                rank[d] = sum(1 for x in hist if x <= ivs[d]) / len(hist) * 100
        # every expiry seen in the files
        expiries = set()
        for d in DAYS[::5]:
            ch = T.load_day(d).get(idx)
            if ch:
                expiries.update(ch["e"])
        for E in sorted(expiries):
            for k in (5, 4, 3, 2):
                r = strangle_path(idx, E, k, m, cost, minvol)
                if not r:
                    continue
                t = r["signalDay"]
                i = bisect.bisect_left(s.d, t)
                rv = realised(s.c, i) if i < s.n and s.d[i] == t else None
                r.update(idx=idx, E=E, k=k, iv=ivs.get(t), rank=rank.get(t), rv=rv,
                         spread=(ivs[t] - rv) if t in ivs and rv else None)
                trades.append(r)
    import json as _j
    Path(__file__).resolve().parent.parent.parent.joinpath("data", "iv_study_trades.json").write_text(_j.dumps(trades), "utf-8")
    print(f"{len(trades)} strangles (sold at +-{m}% , cost {cost}%) over {DAYS[0]} -> {DAYS[-1]}\n")

    def block(title, sel):
        print(title)
        for ex in EXITS:
            print(f"   {ex:<14}{line([t[ex] for t in sel])}")
        print()

    block("ALL entries", trades)
    print("=" * 100, "\nBY ENTRY DAY (trading days before expiry) -- hold to expiry | target 50% | 50% target + 2x stop")
    for k in (5, 4, 3, 2):
        sel = [t for t in trades if t["k"] == k]
        print(f" {k} sessions before expiry (n={len(sel)})")
        for ex in ("expiry", "tgt50", "tgt50+stop2x"):
            print(f"    {ex:<14}{line([t[ex] for t in sel])}")
    print("\n" + "=" * 100 + "\nBY IV RANK on the signal day (low < 33, mid 33-67, high > 67)")
    ranked = [t for t in trades if t["rank"] is not None]
    for name, lo, hi in (("low rank", 0, 33), ("mid rank", 33, 67), ("high rank", 67, 101)):
        sel = [t for t in ranked if lo <= t["rank"] < hi]
        print(f" {name} (n={len(sel)}, avg IV {st.mean(t['iv'] for t in sel) if sel else 0:.1f}%)")
        for ex in ("expiry", "tgt50", "tgt50+stop2x"):
            print(f"    {ex:<14}{line([t[ex] for t in sel])}")
    print("\n" + "=" * 100 + "\nBY IV - RV20 (how much more the market charges than the index has been moving), thirds")
    sp = sorted(t["spread"] for t in trades if t["spread"] is not None)
    if sp:
        c1, c2 = sp[len(sp) // 3], sp[2 * len(sp) // 3]
        for name, lo, hi in ((f"cheap (spread < {c1:+.1f})", -1e9, c1), (f"middle ({c1:+.1f}..{c2:+.1f})", c1, c2), (f"rich (spread > {c2:+.1f})", c2, 1e9)):
            sel = [t for t in trades if t["spread"] is not None and lo <= t["spread"] < hi]
            print(f" {name} (n={len(sel)})")
            for ex in ("expiry", "tgt50", "tgt50+stop2x"):
                print(f"    {ex:<14}{line([t[ex] for t in sel])}")
    print("\n" + "=" * 100 + "\nBEST COMBINATION: high IV rank AND rich spread")
    both = [t for t in ranked if t["rank"] >= 67 and t["spread"] is not None and sp and t["spread"] > c2]
    block(f" high rank + rich spread (n={len(both)})", both)
    print("\nPER INDEX, hold to expiry vs 50% target, all entries")
    for idx in ("NIFTY", "SENSEX"):
        sel = [t for t in trades if t["idx"] == idx]
        print(f" {idx}: expiry {line([t['expiry'] for t in sel])}")
        print(f" {' ' * len(idx)}  tgt50  {line([t['tgt50'] for t in sel])}")


if __name__ == "__main__":
    main()
