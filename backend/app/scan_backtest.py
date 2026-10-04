"""Did the Scan-tab signals work? Backtest of each signal on daily candles.

For every stock and every day the signal is evaluated from candles up to that day's CLOSE (what an
after-close scan would show). The trade is entered at the NEXT session's open and measured at the
close of the 1st / 3rd / 5th / 10th / 20th session after that. Every signal is compared with the
average of ALL stock-days in the same universe at the same horizon, so a rising market does not
make a "bullish" signal look good -- the number to read is EDGE = signal minus baseline.

* A signal "fires" on the day it ENTERS the scan (true today, false yesterday), not on every day it stays true.
* Per stock and horizon, signals closer together than the horizon are skipped (no double counting).
* Direction +1 = bullish (return counted as is), -1 = bearish (return sign flipped), 0 = no direction
  (the move's SIZE is measured instead, vs the baseline size).
* Costs: 0.10% round trip.
* A window containing a >25% one-day jump (split / bonus not adjusted) is skipped.

Pure Python on pre-downloaded candles (tools/dbr_fetch.py -> a folder of SYM.json, newest first).
"""
from __future__ import annotations

import json
import math
import statistics as st
from datetime import date
from pathlib import Path

HORIZONS = (1, 3, 5, 10, 20)
COST = 0.10  # % round trip
CA_JUMP = 0.25


# ---------------------------------------------------------------- data
class Stock:
    __slots__ = ("sym", "d", "o", "h", "l", "c", "v", "n", "year", "val", "_cache")

    def __init__(self, sym: str, cs: list):
        self.sym = sym
        rows = []
        for x in reversed(cs):  # oldest -> newest
            try:
                o, h, lo, c = (float(x[i]) for i in (1, 2, 3, 4))
                v = float(x[5]) if len(x) > 5 and x[5] is not None else 0.0
            except (TypeError, ValueError):
                continue
            if h < lo or min(o, h, lo, c) <= 0:
                continue
            rows.append((str(x[0])[:10], o, h, lo, c, v))
        self.d = [r[0] for r in rows]
        self.o, self.h, self.l, self.c, self.v = ([r[i] for r in rows] for i in (1, 2, 3, 4, 5))
        self.n = len(rows)
        self.year = [int(x[:4]) for x in self.d]
        self.val = [self.c[i] * self.v[i] for i in range(self.n)]  # traded value, Rs
        self._cache: dict = {}


def load_dir(path: str | Path, min_days: int = 300) -> list[Stock]:
    out = []
    for f in sorted(Path(path).glob("*.json")):
        s = Stock(f.stem, json.loads(f.read_text("utf-8")))
        if s.n >= min_days:
            out.append(s)
    return out


# ---------------------------------------------------------------- signal definitions
# each returns (flags, direction): flags[i] True when the signal is ON at the close of day i;
# direction is +1 / -1 / 0 constant, or a list per day (for signals whose direction depends on the day)
def _roll_mean(a: list[float], n: int, shift: int = 0) -> list[float | None]:
    """mean of a[i-shift-n+1 .. i-shift]."""
    out: list[float | None] = [None] * len(a)
    s = 0.0
    for i, x in enumerate(a):
        s += x
        if i >= n:
            s -= a[i - n]
        j = i + shift
        if i >= n - 1 and j < len(a):
            out[j] = s / n
    return out


def _period_levels(s: Stock, key) -> tuple[list[float | None], list[float | None]]:
    """high / low of the last COMPLETED week / month before each day."""
    ph: list[float | None] = [None] * s.n
    pl: list[float | None] = [None] * s.n
    cur_k = None
    cur_h = cur_l = None
    last_h = last_l = None
    for i in range(s.n):
        k = key(date.fromisoformat(s.d[i]))
        if k != cur_k:
            if cur_k is not None:
                last_h, last_l = cur_h, cur_l
            cur_k, cur_h, cur_l = k, s.h[i], s.l[i]
        else:
            cur_h, cur_l = max(cur_h, s.h[i]), min(cur_l, s.l[i])
        ph[i], pl[i] = last_h, last_l
    return ph, pl


def sig_volbuild(s: Stock, p: dict):
    """5-day average volume vs the 20 sessions before; direction = sign of the 5-day move."""
    k = p.get("min", 1.5)
    v5 = _roll_mean(s.v, 5)
    a20 = _roll_mean(s.v, 20, shift=1)  # the 20 sessions BEFORE day i (ends at i-1)
    flags, dirs = [False] * s.n, [0] * s.n
    for i in range(25, s.n):
        if v5[i] and a20[i] and v5[i] >= k * a20[i]:
            flags[i] = True
            r5 = s.c[i] / s.c[i - 5] - 1
            dirs[i] = 1 if r5 > 0 else -1 if r5 < 0 else 0
    return flags, dirs


