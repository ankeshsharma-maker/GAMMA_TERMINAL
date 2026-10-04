"""ITM / ATM / OTM option BUYING on the Scan signals -- what do you actually keep after time value and spread?

    python tools/itm_backtest.py [--cost 3] [--hold 5,10] [--minvol 10] [--json out.json]

Needs data/nse_opt_hist (tools/fo_opt_fetch.py: NSE UDiFF stock-option rows, Jul 2024 on), data/daily_candles/fo, data/nifty_daily.json.

For every signal (a stock entering the scan at the close of day t):
  * bullish signal -> buy a CALL, bearish -> buy a PUT;
  * expiry = the nearest one with >= 8 calendar days left on day t; strikes counted from the at-the-money strike (the one nearest the
    day-t close): ITM3 / ITM2 / ITM1 / ATM / OTM1 (a strike is one step of that stock's own strike ladder);
  * ENTRY = the contract's OPEN on day t+1 (skipped if it traded < --minvol contracts), EXIT = its settlement price after --hold sessions
    (or its intrinsic value if it expired first); --cost % of the premium is taken off as spread / slippage / fees, round trip;
  * "ADVISOR" = of ITM1..ITM3 the liquid strike with the LOWEST time value (% of premium) on day t -- the rule the strike-advisor feature would use.
Compared with the stock itself (same entry / exit, direction-adjusted) and with a CONTROL: the same options bought on random days of the same stocks.
"""
from __future__ import annotations

import bisect
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

MONEY = ("ITM3", "ITM2", "ITM1", "ATM", "OTM1", "ADVISOR")
_cache: OrderedDict = OrderedDict()
DAYS: list[str] = []


def load_day(d: str) -> dict:
    if d in _cache:
        _cache.move_to_end(d)
        return _cache[d]
    f = DATA_DIR / "nse_opt_hist" / f"{d.replace('-', '')}.json.gz"
    data = json.loads(gzip.open(f).read()) if f.exists() else {}
    _cache[d] = data
    if len(_cache) > 40:
        _cache.popitem(last=False)
    return data


def list_days() -> list[str]:
    out = []
    for f in sorted((DATA_DIR / "nse_opt_hist").glob("*.json.gz")):
        if f.stat().st_size > 40:  # an empty {} day (holiday) compresses to ~25 bytes
            s = f.name[:8]
            out.append(f"{s[:4]}-{s[4:6]}-{s[6:]}")
    return out


def pick_expiry(chain: dict, day: str) -> str | None:
    d0 = date.fromisoformat(day)
    for e in sorted(chain["e"]):
        if (date.fromisoformat(e) - d0).days >= 8:
            return e
    return None


def contract(day_data: dict, sym: str, expiry: str, side: str, strike: float):
    ch = day_data.get(sym)
    if not ch or expiry not in ch["e"]:
        return None
    for r in ch["e"][expiry][side]:
        if r[0] == strike:
            return r
    return None


def choose(chain: dict, expiry: str, side: str, spot: float, minvol: int) -> dict:
    """strike per moneyness label for a call ('C') or put ('P'), from the day-t chain; None where it isn't there / not liquid."""
    rows = chain["e"][expiry][side]
    ks = [r[0] for r in rows]
    if len(ks) < 7:
        return {}
    atm = min(range(len(ks)), key=lambda i: abs(ks[i] - spot))
    step = -1 if side == "C" else 1  # ITM strikes are below spot for a call, above for a put

    def at(off):
        i = atm + step * off
        return rows[i] if 0 <= i < len(rows) else None

    out = {"ITM3": at(3), "ITM2": at(2), "ITM1": at(1), "ATM": at(0), "OTM1": at(-1)}
    # the advisor: the liquid ITM strike (1-3 steps in) with the lowest time value, as % of the premium
    best, bv = None, 1e9
    for off in (1, 2, 3):
        r = at(off)
        if not r or not r[2] or r[2] <= 0 or r[3] < minvol:
            continue
        intrinsic = max(0.0, (spot - r[0]) if side == "C" else (r[0] - spot))
        tv = (r[2] - intrinsic) / r[2] * 100
        if tv < bv:
            best, bv = r, tv
    out["ADVISOR"] = best
    return out


