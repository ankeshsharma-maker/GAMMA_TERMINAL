"""ITM / ATM / OTM option BUYING on NIFTY and SENSEX -- daily signals, real option prices (NSE / BSE UDiFF bhavcopy).

    python tools/index_itm_backtest.py [--cost 1.5] [--hold 1,2,3,5] [--minvol 200] [--json out.json]

Needs data/idx_opt_hist (tools/fo_index_fetch.py), data/nifty_daily.json, data/sensex_daily.json ([[ts,o,h,l,c], ...]).

Signals (daily candles of the index itself, evaluated at the close; each fires the day it ENTERS):
  breakout week-high / new 52-week high / breakdown week-low / down day >= 1% / up day >= 1%, and the breakouts only in an up-trend
  (close > 50-DMA > 200-DMA of that index).  Bullish -> buy a CALL, bearish -> buy a PUT; "dip" tests buy the call after a down day.
Option: the nearest expiry with >= --dte calendar days left on the signal day (default 3: weekly) -- or --dte 8 for the next one;
strike by % moneyness (ITM 3 / 2 / 1 / 0.5 %, ATM, OTM 0.5 %: the listed strike nearest spot*(1 -+ m)); ENTRY = that contract's OPEN
on the next session (needs >= --minvol traded), EXIT = its settlement price --hold sessions later (intrinsic value if it expired by then --
on the last day NSE / BSE's 'settlement' field holds the INDEX's price); --cost % of the premium off as spread / fees, round trip.
ADVISOR = of ITM 0.5-3 % the liquid strike with the LOWEST time value (% of premium) on the signal day.
CONTROL = the same option bought on random days.
"""
from __future__ import annotations

import bisect
import datetime as dt
import gzip
import json
import random
import statistics as st
import sys
from collections import OrderedDict
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app import scan_backtest as B  # noqa: E402
from app.config import DATA_DIR  # noqa: E402

MONEY = ("ITM3%", "ITM2%", "ITM1%", "ITM0.5%", "ATM", "OTM0.5%", "ADVISOR")
_M = {"ITM3%": 3.0, "ITM2%": 2.0, "ITM1%": 1.0, "ITM0.5%": 0.5, "ATM": 0.0, "OTM0.5%": -0.5}
_cache: OrderedDict = OrderedDict()
DAYS: list[str] = []


def load_day(d: str) -> dict:
    if d in _cache:
        _cache.move_to_end(d)
        return _cache[d]
    f = DATA_DIR / "idx_opt_hist" / f"{d.replace('-', '')}.json.gz"
    data = json.loads(gzip.open(f).read()) if f.exists() else {}
    _cache[d] = data
    if len(_cache) > 30:
        _cache.popitem(last=False)
    return data


def list_days(sym: str) -> list[str]:
    out = []
    for f in sorted((DATA_DIR / "idx_opt_hist").glob("*.json.gz")):
        if f.stat().st_size > 40:
            s = f.name[:8]
            out.append(f"{s[:4]}-{s[4:6]}-{s[6:]}")
    return out


def load_index(name: str) -> B.Stock:
    rows = json.load(open(DATA_DIR / f"{name}_daily.json"))
    cs = [[dt.datetime.fromtimestamp(r[0]).date().isoformat() + "T00:00:00", r[1], r[2], r[3], r[4], 0] for r in reversed(rows)]
    return B.Stock(name.upper(), cs)


def contract(day_data: dict, idx: str, expiry: str, side: str, strike: float):
    ch = day_data.get(idx)
    if not ch or expiry not in ch["e"]:
        return None
    for r in ch["e"][expiry][side]:
        if r[0] == strike:
            return r
    return None


def pick_expiry(chain: dict, day: str, dte: int) -> str | None:
    d0 = date.fromisoformat(day)
    for e in sorted(chain["e"]):
        if (date.fromisoformat(e) - d0).days >= dte:
            return e
    return None