def sig_dma(s: Stock, p: dict):
    """above / below all of the 20 / 50 / 200-day averages (of the closes before today), or the 200 alone."""
    pick = p.get("pick", "above3")
    m = {n: _roll_mean(s.c, n, shift=1) for n in (20, 50, 200)}
    flags = [False] * s.n
    for i in range(201, s.n):
        a = [m[n][i] for n in (20, 50, 200)]
        if None in a:
            continue
        up = [s.c[i] > x for x in a]
        flags[i] = {
            "above3": all(up),
            "below3": not any(up),
            "above200": up[2],
            "below200": not up[2],
        }[pick]
    return flags, (1 if pick.startswith("above") else -1)


def _sig_break(s: Stock, p: dict, key):
    side = p.get("side", "UP")
    ph, pl = _period_levels(s, key)
    flags = [False] * s.n
    for i in range(30, s.n):
        if side == "UP":
            flags[i] = ph[i] is not None and s.c[i] > ph[i]
        else:
            flags[i] = pl[i] is not None and s.c[i] < pl[i]
    return flags, (1 if side == "UP" else -1)


def sig_wk(s, p):
    return _sig_break(s, p, lambda d: d.isocalendar()[:2])


def sig_mo(s, p):
    return _sig_break(s, p, lambda d: (d.year, d.month))


def sig_setup(s: Stock, p: dict):
    """NR7 (narrowest range of 7) and / or inside day. No direction."""
    which = p.get("which", "nr7")
    rng = [s.h[i] - s.l[i] for i in range(s.n)]
    flags = [False] * s.n
    for i in range(8, s.n):
        nr7 = rng[i] > 0 and rng[i] < min(rng[i - 6 : i])
        inside = s.h[i] <= s.h[i - 1] and s.l[i] >= s.l[i - 1]
        flags[i] = nr7 if which == "nr7" else inside if which == "inside" else (nr7 and inside)
    return flags, 0


def sig_volbreak(s: Stock, p: dict):
    """Volume tab, daily form: the day's volume >= k x its 20-day average AND the close past yesterday's high (up) / low (down)."""
    k = p.get("min", 2.0)
    side = p.get("side", "UP")
    a20 = _roll_mean(s.v, 20, shift=1)
    flags = [False] * s.n
    for i in range(25, s.n):
        if a20[i] and s.v[i] >= k * a20[i]:
            flags[i] = s.c[i] > s.h[i - 1] if side == "UP" else s.c[i] < s.l[i - 1]
    return flags, (1 if side == "UP" else -1)


def sig_mover(s: Stock, p: dict):
    """Movers tab, daily form: the day's change >= +x% (gainer) or <= -x% (loser)."""
    x = p.get("pct", 3.0)
    side = p.get("side", "UP")
    flags = [False] * s.n
    for i in range(2, s.n):
        r = (s.c[i] / s.c[i - 1] - 1) * 100
        flags[i] = r >= x if side == "UP" else r <= -x
    return flags, (1 if side == "UP" else -1)


def sig_w52(s: Stock, p: dict):
    """52W tab: the day's high went past the 252 sessions' high (or the low past their low)."""
    side = p.get("side", "UP")
    near = float(p.get("near", 0) or 0)  # also count a close within this % of the 52-week extreme (the tab's "near" filter)
    flags = [False] * s.n
    for i in range(253, s.n):
        if side == "UP":
            mx = max(s.h[i - 252 : i])
            flags[i] = s.h[i] > mx or (near > 0 and s.c[i] >= mx * (1 - near / 100))
        else:
            mn = min(s.l[i - 252 : i])
            flags[i] = s.l[i] < mn or (near > 0 and s.c[i] <= mn * (1 + near / 100))
    return flags, (1 if side == "UP" else -1)


def sig_gap(s: Stock, p: dict):
    """Gaps tab: the open vs yesterday's close by >= x%; 'hold' = it did not trade back to that close by the close, 'filled' = it did."""
    x = p.get("pct", 2.0)
    side = p.get("side", "UP")
    state = p.get("state", "any")  # any | hold | filled
    flags = [False] * s.n
    for i in range(2, s.n):
        g = (s.o[i] / s.c[i - 1] - 1) * 100
        if side == "UP" and g >= x:
            filled = s.l[i] <= s.c[i - 1]
        elif side == "DOWN" and g <= -x:
            filled = s.h[i] >= s.c[i - 1]
        else:
            continue
        flags[i] = state == "any" or (state == "hold") == (not filled)
    return flags, (1 if side == "UP" else -1)