def trade(sym: str, t: str, side: str, hold: int, cost: float, minvol: int, cs, ti: int):
    """-> {label: dict(ret, tv, itm_pct, ...)} for one signal on day t, or None if the chain isn't usable.
    Prices come from NSE's option file itself (its underlying price is the real one of that day; the candles are split-adjusted)."""
    di = bisect.bisect_left(DAYS, t)
    if di >= len(DAYS) or DAYS[di] != t or di + hold + 1 >= len(DAYS):
        return None
    d0, d1, dh = load_day(DAYS[di]), load_day(DAYS[di + 1]), load_day(DAYS[di + hold])
    chain = d0.get(sym)
    if not chain or not chain.get("u") or not B._clean(cs, ti, min(cs.n - 1, ti + hold)):
        return None
    spot = chain["u"]
    ex = pick_expiry(chain, t)
    if not ex:
        return None
    picks = choose(chain, ex, side, spot, minvol)
    out = {}
    for label, r in picks.items():
        if not r:
            continue
        k = r[0]
        e1 = contract(d1, sym, ex, side, k)
        if not e1 or not e1[1] or e1[1] <= 0 or e1[3] < minvol:
            continue  # didn't open / too thin to have bought
        entry = e1[1]
        exit_d = DAYS[di + hold]
        if exit_d >= ex:  # expired by the exit day (on its last day NSE's 'settlement' field holds the STOCK's price): intrinsic from the underlying
            dj = bisect.bisect_right(DAYS, ex) - 1
            px = (load_day(DAYS[dj]).get(sym) or {}).get("u")
            if not px:
                continue
            val = max(0.0, (px - k) if side == "C" else (k - px))
        else:
            eh = contract(dh, sym, ex, side, k)
            if not eh or eh[2] is None:
                continue
            val = eh[2]
        intr = max(0.0, (spot - k) if side == "C" else (k - spot))
        r1 = e1[2] if e1[2] else entry
        ret = (val / entry - 1) * 100 - cost
        out[label] = {"ret": ret, "tv": (r[2] - intr) / r[2] * 100 if r[2] else None, "itm": ((spot - k) / spot if side == "C" else (k - spot) / spot) * 100,
                      "entry": entry}
    return out


def stock_ret(cs, ti: int, hold: int, side: str) -> float | None:
    j = ti + hold
    if ti + 1 >= cs.n or j >= cs.n:
        return None
    r = (cs.c[j] / cs.o[ti + 1] - 1) * 100
    return r if side == "C" else -r


def events(stocks, market_up: set[str] | None):
    """{set name: [(sym, day, side, stock, index)]} -- bullish and bearish daily signals on F&O stocks."""
    sets = {"52W high + vol>=2x (calls)": [], "week high + vol>=2x (calls)": [], "52W low + vol>=2x (puts)": [], "day -3% or more (puts)": []}
    for s in stocks:
        a20 = B._roll_mean(s.v, 20, shift=1)
        hi, _ = B.sig_w52(s, {"side": "UP"})
        lo, _ = B.sig_w52(s, {"side": "DOWN"})
        wk, _ = B.sig_wk(s, {"side": "UP"})
        for i in range(260, s.n - 25):
            if s.val[i] < 5e7:
                continue
            vol2 = bool(a20[i] and s.v[i] >= 2 * a20[i])
            mu = market_up is None or s.d[i] in market_up
            if hi[i] and not hi[i - 1] and vol2 and mu:
                sets["52W high + vol>=2x (calls)"].append((s.sym, s.d[i], "C", s, i))
            if wk[i] and not wk[i - 1] and vol2 and mu:
                sets["week high + vol>=2x (calls)"].append((s.sym, s.d[i], "C", s, i))
            if lo[i] and not lo[i - 1] and vol2:
                sets["52W low + vol>=2x (puts)"].append((s.sym, s.d[i], "P", s, i))
            if (s.c[i] / s.c[i - 1] - 1) * 100 <= -3 and (s.c[i - 1] / s.c[i - 2] - 1) * 100 > -3:
                sets["day -3% or more (puts)"].append((s.sym, s.d[i], "P", s, i))
    return sets