def choose(chain: dict, expiry: str, side: str, spot: float, minvol: int) -> dict:
    rows = chain["e"][expiry][side]
    if len(rows) < 5:
        return {}
    ks = [r[0] for r in rows]
    out = {}
    for lab, m in _M.items():
        target = spot * (1 - m / 100) if side == "C" else spot * (1 + m / 100)
        out[lab] = rows[min(range(len(ks)), key=lambda i: abs(ks[i] - target))]
    best, bv = None, 1e9
    for lab in ("ITM0.5%", "ITM1%", "ITM2%", "ITM3%"):
        r = out[lab]
        if not r or not r[2] or r[2] <= 0 or r[3] < minvol:
            continue
        intrinsic = max(0.0, (spot - r[0]) if side == "C" else (r[0] - spot))
        tv = (r[2] - intrinsic) / r[2] * 100
        if tv < 0:
            continue  # a settlement price below intrinsic value = a stale / thin quote, not a price anyone could trade at
        if tv < bv:
            best, bv = r, tv
    out["ADVISOR"] = best
    return out


def trade(idx: str, t: str, side: str, hold: int, cost: float, minvol: int, dte: int):
    di = bisect.bisect_left(DAYS, t)
    if di >= len(DAYS) or DAYS[di] != t or di + hold + 1 >= len(DAYS):
        return None
    d0, d1, dh = load_day(DAYS[di]), load_day(DAYS[di + 1]), load_day(DAYS[di + hold])
    chain = d0.get(idx)
    if not chain or not chain.get("u"):
        return None
    ex = pick_expiry(chain, t, dte)
    if not ex:
        return None
    spot = chain["u"]
    out = {}
    for label, r in choose(chain, ex, side, spot, minvol).items():
        if not r:
            continue
        k = r[0]
        e1 = contract(d1, idx, ex, side, k)
        if not e1 or not e1[1] or e1[1] <= 0 or e1[3] < minvol:
            continue
        entry, exit_d = e1[1], DAYS[di + hold]
        if exit_d >= ex:
            dj = bisect.bisect_right(DAYS, ex) - 1
            px = (load_day(DAYS[dj]).get(idx) or {}).get("u")
            if not px:
                continue
            val = max(0.0, (px - k) if side == "C" else (k - px))
        else:
            eh = contract(dh, idx, ex, side, k)
            if not eh or eh[2] is None:
                continue
            val = eh[2]
        intr = max(0.0, (spot - k) if side == "C" else (k - spot))
        out[label] = {"ret": (val / entry - 1) * 100 - cost, "tv": (r[2] - intr) / r[2] * 100 if r[2] else None,
                      "itm": ((spot - k) / spot if side == "C" else (k - spot) / spot) * 100}
    return out


def index_move(s: B.Stock, t: str, hold: int, side: str):
    i = bisect.bisect_left(s.d, t)
    if i >= s.n or s.d[i] != t or i + hold >= s.n or i + 1 >= s.n:
        return None
    r = (s.c[i + hold] / s.o[i + 1] - 1) * 100
    return r if side == "C" else -r


def events(s: B.Stock) -> dict[str, list]:
    n = s.n
    up = [False] * n
    sma = lambda arr, k, i: sum(arr[i - k + 1 : i + 1]) / k
    for i in range(200, n):
        up[i] = s.c[i] > sma(s.c, 50, i) > sma(s.c, 200, i)
    wk, _ = B.sig_wk(s, {"side": "UP"})
    wl, _ = B._sig_break(s, {"side": "DOWN"}, lambda d: d.isocalendar()[:2])
    hi, _ = B.sig_w52(s, {"side": "UP"})
    ev: dict[str, list] = {k: [] for k in (
        "week-high breakout (calls)", "week-high breakout, up-trend only (calls)", "new 52-week high (calls)",
        "week-low breakdown (puts)", "down day >= 1% (puts)", "down day >= 1% (calls = buy the dip)", "up day >= 1% (calls)")}
    for i in range(260, n - 8):
        r = (s.c[i] / s.c[i - 1] - 1) * 100
        rp = (s.c[i - 1] / s.c[i - 2] - 1) * 100
        if wk[i] and not wk[i - 1]:
            ev["week-high breakout (calls)"].append((s.d[i], "C"))
            if up[i]:
                ev["week-high breakout, up-trend only (calls)"].append((s.d[i], "C"))
        if hi[i] and not hi[i - 1]:
            ev["new 52-week high (calls)"].append((s.d[i], "C"))
        if wl[i] and not wl[i - 1]:
            ev["week-low breakdown (puts)"].append((s.d[i], "P"))
        if r <= -1 and rp > -1:
            ev["down day >= 1% (puts)"].append((s.d[i], "P"))
            ev["down day >= 1% (calls = buy the dip)"].append((s.d[i], "C"))
        if r >= 1 and rp < 1:
            ev["up day >= 1% (calls)"].append((s.d[i], "C"))
    return ev