SIGNALS = {
    "volbuild": sig_volbuild, "dma": sig_dma, "wk": sig_wk, "mo": sig_mo, "setup": sig_setup,
    "volbreak": sig_volbreak, "mover": sig_mover, "w52": sig_w52, "gap": sig_gap,
}


# ---------------------------------------------------------------- outcomes
def _clean(s: Stock, i: int, last: int) -> bool:
    """No split-like jump between day i-1 and the exit day."""
    c = s._cache.get("jump")
    if c is None:
        c = [False] * s.n
        for k in range(1, s.n):
            c[k] = abs(s.c[k] / s.c[k - 1] - 1) > CA_JUMP
        s._cache["jump"] = c
        s._cache["jumpcum"] = [0] * (s.n + 1)
        for k in range(s.n):
            s._cache["jumpcum"][k + 1] = s._cache["jumpcum"][k] + (1 if c[k] else 0)
    cum = s._cache["jumpcum"]
    return cum[last + 1] - cum[max(i - 1, 0)] == 0


def fwd(s: Stock, i: int, h: int) -> float | None:
    """% return entering at the open of day i+1, exiting at the close of day i+h (cost not yet taken)."""
    j = i + h
    if j >= s.n or not _clean(s, i, j):
        return None
    return (s.c[j] / s.o[i + 1] - 1) * 100


def baseline(stocks: list[Stock], min_val: float, years: set[int] | None = None) -> dict[int, dict]:
    """Average of ALL stock-days (liquid enough) at each horizon: mean return, mean |return|, share up."""
    out = {}
    for h in HORIZONS:
        n = up = 0
        sr = sa = 0.0
        for s in stocks:
            for i in range(30, s.n - h - 1):
                if s.val[i] < min_val or (years and s.year[i] not in years):
                    continue
                r = fwd(s, i, h)
                if r is None:
                    continue
                n += 1
                sr += r
                sa += abs(r)
                up += r > 0
        out[h] = {"n": n, "mean": sr / n if n else 0.0, "abs": sa / n if n else 0.0, "up": up / n if n else 0.0}
    return out


def run(stocks: list[Stock], scan: str, params: dict | None = None, min_val_cr: float = 0.0, base: dict | None = None) -> dict:
    p = params or {}
    min_val = min_val_cr * 1e7
    fn = SIGNALS[scan]
    base = base or baseline(stocks, min_val)
    events: dict[int, list[tuple]] = {h: [] for h in HORIZONS}  # h -> (ret_dir, year, stock, day, direction)
    n_fire = 0
    for s in stocks:
        flags, dirs = fn(s, p)
        last_end = {h: -1 for h in HORIZONS}
        for i in range(30, s.n - 2):
            if not flags[i] or flags[i - 1] or s.val[i] < min_val:
                continue  # only the day it ENTERS the scan, and only a liquid enough stock
            d = dirs[i] if isinstance(dirs, list) else dirs
            n_fire += 1
            for h in HORIZONS:
                if i <= last_end[h]:
                    continue
                r = fwd(s, i, h)
                if r is None:
                    continue
                last_end[h] = i + h
                events[h].append((r, s.year[i], s.sym, s.d[i], d))
    res = {"scan": scan, "params": p, "minValueCr": min_val_cr, "fires": n_fire, "stocks": len(stocks), "horizons": []}
    for h in HORIZONS:
        ev = events[h]
        b = base[h]
        if not ev:
            res["horizons"].append({"h": h, "n": 0})
            continue
        directional = any(e[4] != 0 for e in ev)
        if directional:
            vals = [e[4] * e[0] - COST for e in ev]
            bl = [(-b["mean"] if e[4] < 0 else b["mean"]) - COST for e in ev]
            hit = sum(1 for x in vals if x > 0) / len(vals) * 100
            bhit = (sum((1 - b["up"]) if e[4] < 0 else b["up"] for e in ev) / len(ev)) * 100
        else:  # no direction: how big the move was
            vals = [abs(e[0]) for e in ev]
            bl = [b["abs"]] * len(ev)
            hit = sum(1 for e in ev if e[0] > 0) / len(ev) * 100  # share that ended up
            bhit = b["up"] * 100
        diff = [v - x for v, x in zip(vals, bl)]
        edge = st.mean(diff)
        sd = st.pstdev(vals) if len(vals) > 1 else 0.0
        se = sd / math.sqrt(len(vals)) if sd else 0.0
        # t-score on DAILY averages: many stocks flagged on the same market-wide day count as one observation
        by_day: dict[str, list[float]] = {}
        for dv, e in zip(diff, ev):
            by_day.setdefault(e[3], []).append(dv)
        dm = [st.mean(x) for x in by_day.values()]
        tc = None
        if len(dm) > 2 and st.pstdev(dm):
            tc = st.mean(dm) / (st.pstdev(dm) / math.sqrt(len(dm)))
        by_year = {}
        for y in sorted({e[1] for e in ev}):
            ys = [(v, x) for v, x, e in zip(vals, bl, ev) if e[1] == y]
            by_year[y] = {"n": len(ys), "edge": round(st.mean(v - x for v, x in ys), 3)}
        res["horizons"].append({
            "h": h, "n": len(ev), "days": len({e[3] for e in ev}), "stocks": len({e[2] for e in ev}),
            "avg": round(st.mean(vals), 3), "median": round(st.median(vals), 3), "hit": round(hit, 1),
            "baseAvg": round(st.mean(bl), 3), "baseHit": round(bhit, 1), "edge": round(edge, 3),
            "t": round(edge / se, 2) if se else None, "tc": round(tc, 2) if tc is not None else None, "directional": directional, "byYear": by_year,
        })
    return res