def summarize(rows: list[dict]) -> str:
    if not rows:
        return "no trades"
    r = [x["ret"] for x in rows]
    n = len(r)
    tv = [x["tv"] for x in rows if x.get("tv") is not None]
    return (f"n={n:<4} win {sum(1 for x in r if x > 0) / n * 100:4.1f}%  avg {st.mean(r):+6.1f}%  med {st.median(r):+6.1f}%  "
            f"p10 {sorted(r)[int(n * 0.1)]:+6.1f}%  <-50% {sum(1 for x in r if x < -50) / n * 100:3.0f}%  "
            f"time value {st.mean(tv) if tv else 0:4.0f}%  in-the-money {st.mean(x['itm'] for x in rows):+4.1f}%")


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

    cost, minvol = opt("--cost", 3.0, float), opt("--minvol", 10, int)
    holds = [int(x) for x in opt("--hold", "5,10").split(",")]
    out_json = opt("--json", "", str)
    DAYS = list_days()
    stocks = B.load_dir(DATA_DIR / "daily_candles" / "fo")
    stocks = [s for s in stocks if any(s.d[-1] >= DAYS[0] for _ in (0,))]
    print(f"{len(stocks)} F&O stocks, option history {DAYS[0]} -> {DAYS[-1]} ({len(DAYS)} sessions), cost {cost}% round trip, min volume {minvol}")
    ev = events(stocks, None)
    rng = random.Random(11)
    results = {}
    for name, evs in ev.items():
        evs = [e for e in evs if DAYS[0] <= e[1] <= DAYS[-1]]
        evs.sort(key=lambda e: e[1])  # locality for the file cache
        print(f"\n===== {name}: {len(evs)} signals in range")
        for h in holds:
            per: dict[str, list] = {m: [] for m in MONEY}
            stock_r, ctrl = [], {m: [] for m in MONEY}
            for sym, t, side, cs, ti in evs:
                sr = stock_ret(cs, ti, h, side)
                res = trade(sym, t, side, h, cost, minvol, cs, ti)
                if res is None or sr is None:
                    continue
                stock_r.append(sr)
                for m, x in res.items():
                    per[m].append(x)
                # control: the same stock, a random other day with the same chain
                for _ in range(2):
                    k = rng.randrange(260, cs.n - 25)
                    if DAYS[0] <= cs.d[k] <= DAYS[-1]:
                        cr = trade(sym, cs.d[k], side, h, cost, minvol, cs, k)
                        if cr:
                            for m, x in cr.items():
                                ctrl[m].append(x)
            print(f"-- hold {h} sessions: the STOCK itself moved {st.mean(stock_r):+.2f}% in the signal's direction (n={len(stock_r)}, win {sum(1 for x in stock_r if x > 0) / len(stock_r) * 100:.0f}%)" if stock_r else f"-- hold {h}: no trades")
            for m in MONEY:
                print(f"   {m:<8} {summarize(per[m])}")
                results[f"{name}|{h}|{m}"] = {"signal": per[m], "control": ctrl[m]}
            c_atm = ctrl["ATM"]
            if c_atm:
                print(f"   control (random days, ATM) {summarize(c_atm)}")
    if out_json:
        Path(out_json).write_text(json.dumps(results), "utf-8")


if __name__ == "__main__":
    main()