def summarize(rows: list[dict]) -> str:
    if not rows:
        return "no trades"
    r = [x["ret"] for x in rows]
    n = len(r)
    tv = [x["tv"] for x in rows if x.get("tv") is not None]
    return (f"n={n:<4} win {sum(1 for x in r if x > 0) / n * 100:4.1f}%  avg {st.mean(r):+6.1f}%  med {st.median(r):+6.1f}%  "
            f"p10 {sorted(r)[int(n * 0.1)]:+6.1f}%  <-50% {sum(1 for x in r if x < -50) / n * 100:3.0f}%  "
            f"time value {st.mean(tv) if tv else 0:4.0f}%  ITM {st.mean(x['itm'] for x in rows):+4.1f}%")


def main() -> None:
    global DAYS
    a = sys.argv[1:]

    def opt(name, default, cast=str):
        if name in a:
            i = a.index(name)
            v = cast(a[i + 1])
            del a[i : i + 2]
            return v
        return default

    cost, minvol, dte = opt("--cost", 1.5, float), opt("--minvol", 200, int), opt("--dte", 3, int)
    holds = [int(x) for x in opt("--hold", "1,2,3,5").split(",")]
    only = opt("--index", "", str)
    out_json = opt("--json", "", str)
    DAYS = list_days("")
    rng = random.Random(5)
    results = {}
    print(f"option history {DAYS[0]} -> {DAYS[-1]} ({len(DAYS)} sessions), cost {cost}% round trip, min volume {minvol}, expiry >= {dte} days away")
    for idx in ("NIFTY", "SENSEX"):
        if only and idx != only:
            continue
        s = load_index(idx.lower())
        ev = events(s)
        print(f"\n################ {idx}")
        for name, evs in ev.items():
            evs = [e for e in evs if DAYS[0] <= e[0] <= DAYS[-1]]
            print(f"\n===== {name}: {len(evs)} signals in range")
            for h in holds:
                per = {m: [] for m in MONEY}
                ctrl = {m: [] for m in MONEY}
                mv = []
                for day, side in evs:
                    m = index_move(s, day, h, side)
                    res = trade(idx, day, side, h, cost, minvol, dte)
                    if m is None or res is None:
                        continue
                    mv.append(m)
                    for lab, x in res.items():
                        per[lab].append(x)
                    for _ in range(2):
                        k = rng.randrange(260, s.n - 10)
                        if DAYS[0] <= s.d[k] <= DAYS[-1]:
                            cr = trade(idx, s.d[k], side, h, cost, minvol, dte)
                            if cr:
                                for lab, x in cr.items():
                                    ctrl[lab].append(x)
                if not mv:
                    continue
                print(f"-- hold {h}: the INDEX moved {st.mean(mv):+.2f}% in the signal's direction (n={len(mv)}, win {sum(1 for x in mv if x > 0) / len(mv) * 100:.0f}%)")
                for lab in MONEY:
                    print(f"   {lab:<8} {summarize(per[lab])}")
                    results[f"{idx}|{name}|{h}|{lab}"] = {"signal": per[lab], "control": ctrl[lab]}
                print(f"   control (random days, ATM) {summarize(ctrl['ATM'])}")
    if out_json:
        Path(out_json).write_text(json.dumps(results), "utf-8")


if __name__ == "__main__":
    main()