# ---------------------------------------------------------------- service: the app's Backtest button
import asyncio  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402

_LOCK = threading.Lock()
_cache: dict = {"loaded": 0.0, "sig": None, "sets": {}, "base": {}, "res": {}}
TTL = 1800  # keep the candles in memory this long after the last use


def _files_sig(root: Path) -> tuple:
    out = []
    for kind in ("fo", "cash"):
        fs = list((root / kind).glob("*.json")) if (root / kind).exists() else []
        out.append((len(fs), max((f.stat().st_mtime for f in fs), default=0)))
    return tuple(out)


def _load_sets(root: Path) -> dict[str, list[Stock]]:
    """fo / cash / all, today's still-forming candle dropped."""
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone(timedelta(hours=5, minutes=30)))
    live_day = now.date().isoformat() if (now.weekday() < 5 and now.hour * 60 + now.minute < 16 * 60) else None
    sets: dict[str, list[Stock]] = {}
    for kind in ("fo", "cash"):
        out = []
        d = root / kind
        for f in sorted(d.glob("*.json")) if d.exists() else []:
            cs = json.loads(f.read_text("utf-8"))
            if live_day and cs and str(cs[0][0])[:10] == live_day:
                cs = cs[1:]
            s = Stock(f.stem, cs)
            if s.n >= 300:
                out.append(s)
        sets[kind] = out
    sets["all"] = sets["fo"] + sets["cash"]
    return sets


def _run_spec(root: Path, scan: str, params: dict, universe: str, min_cr: float) -> dict:
    with _LOCK:
        sig = _files_sig(root)
        if _cache["sig"] != sig or time.time() - _cache["loaded"] > TTL or not _cache["sets"]:
            _cache.update(sig=sig, sets=_load_sets(root), base={}, res={})
        _cache["loaded"] = time.time()
        stocks = _cache["sets"].get(universe) or []
        if not stocks:
            return {"error": "no candle history for that universe yet"}
        key = json.dumps([scan, params, universe, min_cr], sort_keys=True)
        if key in _cache["res"]:
            return _cache["res"][key]
        bk = (universe, min_cr)
        if bk not in _cache["base"]:
            _cache["base"][bk] = baseline(stocks, min_cr * 1e7)
        res = run(stocks, scan, params, min_cr, _cache["base"][bk])
        res["universe"] = universe
        res["asOf"] = max(s.d[-1] for s in stocks)
        res["from"] = min(s.d[0] for s in stocks)
        _cache["res"][key] = res
        return res


_CHOICES = {"pick": {"above3", "below3", "above200", "below200"}, "side": {"UP", "DOWN"}, "which": {"nr7", "inside", "both"},
            "state": {"any", "hold", "filled"}}
_RANGES = {"min": (0.5, 20.0), "pct": (0.2, 20.0), "near": (0.0, 20.0)}


def clean_params(p: dict | None) -> dict:
    """Only the parameters the signals know, each inside a sane range / list -- the request comes from the browser."""
    out: dict = {}
    for k, v in (p or {}).items():
        if k in _CHOICES and v in _CHOICES[k]:
            out[k] = v
        elif k in _RANGES:
            try:
                lo, hi = _RANGES[k]
                out[k] = min(hi, max(lo, float(v)))
            except (TypeError, ValueError):
                pass
    return out


async def run_spec(root: Path, scan: str, params: dict, universe: str, min_cr: float) -> dict:
    if scan not in SIGNALS:
        return {"error": f"unknown scan {scan!r}"}
    params = clean_params(params)
    if universe not in ("fo", "cash", "all"):
        universe = "fo"
    return await asyncio.to_thread(_run_spec, root, scan, params or {}, universe, max(0.0, float(min_cr or 0)))
