"""Indicator- and OI-driven auto-trading engine.

Rules are evaluated once per poll cycle (``AutoBot.tick`` is called from the
poller after ``store.check_stops``).  Every rule is a small JSON document:

    {
      "id": "r1",
      "name": "RSI oversold long CE",
      "enabled": true,
      "symbol": "NIFTY",
      "expiry": null,                # null -> front month
      "instrument": "ATM_CE",        # ATM/ITM1/ITM2/OTM1/OTM2 x CE/PE
      "side": "BUY",                 # BUY | SELL the chosen option
      "lots": 1,
      "product": "NRML",            # NRML | MIS
      "mode": "paper",              # paper | live  (live also needs global LIVE + broker)
      "holdType": "intraday",       # intraday (default) | positional
      "entry": [ {condition}, ... ], # ALL must be true to enter (entryLogic "any" = one is enough)
      "exit":  [ {condition}, ... ], # ANY true -> exit (exitLogic "all" = every one; also market conditions,
                                     #   plus trade_stoploss / trade_target: judged on the open trade itself)
      "entryGroups": [ {"logic": "all"}, {"logic": "any"} ],   # optional: MIXED and/or. Each condition then carries
                                     #   "grp": <index>; a group is all-of / any-of its own conditions and entryLogic
                                     #   becomes how the groups combine. Same for exitGroups. See autobot_groups.
      "slPct": 30,                   # stop-loss % on option premium (signed by side)
      "targetPct": 60,              # take-profit % on option premium
      "maxTradesPerDay": 3,
      "cooldownMin": 5,
      "squareOff": "15:20",         # force flat at/after this IST time (intraday only)
      "noEntryAfter": "15:00"       # optional: no new entries at/after this time
    }

Safety fields (all optional; absent or 0 = off). They only ever hold a rule back:
    "maxTradesPerWeek": 4,        # no new entries once this many trades opened this ISO week
    "minDte": 1, "maxDte": 5,     # trade only when the expiry is this many WHOLE days away
                                  #   (0 = expiry day; minDte=maxDte=0 -> expiry day only)
    "maxConsecLosses": 2,         # pause for the rest of today after N losing trades in a row
    "ruleMaxLoss": 5000,          # pause for the rest of today once this rule is down this much
    "maxSpreadPct": 5,            # skip an entry whose bid-ask spread is wider than this % of price
    "maxLotsPerOrder": 20         # split a bigger LIVE order into slices no larger than this
                                  #   (default config.AUTOBOT_MAX_LOTS_PER_ORDER) so no single
                                  #   order can breach the exchange freeze quantity

The exit maths (SL / breakeven / trail / target / scale-out) lives in autobot_exit, shared
with the backtester so the two can't drift. Every entry, exit, error and safety stop also goes
out as an alert (category "autobot"; see alert_delivery), closed trades are kept in a ledger
(`autobot_trades`) for per-rule stats, and each rule carries a `_why` explanation of its last look.

holdType "positional" skips the squareOff / market-close forced exit --
the position rides across day boundaries until SL/target/an exit
condition fires (or the KILL switch), same as a manual carry-forward
trade. SL/target/exit conditions still apply every tick regardless of
market hours, so risk stays bounded; only the automatic same-day
square-off is what positional opts out of. "intraday" (default) is
byte-for-byte the old behaviour.

Condition kinds
---------------
Indicator (computed from the spot series in ``store.history``):
    {"kind":"rsi","period":14,"op":"<"|">"|"cross_up"|"cross_down","value":30}
    {"kind":"ema_cross","fast":9,"slow":21,"dir":"up"|"down"}
    {"kind":"price_vs_ema","period":20,"op":"above"|"below"|"cross_up"|"cross_down"}
    {"kind":"macd","fast":12,"slow":26,"signal":9,"op":"hist_up"|"hist_down"|"cross_up"|"cross_down"}
    {"kind":"spot_move_pct","op":"<"|">","value":0.5}   # % change from the day's first sample
    {"kind":"market_structure","op":"bullish"|"bearish"|"turns_bullish"|"turns_bearish"}  # as the chart's ◇ Patterns

OI / chain:
    {"kind":"pcr","op":"<"|">"|"cross_up"|"cross_down","value":0.9}
    {"kind":"oi_change","leg":"call"|"put","action":"build"|"unwind","minOi":0}
    {"kind":"spot_vs_maxpain","op":"above"|"below","bufferPct":0}
    {"kind":"net_gex","op":"pos"|"neg"|"cross_up"|"cross_down"}

Trend / price action (candles built from store.history on the rule's own
``entryTf`` seconds, same candles the "candle"/"supertrend"/"atr" conditions
already use):
    {"kind":"prev_candle","lookback":0,"field":"open"|"high"|"low"|"close",
     "op":">"|"<"|"cross_up"|"cross_down"}
    # lookback=0 -> the CURRENT, still-forming candle: "open" is fixed for
    # the candle's life, "high"/"low" are its running high/low so far.
    # lookback=1 -> the previous CLOSED candle's O/H/L/C.
    # lookback=N>1 -> a window of the last N closed candles: "high"/"low"
    # become the window's highest-high / lowest-low (Donchian-style range),
    # "open"/"close" are the oldest candle's open / newest candle's close.
    # Classic use: spot crosses above the previous 5m candle's high (breakout).
    # AutoBot.snapshot() exposes the live reference + spot as rule["_live"]
    # for the first prev_candle condition in a rule's active (entry/exit) list.
    {"kind":"gap","aCandle":"current"|"previous","aField":"open"|"high"|"low"|"close",
     "op":">"|"<","bCandle":"current"|"previous","bField":"open"|"high"|"low"|"close"}
    # Compares one candle's O/H/L/C against another's. "current" = this
    # rule's still-forming candle, "previous" = the last CLOSED candle.
    # Defaults (aCandle=current, aField=open, bCandle=previous,
    # bField=close) give the classic gap check: today's open vs the prior
    # candle's close, relative to entryTf not the calendar day (pick a
    # long entryTf for a daily-style gap). Same shape also covers e.g.
    # bullish/bearish candle (aField=close, bCandle=current, bField=open)
    # or higher-high (aField=high, bCandle=previous, bField=high). Both
    # sides are fixed once the current candle opens, so unlike prev_candle
    # there's no live-spot crossing / no cross_up/down.
"""
from __future__ import annotations

import asyncio
import itertools
import logging
import time
from collections import deque
from datetime import datetime, time as dtime
from zoneinfo import ZoneInfo

from . import autobot_exit as X
from . import autobot_groups as G
from . import autobot_structures as ST
from . import charges as chg
from . import config, db
from .autobot_stats import summarize
from .charting import bucket_start
from .screener import iv_rank as _iv_rank_calc
from .store import store

log = logging.getLogger("autobot")
IST = ZoneInfo("Asia/Kolkata")
_MKT_OPEN, _MKT_CLOSE = dtime(9, 15), dtime(15, 30)


def _in_market_hours(now: datetime | None = None) -> bool:
    now = now or datetime.now(IST)
    if now.weekday() >= 5:
        return False
    return _MKT_OPEN <= now.time() <= _MKT_CLOSE


def _parse_hhmm(s: str | None) -> dtime | None:
    try:
        h, m = str(s).split(":")
        return dtime(int(h), int(m))
    except (ValueError, AttributeError):
        return None


# --------------------------------------------------------------------------- #
# indicator maths (no numpy)                                                   #
# --------------------------------------------------------------------------- #
def ema(vals: list[float], period: int) -> list[float]:
    if not vals:
        return []
    k = 2 / (period + 1)
    out = [vals[0]]
    for v in vals[1:]:
        out.append(v * k + out[-1] * (1 - k))
    return out


def rsi(vals: list[float], period: int = 14) -> list[float]:
    if len(vals) < period + 1:
        return []
    gains, losses = [], []
    for i in range(1, len(vals)):
        d = vals[i] - vals[i - 1]
        gains.append(max(d, 0.0))
        losses.append(max(-d, 0.0))
    avg_g = sum(gains[:period]) / period
    avg_l = sum(losses[:period]) / period
    out = [100.0 if avg_l == 0 else 100 - 100 / (1 + avg_g / avg_l)]
    for i in range(period, len(gains)):
        avg_g = (avg_g * (period - 1) + gains[i]) / period
        avg_l = (avg_l * (period - 1) + losses[i]) / period
        out.append(100.0 if avg_l == 0 else 100 - 100 / (1 + avg_g / avg_l))
    return out


def macd_hist(vals: list[float], fast: int, slow: int, signal: int) -> list[float]:
    if len(vals) < slow + signal:
        return []
    ef, es = ema(vals, fast), ema(vals, slow)
    line = [a - b for a, b in zip(ef, es)]
    sig = ema(line, signal)
    return [line[i] - sig[i] for i in range(len(sig))]


def _crossed(a_prev: float, a_cur: float, b_prev: float, b_cur: float, direction: str) -> bool:
    if direction == "up":
        return a_prev <= b_prev and a_cur > b_cur
    return a_prev >= b_prev and a_cur < b_cur


# --------------------------------------------------------------------------- #
# evaluation context                                                           #
# --------------------------------------------------------------------------- #
class _Ctx:
    """Series snapshot for one symbol, derived from ``store.history``."""

    def __init__(self, symbol: str, hist: list | None = None, tf: int = 0, bars: int = 0):
        hist = list(store.history.get(symbol, [])) if hist is None else list(hist)
        self.n = len(hist)
        self.hist = hist
        self.tf = int(tf or 0)
        self.ts = [float(h.get("t") or 0) for h in hist]
        raw_spot = [float(h["spot"]) for h in hist if h.get("spot") is not None]

        # OHLC candle series. tf>0 -> resample the spot snapshots into
        # tf-second candles; otherwise use the row's own OHLC when present
        # (intraday backtest), else a flat 1-point candle per snapshot.
        rows = [
            (
                float(h["t"]), float(h["spot"]),
                float(h.get("o", h["spot"])), float(h.get("h", h["spot"])),
                float(h.get("l", h["spot"])), float(h.get("c", h["spot"])),
            )
            for h in hist
            if h.get("spot") is not None and h.get("t")
        ]
        if self.tf > 0 and rows:
            b: dict[int, dict] = {}
            for t, sp, o, hi, lo, cl in rows:
                k = bucket_start(t, self.tf)
                cur = b.get(k)
                if cur is None:
                    b[k] = {"t": k, "o": o, "h": hi, "l": lo, "c": cl}
                else:
                    cur["h"] = max(cur["h"], hi)
                    cur["l"] = min(cur["l"], lo)
                    cur["c"] = cl
            self.candles = [b[k] for k in sorted(b)]
            self.spot = [cd["c"] for cd in self.candles]
        else:
            self.candles = [
                {"t": t, "o": o, "h": hi, "l": lo, "c": cl}
                for (t, _sp, o, hi, lo, cl) in rows
            ] or [{"t": 0.0, "o": s, "h": s, "l": s, "c": s} for s in raw_spot]
            self.spot = raw_spot
        # entryBars caps only the candle warm-up window (what the UI field is
        # labeled for) -- PCR/GEX/OI/IV series below stay at full history,
        # since several of those conditions already index relative to their
        # own array end (e.g. _maxpain_shift's series[-1-bars]).
        if bars and bars > 0:
            self.candles = self.candles[-bars:]
            self.spot = self.spot[-bars:]
        self.pcr = [float(h["pcr"]) for h in hist if h.get("pcr") is not None]
        self.gex = [float(h["netGex"]) for h in hist if h.get("netGex") is not None]
        self.maxpain = [float(h["maxPain"]) for h in hist if h.get("maxPain")]
        self.gflip = [float(h["gammaFlip"]) for h in hist if h.get("gammaFlip")]
        self.ce_oi_chg = [float(h.get("ceOIChg") or 0) for h in hist]
        self.pe_oi_chg = [float(h.get("peOIChg") or 0) for h in hist]
        self.ce_vol = [float(h.get("ceVol") or 0) for h in hist]
        self.pe_vol = [float(h.get("peVol") or 0) for h in hist]
        self.ce_iv = [float(h["atmCEIV"]) for h in hist if h.get("atmCEIV")]
        self.pe_iv = [float(h["atmPEIV"]) for h in hist if h.get("atmPEIV")]
        self.ce_delta = [float(h["atmCEDelta"]) for h in hist if h.get("atmCEDelta") is not None]
        self.pe_delta = [float(h["atmPEDelta"]) for h in hist if h.get("atmPEDelta") is not None]
        self.ce_gamma = [float(h["atmCEGamma"]) for h in hist if h.get("atmCEGamma") is not None]
        self.pe_gamma = [float(h["atmPEGamma"]) for h in hist if h.get("atmPEGamma") is not None]
        self.ce_theta = [float(h["atmCETheta"]) for h in hist if h.get("atmCETheta") is not None]
        self.pe_theta = [float(h["atmPETheta"]) for h in hist if h.get("atmPETheta") is not None]
        self.ce_vega = [float(h["atmCEVega"]) for h in hist if h.get("atmCEVega") is not None]
        self.pe_vega = [float(h["atmPEVega"]) for h in hist if h.get("atmPEVega") is not None]
        # gamma-blast score -- same engine that powers the blast-warn/blast-crit
        # alerts (scanner.py), sampled independently of `hist` since it's its
        # own history deque already maintained once per poll cycle
        self.blast = [
            float(h["score"]) for h in store.get_scan_history(symbol) if h.get("score") is not None
        ]
        # IV rank -- same screener.iv_rank() the Screener tab's "High IV" preset
        # uses, sampled independently of `hist` from store.iv_history (only
        # populated for symbols the universe scanner walks, poller.py's
        # run_universe_scan -- same coverage gate blast_score above has).
        # Session-only rank (resets each run), not a true 1-year rank -- see
        # screener.py's module docstring. Rolled into a per-sample series (each
        # point's rank against the history up to and including it) so cross_up/
        # cross_down can reuse the plain-series _greek_level below.
        self._iv_series = list(store.iv_history.get(symbol, []))
        self.iv_rank_series: list[float] = []
        for i in range(len(self._iv_series)):
            r, _ = _iv_rank_calc(self._iv_series[: i + 1], self._iv_series[i])
            if r is not None:
                self.iv_rank_series.append(r)

    # -- indicator conditions ------------------------------------------------ #
    def _rsi(self, c) -> bool:
        series = rsi(self.spot, int(c.get("period", 14)))
        if len(series) < 2:
            return False
        cur, prev, v = series[-1], series[-2], float(c.get("value", 30))
        op = c.get("op", "<")
        if op == "<":
            return cur < v
        if op == ">":
            return cur > v
        if op == "cross_up":
            return prev <= v < cur
        if op == "cross_down":
            return prev >= v > cur
        return False

    def _ema_cross(self, c) -> bool:
        f, s = ema(self.spot, int(c.get("fast", 9))), ema(self.spot, int(c.get("slow", 21)))
        if len(f) < 2 or len(s) < 2:
            return False
        return _crossed(f[-2], f[-1], s[-2], s[-1], c.get("dir", "up"))

    def _price_vs_ema(self, c) -> bool:
        e = ema(self.spot, int(c.get("period", 20)))
        if len(e) < 2 or len(self.spot) < 2:
            return False
        op = c.get("op", "above")
        if op == "above":
            return self.spot[-1] > e[-1]
        if op == "below":
            return self.spot[-1] < e[-1]
        return _crossed(self.spot[-2], self.spot[-1], e[-2], e[-1],
                        "up" if op == "cross_up" else "down")

    def _macd(self, c) -> bool:
        h = macd_hist(self.spot, int(c.get("fast", 12)), int(c.get("slow", 26)),
                      int(c.get("signal", 9)))
        if len(h) < 2:
            return False
        op = c.get("op", "cross_up")
        if op == "hist_up":
            return h[-1] > 0
        if op == "hist_down":
            return h[-1] < 0
        if op == "cross_up":
            return h[-2] <= 0 < h[-1]
        if op == "cross_down":
            return h[-2] >= 0 > h[-1]
        return False

    def _spot_move_pct(self, c) -> bool:
        if len(self.spot) < 2 or not self.spot[0]:
            return False
        mv = (self.spot[-1] - self.spot[0]) / self.spot[0] * 100
        v = float(c.get("value", 0.5))
        return mv > v if c.get("op", ">") == ">" else mv < v

    def _time_of_day(self, c) -> bool:
        """The current bar's IST clock time against a window, by `op`:
             between (default)  from <= t <= to        (what this condition always did)
             outside            not between from and to  (skip a window, e.g. lunchtime)
             after              t >= from
             before             t <= to
        Bounds are "HH:MM" and inclusive. A pure time gate -- combines via AND with whatever
        else is in entry/exit, e.g. "RSI < 30 AND time between 09:20-09:45" to only take a
        signal in a specific window. An unknown `op` is False (fails closed)."""
        if not self.ts:
            return False
        now = datetime.fromtimestamp(self.ts[-1], IST).time()
        frm = _parse_hhmm(c.get("from")) or dtime(9, 15)
        to = _parse_hhmm(c.get("to")) or dtime(15, 30)
        op = c.get("op") or "between"
        if op == "after":
            return now >= frm
        if op == "before":
            return now <= to
        if op == "between":
            return frm <= now <= to
        if op == "outside":
            return not (frm <= now <= to)
        return False

    def _day_of_week(self, c) -> bool:
        """True when the current bar's IST weekday is one of `days` (op "is", the default) or is
        not (op "is_not"). `days` is a list of 0..6 with Monday = 0. With no day chosen this is
        False, so a half-configured filter can neither let an entry through nor fire an exit --
        the same fail-closed rule as every other condition."""
        if not self.ts:
            return False
        days = {int(d) for d in (c.get("days") or [])}
        days = {d for d in days if 0 <= d <= 6}
        if not days:
            return False
        inside = datetime.fromtimestamp(self.ts[-1], IST).weekday() in days
        return (not inside) if (c.get("op") or "is") == "is_not" else inside

    # -- OI / chain conditions -------------------------------------------- #
    def _pcr(self, c) -> bool:
        if len(self.pcr) < 2:
            return False
        cur, prev, v = self.pcr[-1], self.pcr[-2], float(c.get("value", 0.9))
        op = c.get("op", ">")
        if op == "<":
            return cur < v
        if op == ">":
            return cur > v
        if op == "cross_up":
            return prev <= v < cur
        if op == "cross_down":
            return prev >= v > cur
        return False

    def _oi_change(self, c) -> bool:
        series = self.ce_oi_chg if c.get("leg", "call") == "call" else self.pe_oi_chg
        if not series:
            return False
        cur = series[-1]
        floor = float(c.get("minOi", 0) or 0)
        if c.get("action", "build") == "build":
            return cur > 0 and abs(cur) >= floor
        return cur < 0 and abs(cur) >= floor

    def _spot_vs_maxpain(self, c) -> bool:
        if not self.spot or not self.maxpain:
            return False
        mp = self.maxpain[-1]
        buf = mp * float(c.get("bufferPct", 0)) / 100
        if c.get("op", "above") == "above":
            return self.spot[-1] > mp + buf
        return self.spot[-1] < mp - buf

    def _net_gex(self, c) -> bool:
        if len(self.gex) < 2:
            return False
        cur, prev = self.gex[-1], self.gex[-2]
        op = c.get("op", "pos")
        if op == "pos":
            return cur > 0
        if op == "neg":
            return cur < 0
        if op == "cross_up":
            return prev <= 0 < cur
        if op == "cross_down":
            return prev >= 0 > cur
        return False

    # -- smart-money / structure conditions ------------------------------ #
    def _structure_trend(self) -> list:
        """Market structure the way the chart's ◇ Patterns draws it (lib/chartPatterns.ts
        `structure`), on CLOSED candles only (the last, still-forming one is left out, like the
        chart): swings from a zig-zag (a bar that is the extreme of the 5 bars each side, legs of
        at least 0.8 x the plain 14-bar ATR); a swing becomes the level to break once confirmed 5
        bars on; a close above the latest swing high -> trend "up", below the latest swing low ->
        "down". Returns the trend after every closed candle (None until the first break)."""
        cs = self.candles[:-1]
        n = len(cs)
        if n < 20:
            return []
        K, MIN_MOVE, N_ATR = 5, 0.8, 14
        tr = [cs[0]["h"] - cs[0]["l"]] + [
            max(cs[i]["h"] - cs[i]["l"], abs(cs[i]["h"] - cs[i - 1]["c"]), abs(cs[i]["l"] - cs[i - 1]["c"]))
            for i in range(1, n)
        ]
        atr, run = [], 0.0
        for i in range(n):
            run += tr[i]
            if i >= N_ATR:
                run -= tr[i - N_ATR]
            atr.append(run / min(i + 1, N_ATR))
        raw = []
        for i in range(K, n - K):
            win = range(i - K, i + K + 1)
            if all(cs[j]["h"] <= cs[i]["h"] for j in win if j != i):
                raw.append((i, cs[i]["h"], True))
            if all(cs[j]["l"] >= cs[i]["l"] for j in win if j != i):
                raw.append((i, cs[i]["l"], False))
        zz: list = []
        for p in raw:
            if not zz:
                zz.append(p)
            elif zz[-1][2] == p[2]:
                if (p[2] and p[1] >= zz[-1][1]) or (not p[2] and p[1] <= zz[-1][1]):
                    zz[-1] = p  # same side again: keep the more extreme one
            elif abs(p[1] - zz[-1][1]) >= MIN_MOVE * atr[p[0]]:
                zz.append(p)
        trend, act_h, act_l, z, out = None, None, None, 0, []
        for j in range(n):
            while z < len(zz) and zz[z][0] + K <= j:
                if zz[z][2]:
                    act_h = zz[z]
                else:
                    act_l = zz[z]
                z += 1
            if act_h and cs[j]["c"] > act_h[1]:
                trend, act_h = "up", None
            elif act_l and cs[j]["c"] < act_l[1]:
                trend, act_l = "down", None
            out.append(trend)
        return out

    def _market_structure(self, c) -> bool:
        """op: bullish / bearish = the last structure break was up / down (HH-HL side vs LH-LL side);
        turns_bullish / turns_bearish = that flip happened on the last closed candle (a CHoCH, or
        the very first break)."""
        tr = self._structure_trend()
        if len(tr) < 2:
            return False
        op = str(c.get("op", "bullish"))
        if op == "bullish":
            return tr[-1] == "up"
        if op == "bearish":
            return tr[-1] == "down"
        if op == "turns_bullish":
            return tr[-1] == "up" and tr[-2] != "up"
        if op == "turns_bearish":
            return tr[-1] == "down" and tr[-2] != "down"
        return False

    def _bos(self, c) -> bool:
        """Break of structure: spot takes out the prior N-bar swing high/low."""
        lb = int(c.get("lookback", 20))
        if len(self.spot) < lb + 2:
            return False
        window = self.spot[-lb - 1 : -1]
        if c.get("dir", "up") == "up":
            return self.spot[-1] > max(window)
        return self.spot[-1] < min(window)

    def _opening_range(self, c) -> bool:
        """Break of the high/low set in the first `rangeMin` minutes of the session."""
        rng = float(c.get("rangeMin", 15))
        if not self.ts or not self.hist:
            return False
        today = datetime.fromtimestamp(self.ts[-1], IST).date()
        day = [
            h for h in self.hist
            if h.get("t") and datetime.fromtimestamp(h["t"], IST).date() == today
            and h.get("spot") is not None
        ]
        if len(day) < 3:
            return False
        t0 = day[0]["t"]
        opening = [h["spot"] for h in day if h["t"] - t0 <= rng * 60]
        later = [h["spot"] for h in day if h["t"] - t0 > rng * 60]
        if len(opening) < 2 or not later:
            return False
        hi, lo, last = max(opening), min(opening), day[-1]["spot"]
        return last > hi if c.get("dir", "up") == "up" else last < lo

    @staticmethod
    def _surge(series: list[float], bars: int, mult: float) -> bool:
        """|Δseries over last `bars`| exceeds `mult` x the median |per-bar Δ|."""
        if len(series) < bars + 5:
            return False
        deltas = [abs(series[i] - series[i - 1]) for i in range(1, len(series))]
        med = sorted(deltas)[len(deltas) // 2] or 1.0
        recent = abs(series[-1] - series[-1 - bars])
        return recent >= mult * med and series[-1] != series[-1 - bars]

    def _oi_velocity(self, c) -> bool:
        s = self.ce_oi_chg if c.get("leg", "call") == "call" else self.pe_oi_chg
        if not self._surge(s, int(c.get("bars", 3)), float(c.get("mult", 2.0))):
            return False
        rising = s[-1] > s[-1 - int(c.get("bars", 3))]
        want = c.get("action", "build")
        return rising if want == "build" else not rising

    def _vol_surge(self, c) -> bool:
        s = self.ce_vol if c.get("leg", "call") == "call" else self.pe_vol
        return self._surge(s, int(c.get("bars", 3)), float(c.get("mult", 2.0)))

    def _oi_divergence(self, c) -> bool:
        """Price/OI divergence: new extreme in price while positioning fades it."""
        n = int(c.get("lookback", 10))
        if len(self.spot) < n + 2 or len(self.ce_oi_chg) < 3:
            return False
        d_ce = self.ce_oi_chg[-1] - self.ce_oi_chg[-3]
        d_pe = self.pe_oi_chg[-1] - self.pe_oi_chg[-3]
        if c.get("dir", "bearish") == "bearish":
            new_high = self.spot[-1] >= max(self.spot[-n:])
            return new_high and d_ce > 0 and d_ce > d_pe  # call writing into strength
        new_low = self.spot[-1] <= min(self.spot[-n:])
        return new_low and d_pe > 0 and d_pe > d_ce  # put writing into weakness

    def _maxpain_shift(self, c) -> bool:
        bars = int(c.get("bars", 10))
        if len(self.maxpain) < bars + 1:
            return False
        delta = self.maxpain[-1] - self.maxpain[-1 - bars]
        pts = float(c.get("minPts", 0) or 0)
        if c.get("dir", "up") == "up":
            return delta > 0 and delta >= pts
        return delta < 0 and abs(delta) >= pts

    def _pcr_roc(self, c) -> bool:
        bars = int(c.get("bars", 5))
        if len(self.pcr) < bars + 1:
            return False
        roc = self.pcr[-1] - self.pcr[-1 - bars]
        v = float(c.get("value", 0.1))
        return roc > v if c.get("op", ">") == ">" else roc < -abs(v)

    def _iv_skew(self, c) -> bool:
        if len(self.pe_iv) < 2 or len(self.ce_iv) < 2:
            return False
        skew_now = self.pe_iv[-1] - self.ce_iv[-1]
        skew_prev = self.pe_iv[-2] - self.ce_iv[-2]
        op = c.get("op", "put_rich")
        if op == "put_rich":
            return skew_now > float(c.get("value", 0))
        if op == "call_rich":
            return skew_now < -float(c.get("value", 0))
        if op == "put_rising":
            return skew_now > skew_prev
        if op == "call_rising":
            return skew_now < skew_prev
        return False

    def _gamma_flip(self, c) -> bool:
        if len(self.gflip) < 2 or len(self.spot) < 2:
            return False
        op = c.get("op", "below")
        cur_above = self.spot[-1] > self.gflip[-1]
        prev_above = self.spot[-2] > self.gflip[-2]
        if op == "above":
            return cur_above
        if op == "below":
            return not cur_above
        if op == "cross_up":
            return cur_above and not prev_above
        if op == "cross_down":
            return not cur_above and prev_above
        return False

    # -- extra structure / greek / trend conditions -------------------- #
    def _oi_state(self, c) -> bool:
        """Long/Short buildup / unwinding / covering over the last `bars`,
        from spot direction + net (call+put) OI-change direction."""
        bars = int(c.get("bars", 5))
        if len(self.spot) < bars + 1 or len(self.ce_oi_chg) < 1:
            return False
        d_price = self.spot[-1] - self.spot[-1 - bars]
        d_oi = self.ce_oi_chg[-1] + self.pe_oi_chg[-1]  # net OI added today
        up_p, up_oi = d_price >= 0, d_oi >= 0
        state = (
            "LONG_BUILDUP" if up_p and up_oi
            else "SHORT_BUILDUP" if not up_p and up_oi
            else "LONG_UNWINDING" if not up_p and not up_oi
            else "SHORT_COVERING"
        )
        return state == str(c.get("state", "LONG_BUILDUP")).upper()

    def _atr_series(self, period: int) -> list[float]:
        """Wilder ATR over the candle OHLC series."""
        cs = self.candles
        if len(cs) < period + 1:
            return []
        trs = []
        for i in range(1, len(cs)):
            h, l, pc = cs[i]["h"], cs[i]["l"], cs[i - 1]["c"]
            trs.append(max(h - l, abs(h - pc), abs(l - pc)))
        if len(trs) < period:
            return []
        atr = sum(trs[:period]) / period
        out = [atr]
        for tr in trs[period:]:
            atr = (atr * (period - 1) + tr) / period
            out.append(atr)
        return out

    def _atr(self, c) -> bool:
        period = int(c.get("period", 14))
        s = self._atr_series(period)
        if len(s) < 2:
            return False
        cur, prev = s[-1], s[-2]
        op = c.get("op", ">")
        v = float(c.get("value", 0) or 0)
        if str(c.get("unit", "pts")).lower() == "pct" and self.spot:
            v = self.spot[-1] * v / 100.0
        if op == "rising":
            return cur > prev
        if op == "falling":
            return cur < prev
        if op == "<":
            return cur < v
        return cur > v  # ">"

    def _supertrend(self, c) -> bool:
        """True ATR-based Supertrend on the candle series.
        dir 'up' -> price is above the Supertrend line (uptrend);
        op 'flip' -> the trend just flipped to `dir` on the last candle."""
        period = int(c.get("period", 10))
        mult = float(c.get("mult", 3.0))
        cs = self.candles
        atr = self._atr_series(period)
        if len(atr) < 2 or len(cs) < period + 2:
            return False
        # align ATR to candles (atr[0] corresponds to cs[period])
        flips: list[bool] = []
        up = True
        fub = flb = None
        for j, a in enumerate(atr):
            i = period + j
            mid = (cs[i]["h"] + cs[i]["l"]) / 2
            bub, blb = mid + mult * a, mid - mult * a
            fub = bub if fub is None or bub < fub or cs[i - 1]["c"] > fub else fub
            flb = blb if flb is None or blb > flb or cs[i - 1]["c"] < flb else flb
            if cs[i]["c"] > (fub if not up else flb) and not up:
                up = True
            elif cs[i]["c"] < (flb if up else fub) and up:
                up = False
            flips.append(up)
        if len(flips) < 2:
            return False
        want_up = c.get("dir", "up") == "up"
        if c.get("op", "is") == "flip":
            return flips[-1] != flips[-2] and flips[-1] == want_up
        return flips[-1] == want_up

    def _candle_streak(self, c) -> bool:
        """N consecutive candles (this rule's own timeframe) all closing the
        same direction -- a momentum/consistency check, distinct from any
        single pattern in _candle below."""
        n = max(1, int(c.get("count", 3)))
        cs = self.candles
        if len(cs) < n:
            return False
        want_up = c.get("dir", "up") == "up"
        return all((cd["c"] > cd["o"]) == want_up for cd in cs[-n:])

    def _candle_range(self, c) -> bool:
        """The CURRENT candle's high-low range vs the average range of the
        preceding `bars` candles -- an immediate breakout (wide) or squeeze
        (narrow) read. Distinct from ATR (_atr below), which smooths over
        many bars rather than singling out how today's candle compares to
        its own recent past."""
        bars = max(2, int(c.get("bars", 10)))
        cs = self.candles
        if len(cs) < bars + 1:
            return False
        cur_range = cs[-1]["h"] - cs[-1]["l"]
        prev = cs[-1 - bars : -1]
        avg_range = sum(cd["h"] - cd["l"] for cd in prev) / len(prev)
        if avg_range <= 0:
            return False
        mult = float(c.get("mult", 1.5))
        ratio = cur_range / avg_range
        return ratio >= mult if c.get("mode", "wide") == "wide" else ratio <= 1.0 / mult

    def _candle(self, c) -> bool:
        """Single / two-candle candlestick pattern on the current timeframe."""
        cs = self.candles
        if len(cs) < 2:
            return False
        a, b = cs[-2], cs[-1]
        pat = str(c.get("pattern", "bull_engulf")).lower()
        rng = (b["h"] - b["l"]) or 1e-9
        body = abs(b["c"] - b["o"])
        upper = b["h"] - max(b["c"], b["o"])
        lower = min(b["c"], b["o"]) - b["l"]
        bull = b["c"] > b["o"]
        pbull = a["c"] > a["o"]
        if pat == "bull_engulf":
            return bull and not pbull and b["c"] >= a["o"] and b["o"] <= a["c"]
        if pat == "bear_engulf":
            return (not bull) and pbull and b["o"] >= a["c"] and b["c"] <= a["o"]
        if pat == "hammer":
            return lower >= 2 * body and upper <= body and body / rng < 0.4
        if pat == "shooting_star":
            return upper >= 2 * body and lower <= body and body / rng < 0.4
        if pat == "doji":
            return body / rng <= 0.1
        if pat == "inside":
            return b["h"] <= a["h"] and b["l"] >= a["l"]
        if pat == "outside":
            return b["h"] >= a["h"] and b["l"] <= a["l"]
        if pat == "marubozu_bull":
            return bull and upper / rng < 0.06 and lower / rng < 0.06
        if pat == "marubozu_bear":
            return (not bull) and upper / rng < 0.06 and lower / rng < 0.06
        return False

    def _prev_candle_ref(self, c) -> tuple[float, float] | None:
        """(reference price, current spot) for a prev_candle condition, or
        None if there isn't enough candle history yet.

        `lookback` N candles back, on this rule's own timeframe (self.tf):
        N=0 -> the CURRENT, still-forming candle: "open" is that candle's
        (fixed) open, "high"/"low" are its running high/low so far, "close"
        is just the current price (comparing spot to itself -- pick a
        different field for a meaningful N=0 condition).
        N=1 -> that single closed candle's open/high/low/close.
        N>1 -> a window of the last N closed candles; "high"/"low" become the
        window's highest-high / lowest-low (Donchian-style range), "open" is
        the oldest candle's open, "close" is the most-recently-closed candle's
        close. The formulas below reduce to the N=1 case automatically."""
        cs = self.candles
        n = max(0, int(c.get("lookback", 1)))
        field = str(c.get("field", "high")).lower()
        if n == 0:
            if not cs or len(self.spot) < 2:
                return None
            cur = cs[-1]
            if field == "open":
                ref = cur["o"]
            elif field == "close":
                ref = cur["c"]
            elif field == "low":
                ref = cur["l"]
            else:
                ref = cur["h"]
            return float(ref), self.spot[-1]
        if len(cs) < n + 2 or len(self.spot) < 2:
            return None
        window = cs[-1 - n : -1]  # last n CLOSED candles, oldest -> newest
        if len(window) < n:
            return None
        if field == "open":
            ref = window[0]["o"]
        elif field == "close":
            ref = window[-1]["c"]
        elif field == "low":
            ref = min(cd["l"] for cd in window)
        else:
            ref = max(cd["h"] for cd in window)
        return float(ref), self.spot[-1]

    def _prev_candle(self, c) -> bool:
        """Current price vs. a previous candle (or N-candle range) on this
        rule's candle timeframe -- classic breakout/breakdown condition."""
        got = self._prev_candle_ref(c)
        if got is None:
            return False
        ref, cur = got
        prev = self.spot[-2]
        op = c.get("op", "cross_up")
        if op == ">":
            return cur > ref
        if op == "<":
            return cur < ref
        if op == "cross_up":
            return prev <= ref < cur
        if op == "cross_down":
            return prev >= ref > cur
        return False

    def _gap_val(self, which, field) -> float:
        cs = self.candles
        cd = cs[-1] if str(which).lower() == "current" else cs[-2]
        field = str(field).lower()
        if field == "high":
            return float(cd["h"])
        if field == "low":
            return float(cd["l"])
        if field == "close":
            return float(cd["c"])
        return float(cd["o"])

    def _gap(self, c) -> bool:
        """One candle's O/H/L/C vs. another's -- e.g. current open vs.
        previous close (classic gap), current close vs. current open
        (bullish/bearish candle), current high vs. previous high, etc.
        "current" = this rule's still-forming candle, "previous" = the
        last CLOSED candle. Fixed once the current candle opens (both
        sides are static), so op is just >/< ."""
        cs = self.candles
        if len(cs) < 2:
            return False
        a = self._gap_val(c.get("aCandle", "current"), c.get("aField", "open"))
        b = self._gap_val(c.get("bCandle", "previous"), c.get("bField", "close"))
        op = c.get("op", ">")
        if op == ">":
            return a > b
        if op == "<":
            return a < b
        return False

    def prev_candle_live(self, conds: list) -> dict | None:
        """Live readout for the UI: the first prev_candle condition's current
        reference price + spot, so a rule card can show what it's tracking."""
        for c in conds or []:
            if (c or {}).get("kind") != "prev_candle":
                continue
            got = self._prev_candle_ref(c)
            if got is None:
                return None
            ref, cur = got
            return {
                "field": str(c.get("field", "high")).lower(),
                "lookback": max(0, int(c.get("lookback", 1))),
                "tf": self.tf,
                "ref": round(ref, 2),
                "spot": round(cur, 2),
            }
        return None

    def _day_ohlc(self, back: int = 1):
        """(high, low, close) of the session `back` days ago from spot snaps."""
        if not self.hist:
            return None
        by_day: dict = {}
        for h in self.hist:
            t, sp = h.get("t"), h.get("spot")
            if not t or sp is None:
                continue
            d = datetime.fromtimestamp(t, IST).date()
            by_day.setdefault(d, []).append(float(sp))
        days = sorted(by_day)
        if len(days) < back + 1:
            return None
        vals = by_day[days[-1 - back]]
        return max(vals), min(vals), vals[-1]

    def _pivot(self, c) -> bool:
        o = self._day_ohlc(1)
        if not o or len(self.spot) < 2:
            return False
        hi, lo, cl = o
        p = (hi + lo + cl) / 3
        levels = {
            "P": p,
            "R1": 2 * p - lo, "S1": 2 * p - hi,
            "R2": p + (hi - lo), "S2": p - (hi - lo),
            "R3": hi + 2 * (p - lo), "S3": lo - 2 * (hi - p),
        }
        lvl = levels.get(str(c.get("level", "P")).upper())
        if lvl is None:
            return False
        cur, prev, op = self.spot[-1], self.spot[-2], c.get("op", "above")
        if op == "above":
            return cur > lvl
        if op == "below":
            return cur < lvl
        if op == "cross_up":
            return prev <= lvl < cur
        if op == "cross_down":
            return prev >= lvl > cur
        return False

    def _greek_change(self, c, series: list[float]) -> bool:
        bars = int(c.get("bars", 5))
        if len(series) < bars + 1:
            return False
        d = series[-1] - series[-1 - bars]
        v = float(c.get("value", 0))
        op = c.get("op", ">")
        return d > v if op == ">" else d < -abs(v) if op == "<" else abs(d) >= abs(v)

    def _delta_change(self, c) -> bool:
        s = self.ce_delta if c.get("leg", "call") == "call" else self.pe_delta
        return self._greek_change(c, s)

    def _gamma_change(self, c) -> bool:
        s = self.ce_gamma if c.get("leg", "call") == "call" else self.pe_gamma
        return self._greek_change(c, s)

    def _gamma_vs_delta(self, c) -> bool:
        """Is gamma growing faster than delta (or slower)? Both are compared as a % change over the
        last `bars` readings -- their raw sizes differ ~100x (gamma ~0.001, delta ~0.5), so raw
        changes can't be compared. Delta is taken by SIZE (|delta|), so a put's delta (negative)
        counts as growing when it moves further from zero, the same way a call's does.

            op "gamma_faster":  gamma %chg - delta %chg  >  value   (percentage points)
            op "delta_faster":  delta %chg - gamma %chg  >  value

        A "reading" is one recorded history sample (about one per refresh), not a candle of the
        rule's timeframe -- the same unit delta_change / gamma_change use. False until there are
        bars+1 readings, or when either starting value is too small to take a % of."""
        call = c.get("leg", "call") == "call"
        dl = self.ce_delta if call else self.pe_delta
        gm = self.ce_gamma if call else self.pe_gamma
        bars = max(1, int(c.get("bars", 5)))
        if len(dl) < bars + 1 or len(gm) < bars + 1:
            return False
        d_then, g_then = abs(dl[-1 - bars]), gm[-1 - bars]
        if d_then < 0.05 or g_then < 1e-6:
            return False
        d_pct = (abs(dl[-1]) - d_then) / d_then * 100.0
        g_pct = (gm[-1] - g_then) / g_then * 100.0
        margin = abs(float(c.get("value", 5)))
        op = c.get("op", "gamma_faster")
        if op == "gamma_faster":
            return g_pct - d_pct > margin
        if op == "delta_faster":
            return d_pct - g_pct > margin
        return False

    def _greek_level(self, c, series: list[float]) -> bool:
        if len(series) < 2:
            return False
        cur, prev, v = series[-1], series[-2], float(c.get("value", 0))
        op = c.get("op", ">")
        if op == "<":
            return cur < v
        if op == ">":
            return cur > v
        if op == "cross_up":
            return prev <= v < cur
        if op == "cross_down":
            return prev >= v > cur
        return False

    def _theta_level(self, c) -> bool:
        s = self.ce_theta if c.get("leg", "call") == "call" else self.pe_theta
        return self._greek_level(c, s)

    def _vega_level(self, c) -> bool:
        s = self.ce_vega if c.get("leg", "call") == "call" else self.pe_vega
        return self._greek_level(c, s)

    def _blast_score(self, c) -> bool:
        return self._greek_level(c, self.blast)

    def _iv_rank(self, c) -> bool:
        return self._greek_level(c, self.iv_rank_series)

    _DISPATCH = {
        "rsi": _rsi, "ema_cross": _ema_cross, "price_vs_ema": _price_vs_ema,
        "macd": _macd, "spot_move_pct": _spot_move_pct, "pcr": _pcr,
        "oi_change": _oi_change, "spot_vs_maxpain": _spot_vs_maxpain, "net_gex": _net_gex,
        "bos": _bos, "market_structure": _market_structure, "opening_range": _opening_range, "oi_velocity": _oi_velocity,
        "vol_surge": _vol_surge, "oi_divergence": _oi_divergence,
        "maxpain_shift": _maxpain_shift, "pcr_roc": _pcr_roc, "iv_skew": _iv_skew,
        "gamma_flip": _gamma_flip,
        "oi_state": _oi_state, "supertrend": _supertrend, "pivot": _pivot,
        "delta_change": _delta_change, "gamma_change": _gamma_change, "gamma_vs_delta": _gamma_vs_delta,
        "theta_level": _theta_level, "vega_level": _vega_level, "blast_score": _blast_score,
        "iv_rank": _iv_rank,
        "candle": _candle, "atr": _atr, "prev_candle": _prev_candle, "gap": _gap,
        "candle_streak": _candle_streak, "candle_range": _candle_range,
        "time_of_day": _time_of_day, "day_of_week": _day_of_week,
    }

    def eval_one(self, cond: dict, trade: dict | None = None) -> bool:
        """One condition. `trade` is the OPEN position ({buy, base, ltp, qty}) when an Exit list is
        being judged; only the trade_stoploss / trade_target kinds read it, and they are False without
        one. It is passed in rather than stored on the context because contexts are shared between
        rules on the same symbol within a tick."""
        kind = (cond or {}).get("kind", "")
        try:
            if kind in X.TRADE_KINDS:
                return bool(X.trade_condition(cond, trade))
            fn = self._DISPATCH.get(kind)
            if not fn:
                return False
            return bool(fn(self, cond))
        except Exception as exc:  # noqa: BLE001
            log.debug("condition %s failed: %s", cond, exc)
            return False

    def eval_all(self, conds: list, trade: dict | None = None) -> bool:
        conds = conds or []
        return bool(conds) and all(self.eval_one(c, trade) for c in conds)

    def eval_any(self, conds: list, trade: dict | None = None) -> bool:
        return any(self.eval_one(c, trade) for c in (conds or []))

    def eval_conds(self, conds: list, logic: str = "all", trade: dict | None = None, groups: list[str] | None = None) -> bool:
        """AND ('all') or OR ('any') over the condition list -- or, when `groups` is given, over each group first
        and then over the groups (see autobot_groups)."""
        return G.evaluate(conds, groups, (logic or "all"), lambda i: self.eval_one(conds[i], trade))


# --------------------------------------------------------------------------- #
# instrument resolution                                                        #
# --------------------------------------------------------------------------- #
def _entry_filter_ok(
    ef: dict, premium: float, delta: float, prem_chg: float, prem_chg_pct: float
) -> tuple[bool, str]:
    """Flexible premium/delta gate applied to the *resolved* option before entry.

    ef keys (all optional):
      premOp   : 'gt' | 'lt' | 'near'      + premVal (+ premTol for 'near')
      premPctMin / premPctMax   : today's premium % change band
      premPtsMin / premPtsMax   : today's premium points change band
      deltaMin / deltaMax       : |delta| band
    """
    if not ef:
        return True, ""

    def _f(k):
        v = ef.get(k)
        try:
            return float(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None

    op = (ef.get("premOp") or "").lower()
    pv = _f("premVal")
    if op and pv is not None:
        tol = _f("premTol") or max(2.0, pv * 0.05)
        if op == "gt" and not premium > pv:
            return False, f"premium {premium:.1f} !> {pv}"
        if op == "lt" and not premium < pv:
            return False, f"premium {premium:.1f} !< {pv}"
        if op == "near" and abs(premium - pv) > tol:
            return False, f"premium {premium:.1f} not ~{pv}±{tol:.0f}"

    for lo_key, hi_key, val, name in (
        ("premPctMin", "premPctMax", prem_chg_pct, "prem%"),
        ("premPtsMin", "premPtsMax", prem_chg, "premΔ"),
        ("deltaMin", "deltaMax", delta, "|delta|"),
    ):
        lo, hi = _f(lo_key), _f(hi_key)
        if lo is not None and val < lo:
            return False, f"{name} {val:.2f} < {lo}"
        if hi is not None and val > hi:
            return False, f"{name} {val:.2f} > {hi}"
    return True, ""


def _resolve_instrument(inst: str, atm: float, step: float) -> tuple[float, str]:
    """'OTM2_CE' -> (strike, 'CE').  Offsets are in strike steps from ATM."""
    inst = (inst or "ATM_CE").upper()
    ot = "PE" if inst.endswith("PE") else "CE"
    depth = 0
    for tag, d in (("ITM2", 2), ("ITM1", 1), ("OTM2", 2), ("OTM1", 1)):
        if inst.startswith(tag):
            depth = d
            break
    if inst.startswith("ITM"):
        strike = atm - depth * step if ot == "CE" else atm + depth * step
    else:  # ATM or OTM
        sign = 1 if inst.startswith("OTM") else 0
        strike = atm + sign * depth * step if ot == "CE" else atm - sign * depth * step
    return round(strike, 2), ot


# --------------------------------------------------------------------------- #
# the engine                                                                   #
# --------------------------------------------------------------------------- #
# Events that also go out as alerts (Telegram / push / webhook), with the severity they carry.
_ALERT_LEVELS = {"entry": "info", "exit": "info", "error": "critical", "stop": "warning"}
# A failing order retries every tick; alert once per this long per distinct message, not every 9 s.
_ALERT_THROTTLE_S = 600.0
_REPEATING_LEVELS = {"warn", "error", "stop"}   # levels that can repeat every tick
_LOG_REPEAT_S = 600.0                          # ...and are folded into one line within this window


class PartialFill(Exception):
    """A sliced live order that got `placed` lots through before a slice failed. The caller
    must record what really went through instead of assuming all-or-nothing."""

    def __init__(self, placed: int, cause: Exception):
        super().__init__(f"{placed} lot(s) went through, then: {cause}")
        self.placed = placed
        self.cause = cause


class StructureBroken(Exception):
    """A multi-leg order where some legs went through and a later one failed."""

    def __init__(self, done: list[dict], cause: Exception):
        super().__init__(f"{len(done)} leg(s) went through, then: {cause}")
        self.done = done
        self.cause = cause


def _week_key(now: datetime) -> str:
    iso = now.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def _num_or_none(v):
    if v in (None, ""):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _dte_band(lo: float | None, hi: float | None) -> str:
    if lo == 0 and hi == 0:
        return "on expiry day only"
    if lo is not None and hi is not None:
        return f"only {lo:g} days out" if lo == hi else f"{lo:g} to {hi:g} days out"
    return f"{lo:g}+ days out" if lo is not None else f"up to {hi:g} days out"


def _legs_of(pos: dict) -> list[dict]:
    """The legs of an open position; a single-option position is a one-leg list."""
    if pos.get("legs"):
        return pos["legs"]
    return [{"ot": pos["ot"], "strike": pos["strike"], "side": pos["side"], "mult": 1,
             "entryPx": pos["entryPx"]}]


def _pos_label(pos: dict) -> str:
    if pos.get("label"):
        return pos["label"]
    return f"{pos.get('strike'):g}{pos.get('ot')}" if pos.get("strike") is not None else "?"


class AutoBot:
    TRADES_MAX = 2000

    def __init__(self) -> None:
        doc = db.get_kv("autobot") or {}
        self.master: bool = bool(doc.get("master", False))
        self.max_loss_per_day: float = float(doc.get("maxLossPerDay", 0) or 0)
        self.rules: list[dict] = list(doc.get("rules", []))
        self.state: dict[str, dict] = db.get_kv("autobot_state") or {}
        self.log: deque = deque((db.get_kv("autobot_log") or [])[-200:], maxlen=200)
        # closed-trade ledger (one row per fill that reduced a position), feeds the per-rule stats
        self.trades: list[dict] = list(db.get_kv("autobot_trades") or [])[-self.TRADES_MAX:]
        self.daily_pnl: float = 0.0
        self._pnl_day: str = ""
        # in-memory only: why each rule did / didn't act on the last look (see _set_why)
        self._why: dict[str, dict] = {}
        self._alert_seen: dict[tuple, float] = {}
        self._trips_cache: tuple[int, list[dict]] = (-1, [])

    # -- persistence ------------------------------------------------------- #
    def _save_doc(self) -> None:
        db.set_kv("autobot", {
            "master": self.master,
            "maxLossPerDay": self.max_loss_per_day,
            "rules": self.rules,
        })

    def _save_state(self) -> None:
        db.set_kv("autobot_state", self.state)
        db.set_kv("autobot_log", list(self.log))

    def _save_trades(self) -> None:
        db.set_kv("autobot_trades", self.trades[-self.TRADES_MAX:])

    # -- events / alerts ------------------------------------------------- #
    def _emit(self, rule: dict, level: str, msg: str) -> None:
        now = time.time()
        rec = {
            "ts": now, "ruleId": rule.get("id"),
            "ruleName": rule.get("name", rule.get("id", "?")), "level": level, "msg": msg,
        }
        # a condition that persists (no chain, a rejected order) is logged on every tick;
        # fold repeats of the same message into one line with a count so they can't flush
        # the real entries and exits out of the bounded log
        prev = None
        if level in _REPEATING_LEVELS:
            for old in itertools.islice(self.log, 30):
                if (old.get("ruleId") == rec["ruleId"] and old.get("level") == level
                        and old.get("msg") == msg and now - old["ts"] < _LOG_REPEAT_S):
                    prev = old
                    break
        if prev is not None:
            self.log.remove(prev)
            rec["count"] = int(prev.get("count", 1)) + 1
        self.log.appendleft(rec)
        if prev is None:
            log.info("[%s] %s", rec["ruleName"], msg)
        sev = _ALERT_LEVELS.get(level)
        if sev:
            self._alert(rule, level, msg, sev)

    def _alert(self, rule: dict, level: str, msg: str, sev: str) -> None:
        """Send the event out through the alert pipeline (in-app feed + Telegram / push /
        webhook, per Settings). Entries and exits always go out; errors and safety stops
        repeat every tick while the cause persists, so they are throttled per message."""
        now = time.time()
        if level in ("error", "stop"):
            key = (rule.get("id"), level, msg[:60])
            if now - self._alert_seen.get(key, 0.0) < _ALERT_THROTTLE_S:
                return
            self._alert_seen[key] = now
            if len(self._alert_seen) > 500:
                for k in sorted(self._alert_seen, key=self._alert_seen.get)[:250]:
                    self._alert_seen.pop(k, None)
        try:
            store.add_alert({
                "ts": now, "symbol": (rule.get("symbol") or "").upper(),
                "kind": f"autobot-{level}", "severity": sev, "score": 0,
                "message": f"{rule.get('name') or rule.get('id')}: {msg}",
                "category": "autobot", "ruleId": rule.get("id"),
            })
        except Exception as exc:  # noqa: BLE001
            log.debug("autobot alert failed: %s", exc)

    def _set_why(self, rid: str, new: dict) -> None:
        """Remember what the rule concluded on this look, for the card's explanation. Kept
        in memory (not persisted) and only replaced when something changed or a minute
        has passed, so a quiet rule doesn't churn the snapshot every tick."""
        old = self._why.get(rid)
        now = time.time()
        if old and now - old["ts"] < 60 and {k: v for k, v in old.items() if k != "ts"} == new:
            return
        self._why[rid] = {**new, "ts": now}

    # -- ledger / stats --------------------------------------------------- #
    def _record_trade(self, rule: dict, pos: dict, *, lots: int, exit_px: float, pnl: float,
                      reason: str, partial: bool, day: str, marks: list[float] | None = None) -> None:
        ls = int(pos.get("lotSize", 1) or 1)
        legs = _legs_of(pos)
        # charges for the closed lots: per leg, entry to exit (est.; see charges.py)
        cost = 0.0
        for i, lg in enumerate(legs):
            m = marks[i] if marks and i < len(marks) else lg["entryPx"]
            cost += chg.round_trip_charges(lg["entryPx"], m, lots * ls * int(lg.get("mult", 1)), lg["side"])
        self.trades.append({
            "tid": str(pos.get("tid") or int(pos.get("ts", 0) * 1000)),
            "ruleId": rule.get("id"), "ruleName": rule.get("name") or rule.get("id"),
            "symbol": (rule.get("symbol") or "").upper(), "label": _pos_label(pos),
            "structure": pos.get("structure"), "side": pos["side"], "lots": lots, "lotSize": ls,
            "entryPx": round(float(pos["entryPx"]), 2), "exitPx": round(float(exit_px), 2),
            "pnl": round(pnl, 2), "charges": round(cost, 2), "reason": reason, "partial": partial,
            "mode": pos.get("mode", "paper"), "entryTs": pos.get("ts"), "exitTs": time.time(), "day": day,
        })
        if len(self.trades) > self.TRADES_MAX + 200:
            self.trades = self.trades[-self.TRADES_MAX:]
        self._save_trades()

    def _round_trips(self) -> list[dict]:
        """The ledger folded to one row per trade: a position that scaled out is ONE trade."""
        n = len(self.trades)
        if self._trips_cache[0] == n:
            return self._trips_cache[1]
        by: dict[tuple, dict] = {}
        for t in self.trades:
            k = (t["ruleId"], t["tid"])
            r = by.get(k)
            if r is None:
                by[k] = {**t, "pnl": t["pnl"], "charges": t["charges"], "legsClosed": 1}
            else:
                r["pnl"] += t["pnl"]
                r["charges"] += t["charges"]
                r["exitTs"] = t["exitTs"]
                r["exitPx"] = t["exitPx"]
                r["day"] = t["day"]
                if not t["partial"]:
                    r["reason"] = t["reason"]
        trips = sorted(by.values(), key=lambda r: r["exitTs"])
        self._trips_cache = (n, trips)
        return trips

    @staticmethod
    def _summ(trips: list[dict]) -> dict:
        net = [t["pnl"] - t["charges"] for t in trips]
        holds = [((t["exitTs"] - t["entryTs"]) / 60.0) if t.get("entryTs") else None for t in trips]
        s = summarize(net, holds_min=holds, reasons=[t["reason"] for t in trips], days=[t["day"] for t in trips])
        gross = sum(t["pnl"] for t in trips)
        s["gross"] = round(gross, 0)
        s["charges"] = round(sum(t["charges"] for t in trips), 0)
        return s

    def _rule_stats(self, rid: str, day: str) -> dict:
        trips = [t for t in self._round_trips() if t["ruleId"] == rid]
        if not trips:
            return {"trades": 0, "winRate": 0.0, "net": 0.0, "today": 0.0, "gross": 0.0}
        net = [t["pnl"] - t["charges"] for t in trips]
        wins = sum(1 for p in net if p > 0)
        return {
            "trades": len(trips), "winRate": round(wins / len(trips) * 100, 1),
            "net": round(sum(net), 0), "gross": round(sum(t["pnl"] for t in trips), 0),
            "today": round(sum(t["pnl"] - t["charges"] for t in trips if t["day"] == day), 0),
        }

    def stats(self, limit: int = 60) -> dict:
        trips = self._round_trips()
        rules: dict[str, dict] = {}
        for rid in {t["ruleId"] for t in trips}:
            mine = [t for t in trips if t["ruleId"] == rid]
            rules[rid] = {"name": mine[-1]["ruleName"], **self._summ(mine)}
        return {
            "overall": self._summ(trips),
            "rules": rules,
            "recent": list(reversed(self.trades[-limit:])),
        }

    # -- CRUD ------------------------------------------------------------- #
    def snapshot(self) -> dict:
        day = datetime.now(IST).date().isoformat()
        out_rules = []
        for r in self.rules:
            rid = r.get("id", "")
            st = self.state.get(rid, {})
            out_rules.append({
                **r,
                "_state": {
                    "open": st.get("open"),
                    "tradesToday": st.get("tradesToday", 0),
                    "weekTrades": st.get("weekTrades", 0),
                    "lossStreak": st.get("lossStreak", 0),
                    "dayPnl": round(st.get("dayPnl", 0.0), 0),
                    "paused": st.get("pauseWhy") if st.get("pausedDay") == day else None,
                },
                "_live": st.get("live"),
                "_why": self._why.get(rid),
                "_stats": self._rule_stats(rid, day),
            })
        return {
            "master": self.master,
            "maxLossPerDay": self.max_loss_per_day,
            "marketOpen": _in_market_hours(),
            "dailyPnl": round(self.daily_pnl, 2),
            "rules": out_rules,
            "log": list(self.log)[:100],
        }

    def set_master(self, on: bool) -> dict:
        self.master = bool(on)
        self._save_doc()
        log.warning("autobot master -> %s", "ON" if self.master else "OFF")
        return self.snapshot()

    def set_max_loss(self, v: float) -> dict:
        self.max_loss_per_day = max(0.0, float(v or 0))
        self._save_doc()
        return self.snapshot()

    def upsert_rule(self, rule: dict) -> dict:
        rule = dict(rule or {})
        rid = rule.get("id") or f"r{int(time.time() * 1000) % 10_000_000}"
        rule["id"] = rid
        rule.setdefault("enabled", False)
        rule.setdefault("lots", 1)
        rule.setdefault("mode", "paper")
        rule.setdefault("product", "NRML")
        rule.setdefault("maxTradesPerDay", 3)
        rule.setdefault("cooldownMin", 5)
        rule.setdefault("squareOff", "15:20")
        G.normalize(rule)
        if ST.is_structure(rule):
            rule["offset"], rule["width"] = ST.clamp_params(rule["structure"], rule.get("offset"), rule.get("width"))
        else:
            rule.pop("structure", None)
        for i, r in enumerate(self.rules):
            if r.get("id") == rid:
                self.rules[i] = rule
                break
        else:
            self.rules.append(rule)
        self._save_doc()
        return self.snapshot()

    def delete_rule(self, rid: str) -> dict:
        self.rules = [r for r in self.rules if r.get("id") != rid]
        self.state.pop(rid, None)
        self._why.pop(rid, None)
        self._save_doc()
        self._save_state()
        return self.snapshot()

    def set_rule_enabled(self, rid: str, on: bool) -> dict:
        for r in self.rules:
            if r.get("id") == rid:
                r["enabled"] = bool(on)
        self._save_doc()
        return self.snapshot()

    def resume_rule(self, rid: str) -> dict:
        """Lift a safety pause (loss streak / rule loss cap) for the rest of today."""
        st = self.state.get(rid)
        if st:
            st.pop("pausedDay", None)
            st.pop("pauseWhy", None)
            st["lossStreak"] = 0
            self._save_state()
        return self.snapshot()

    def kill(self) -> dict:
        """Panic button: master OFF + flag every open rule position for square-off. The
        flagged positions are then closed by tick() even though the master is off."""
        self.master = False
        for rid, st in self.state.items():
            if st.get("open"):
                st["open"]["forceExit"] = True
        self._save_doc()
        self._save_state()
        log.warning("autobot KILL invoked")
        return self.snapshot()

    # -- order helpers -------------------------------------------------- #
    def _lots_per_order(self, rule: dict, mode: str) -> int:
        """Largest single live order, in lots (0 = no slicing). A big order is split so no
        one order can hit the exchange freeze quantity and be rejected outright."""
        if mode != "live":
            return 0
        v = _num_or_none(rule.get("maxLotsPerOrder"))
        return int(v) if v and v > 0 else int(config.AUTOBOT_MAX_LOTS_PER_ORDER)

    async def _place(self, rule: dict, side: str, strike: float, ot: str,
                     expiry: str, lots: int) -> dict:
        from .routes import _route_leg  # lazy: routes imports store, not autobot
        from .brokers import get_broker

        want_live = rule.get("mode") == "live"
        mode = "live" if (want_live and store.order_mode() == "live"
                          and get_broker().authed) else "paper"

        async def one(n: int) -> dict:
            return await _route_leg(
                symbol=rule["symbol"], expiry=expiry, strike=strike, option_type=ot,
                side=side, qty_lots=int(n), order_type="MKT", price=None,
                product=rule.get("product", "NRML"), mode=mode,
            )

        lots = int(lots)
        chunk = self._lots_per_order(rule, mode)
        if not chunk or lots <= chunk:
            return await one(lots)
        placed, res = 0, {}
        while placed < lots:
            n = min(chunk, lots - placed)
            try:
                res = await one(n)
            except Exception as exc:  # noqa: BLE001
                if placed:
                    raise PartialFill(placed, exc) from exc
                raise
            placed += n
            if placed < lots:
                await asyncio.sleep(0.3)   # stay under the broker's order-rate limit
        return {**res, "qtyLots": lots, "slices": -(-lots // chunk)}

    def _marks(self, sym: str, pos: dict) -> list[float]:
        out = []
        for lg in _legs_of(pos):
            m = store._mark_price(sym, pos["expiry"], lg["strike"], lg["ot"])
            out.append(m if m else lg["entryPx"])
        return out

    def _pos_value(self, sym: str, pos: dict) -> float:
        """Current premium on the footing autobot_exit expects. One option: its LTP. A
        structure: the net premium (a credit structure returns what it would cost to close)."""
        marks = self._marks(sym, pos)
        if not pos.get("legs"):
            return marks[0]
        net = sum((1 if lg["side"] == "BUY" else -1) * int(lg.get("mult", 1)) * m
                  for lg, m in zip(pos["legs"], marks))
        return net if pos["side"] == "BUY" else -net

    async def _close(self, rule: dict, pos: dict, lots: int) -> None:
        """Close `lots` lots of every leg. Shorts are bought back before longs are sold so the
        margin the hedges provide is never released while the shorts are still open."""
        legs = sorted(_legs_of(pos), key=lambda lg: 0 if lg["side"] == "SELL" else 1)
        done: list[dict] = []
        for lg in legs:
            exit_side = "SELL" if lg["side"] == "BUY" else "BUY"
            try:
                await self._place(rule, exit_side, lg["strike"], lg["ot"], pos["expiry"],
                                  lots * int(lg.get("mult", 1)))
            except Exception as exc:  # noqa: BLE001
                if len(legs) == 1:
                    raise
                raise StructureBroken(done, exc) from exc
            done.append(lg)

    # -- main loop ------------------------------------------------------ #
    async def tick(self) -> bool:
        """Evaluate every enabled rule once.  Returns True if anything changed."""
        if not self.rules:
            return False
        # KILL turns the master off but flags open positions for square-off; those still have
        # to be closed, so an off master only stops entries and normal management.
        unwinding = any((st.get("open") or {}).get("forceExit") for st in self.state.values())
        if not self.master and not unwinding:
            return False

        now = datetime.now(IST)
        day = now.date().isoformat()
        wk = _week_key(now)
        if day != self._pnl_day:
            self.daily_pnl = 0.0
            self._pnl_day = day

        open_mkt = _in_market_hours(now)
        loss_lock = self.max_loss_per_day > 0 and self.daily_pnl <= -self.max_loss_per_day
        changed = False
        ctx_cache: dict[tuple, _Ctx] = {}

        for rule in self.rules:
            rid = rule.get("id", "")
            sym = (rule.get("symbol") or "").upper()
            if not sym:
                continue
            pos0 = (self.state.get(rid) or {}).get("open")
            if not self.master:
                if not (pos0 and pos0.get("forceExit")):
                    continue
            elif not rule.get("enabled"):
                continue
            st = self.state.setdefault(rid, {})
            if st.get("day") != day:
                still_open = st.get("open")  # a positional trade can span days
                keep = {k: st[k] for k in ("weekKey", "weekTrades") if k in st}
                st.clear()
                st.update({"day": day, "tradesToday": 0, "open": still_open, "lastExitTs": 0,
                           "lossStreak": 0, "dayPnl": 0.0, **keep})
            if st.get("weekKey") != wk:
                st["weekKey"], st["weekTrades"] = wk, 0

            pos = st.get("open")
            if pos:
                if await self._manage(rule, st, pos, now, day, open_mkt, ctx_cache):
                    changed = True
                continue
            if not self.master:
                continue
            if await self._look_for_entry(rule, st, now, day, open_mkt, loss_lock, ctx_cache):
                changed = True

        if changed:
            self._save_state()
        return changed

    # ---- an open position ---------------------------------------------- #
    def _cx(self, cache: dict, sym: str, rule: dict) -> _Ctx:
        tf, bars = int(rule.get("entryTf") or 0), int(rule.get("entryBars") or 0)
        return cache.get((sym, tf, bars)) or cache.setdefault((sym, tf, bars), _Ctx(sym, tf=tf, bars=bars))

    async def _manage(self, rule: dict, st: dict, pos: dict, now: datetime, day: str,
                      open_mkt: bool, ctx_cache: dict) -> bool:
        rid = rule.get("id", "")
        sym = (rule.get("symbol") or "").upper()
        buy = pos["side"] == "BUY"
        ls = int(pos.get("lotSize", 1))
        ltp = self._pos_value(sym, pos)
        qty = max(1, int(pos.get("lots", 1)) * ls)
        ev = X.evaluate(rule, buy=buy, base=pos["entryPx"] or 1.0, ltp=ltp, peak=pos.get("peak"), qty=qty)
        pos["peak"] = round(ev.peak, 2)
        changed = False
        new_stop = round(ev.stop_px, 2) if ev.stop_px is not None else None
        if new_stop != pos.get("stopPx"):
            pos["stopPx"] = new_stop
            changed = True
        label = _pos_label(pos)

        # single-level scale-out: book part of the position at an earlier target and let the
        # remainder ride to the existing SL / target / trail. Peak-tracking is NOT reset on a
        # partial -- it's a price level, not a size, so trailing / breakeven keep protecting
        # the smaller remainder with no extra code.
        close_lots = 0 if pos.get("legs") else X.partial_close_lots(   # single-option positions only
            rule, ev, entry_lots=int(pos.get("entryLots") or pos["lots"]), lots=pos["lots"],
            done=bool(pos.get("partial1Done")),
        )
        if close_lots:
            try:
                await self._close(rule, pos, close_lots)
            except PartialFill as pf:
                self._book_partial(rule, st, pos, ev, pf.placed, day, ls, "scale-out (partly filled)")
                pos["partial1Done"] = True
                self._emit(rule, "error", f"scale-out only closed {pf.placed} of {close_lots} lots: {pf.cause}")
                return True
            except Exception as exc:  # noqa: BLE001
                self._emit(rule, "error", f"partial exit failed: {exc}")
            else:
                pnl = X.pnl_rs(ev, close_lots, ls)
                self._book_partial(rule, st, pos, ev, close_lots, day, ls, "scale-out", pnl=pnl)
                pos["partial1Done"] = True
                self._emit(
                    rule, "exit",
                    f"PARTIAL {close_lots} lots @~{ltp:.1f} "
                    f"(target1 {rule.get('target1Pct')}{ev.unit}) P&L~{pnl:+.0f}, {pos['lots']} left",
                )
                changed = True
            return changed

        positional = str(rule.get("holdType", "intraday")).lower() == "positional"
        sq = None if positional else _parse_hhmm(rule.get("squareOff"))
        reason = None
        exit_res: list[bool] = []
        why_grp: dict = {}
        if pos.get("forceExit"):
            reason = "unwind (a leg failed to close)" if pos.get("unwind") else "kill"
        elif X.stop_hit(ev):
            reason = X.stop_reason(rule, ev)
        elif X.target_hit(rule, ev):
            reason = X.target_reason(rule, ev)
        elif not positional and (not open_mkt or (sq and now.time() >= sq)):
            reason = "square-off"
        else:
            cx = self._cx(ctx_cache, sym, rule)
            conds = rule.get("exit", [])
            st["live"] = cx.prev_candle_live(conds)
            # the open trade, for the trade_stoploss / trade_target conditions: the same numbers the
            # fixed SL / target above were just judged on
            trade = {"buy": buy, "base": pos["entryPx"] or 1.0, "ltp": ltp, "qty": qty}
            exit_res = [cx.eval_one(c, trade=trade) for c in conds]
            exit_logic, exit_groups = G.spec(rule, "exit")
            why_grp = G.why_fields(conds, exit_groups)
            if G.evaluate(conds, exit_groups, exit_logic, exit_res.__getitem__):
                reason = "exit signal"
        self._set_why(rid, {"phase": "open", "list": "exit", "logic": G.spec(rule, "exit")[0],
                            "conds": exit_res, "reason": None, "stop": new_stop, **why_grp})
        if not reason:
            return changed

        try:
            await self._close(rule, pos, pos["lots"])
        except PartialFill as pf:
            self._book_partial(rule, st, pos, ev, pf.placed, day, ls, f"{reason} (partly filled)")
            self._emit(rule, "error", f"exit only closed {pf.placed} lots, {pos['lots']} still open - will retry: {pf.cause}")
            return True
        except StructureBroken as sb:
            self._structure_broken(rule, st, pos, sb, "exit")
            return True
        except Exception as exc:  # noqa: BLE001
            self._emit(rule, "error", f"exit order failed: {exc}")
            return changed
        marks = self._marks(sym, pos)
        # after a broken multi-leg exit the entry premium no longer matches the legs left, so a
        # P&L computed against it would be nonsense; say so instead of booking a wrong number
        pnl = 0.0 if pos.get("unwind") else X.pnl_rs(ev, pos["lots"], ls)
        self.daily_pnl += pnl
        self._emit(rule, "exit", f"CLOSE {label} @~{ltp:.1f} ({reason}) "
                                 + ("P&L not tracked for a broken exit - check the broker" if pos.get("unwind") else f"P&L~{pnl:+.0f}"))
        self._record_trade(rule, pos, lots=pos["lots"], exit_px=ltp, pnl=pnl, reason=reason,
                           partial=False, day=day, marks=marks)
        st["open"] = None
        st["lastExitTs"] = time.time()
        self._after_exit(rule, st, day, pnl, pos.get("realized", 0.0) + pnl)
        return True

    def _book_partial(self, rule: dict, st: dict, pos: dict, ev: X.ExitEval, lots: int, day: str,
                      ls: int, reason: str, pnl: float | None = None) -> None:
        """Record `lots` closed lots against an open position that stays open."""
        if lots <= 0:
            return
        pnl = X.pnl_rs(ev, lots, ls) if pnl is None else pnl
        self.daily_pnl += pnl
        st["dayPnl"] = st.get("dayPnl", 0.0) + pnl
        pos["lots"] -= lots
        pos["realized"] = pos.get("realized", 0.0) + pnl
        sym = (rule.get("symbol") or "").upper()
        self._record_trade(rule, pos, lots=lots, exit_px=ev.ltp, pnl=pnl, reason=reason, partial=True,
                           day=day, marks=self._marks(sym, pos))

    def _structure_broken(self, rule: dict, st: dict, pos: dict, sb: StructureBroken, what: str) -> None:
        """Some legs of a multi-leg order went through and one failed: keep managing only the
        legs that are still open, and shout, because the book is now lopsided."""
        closed = {(lg["strike"], lg["ot"]) for lg in sb.done}
        if what == "exit":
            pos["legs"] = [lg for lg in _legs_of(pos) if (lg["strike"], lg["ot"]) not in closed]
            pos["forceExit"] = pos["unwind"] = True   # finish unwinding what's left on the next tick
        self._emit(
            rule, "error",
            f"{what} of {_pos_label(pos)} broke after {len(sb.done)} leg(s) ({sb.cause}) - "
            f"{'closing the remaining legs next tick' if what == 'exit' else 'check the broker'}",
        )

    def _after_exit(self, rule: dict, st: dict, day: str, final_pnl: float, trade_pnl: float) -> None:
        """Book-keeping once a trade has fully closed: the day's P&L for this rule, the
        losing streak, and the safety pauses that hang off both. `final_pnl` is the last
        exit alone (any scale-out was booked to the day already); `trade_pnl` is the whole
        round trip and is what decides win or loss for the streak."""
        st["dayPnl"] = st.get("dayPnl", 0.0) + final_pnl
        st["lossStreak"] = st.get("lossStreak", 0) + 1 if trade_pnl < 0 else 0
        n = int(_num_or_none(rule.get("maxConsecLosses")) or 0)
        cap = _num_or_none(rule.get("ruleMaxLoss")) or 0.0
        why = None
        if n and st["lossStreak"] >= n:
            why = f"{n} losing trades in a row"
        elif cap and st.get("dayPnl", 0.0) <= -abs(cap):
            why = f"rule loss cap of ₹{abs(cap):,.0f} hit"
        if why:
            st["pausedDay"] = day
            st["pauseWhy"] = f"Paused for today: {why}"
            self._emit(rule, "stop", f"paused for the rest of today - {why}")

    # ---- looking for an entry ------------------------------------------ #
    async def _look_for_entry(self, rule: dict, st: dict, now: datetime, day: str, open_mkt: bool,
                              loss_lock: bool, ctx_cache: dict) -> bool:
        rid = rule.get("id", "")
        sym = (rule.get("symbol") or "").upper()

        def blocked(msg: str, **extra) -> bool:
            self._set_why(rid, {"phase": "blocked", "reason": msg, **extra})
            return False

        # ---- gates, cheapest first --------------------------------------- #
        if not open_mkt:
            return blocked("market closed")
        if loss_lock:
            return blocked(f"daily loss cap reached (₹{self.max_loss_per_day:,.0f})")
        if st.get("pausedDay") == day:
            return blocked(st.get("pauseWhy") or "paused for today")
        max_pd = int(rule.get("maxTradesPerDay", 3))
        if st.get("tradesToday", 0) >= max_pd:
            return blocked(f"max trades today reached ({st.get('tradesToday', 0)}/{max_pd})")
        wk_cap = int(_num_or_none(rule.get("maxTradesPerWeek")) or 0)
        if wk_cap and st.get("weekTrades", 0) >= wk_cap:
            return blocked(f"weekly trade cap reached ({st.get('weekTrades', 0)}/{wk_cap})")
        left = float(rule.get("cooldownMin", 5)) * 60 - (time.time() - st.get("lastExitTs", 0))
        if left > 0:
            return blocked(f"cooling down after the last exit ({int(left // 60)}m {int(left % 60)}s left)")
        nea, neb = _parse_hhmm(rule.get("noEntryAfter")), _parse_hhmm(rule.get("noEntryBefore"))
        if (nea and now.time() >= nea) or (neb and now.time() < neb):
            return blocked(f"outside the entry window ({rule.get('noEntryBefore') or 'open'} to {rule.get('noEntryAfter') or 'close'})")

        # ---- the signal ---------------------------------------------------- #
        conds = rule.get("entry", [])
        logic, groups = G.spec(rule, "entry")
        cx = self._cx(ctx_cache, sym, rule)
        st["live"] = cx.prev_candle_live(conds)
        if cx.n < 5:
            return blocked("warming up: not enough price history yet")
        results = [cx.eval_one(c) for c in conds]
        fired = G.evaluate(conds, groups, logic, results.__getitem__)
        watching = {"list": "entry", "logic": logic, "conds": results, **G.why_fields(conds, groups)}
        if not fired:
            self._set_why(rid, {"phase": "watching", "reason": None, **watching})
            return False

        def held_back(msg: str) -> bool:
            return blocked(f"signal fired but {msg}", **watching)

        chain = store.get_chain(sym, rule.get("expiry"))
        if not chain or not chain.get("atmStrike"):
            self._emit(rule, "warn", "entry signal but no chain")
            return held_back("there is no option chain")
        dte_days = int(chain.get("dte") or 0)
        lo, hi = _num_or_none(rule.get("minDte")), _num_or_none(rule.get("maxDte"))
        if (lo is not None and dte_days < lo) or (hi is not None and dte_days > hi):
            return held_back(f"the expiry is {dte_days} day(s) away and this rule trades {_dte_band(lo, hi)}")

        if ST.is_structure(rule):
            return await self._enter_structure(rule, st, chain, held_back)

        strike, ot = _resolve_instrument(
            rule.get("instrument", "ATM_CE"), chain["atmStrike"], chain.get("strikeStep") or 50,
        )
        exp = chain["expiry"]
        entry_px = store._mark_price(sym, exp, strike, ot)
        if not entry_px:
            self._emit(rule, "warn", f"no LTP for {strike}{ot}")
            return held_back(f"{strike:g}{ot} has no price")

        # ---- premium / delta entry filter --------------------------------- #
        crow = next((r for r in chain.get("rows", []) if r["strike"] == strike), None)
        leg = (crow or {}).get("call" if ot == "CE" else "put", {}) if crow else {}
        ef_ok, ef_why = _entry_filter_ok(
            rule.get("entryFilter") or {}, float(entry_px),
            abs(float(leg.get("delta") or 0)),
            float(leg.get("chg") or 0),
            float(leg.get("chgPct") or 0),
        )
        if not ef_ok:
            return held_back(f"the entry filter says no ({ef_why})")

        # ---- liquidity guard: a wide spread is a cost paid on the way in AND the way out ---- #
        max_spread = _num_or_none(rule.get("maxSpreadPct")) or 0.0
        if max_spread > 0:
            bid, ask = float(leg.get("bid") or 0), float(leg.get("ask") or 0)
            if bid > 0 and ask > 0:
                spread = (ask - bid) / ((ask + bid) / 2) * 100
                if spread > max_spread:
                    return held_back(f"{strike:g}{ot} spread is {spread:.1f}% (limit {max_spread:g}%)")

        side = rule.get("side", "BUY")
        lots = int(rule.get("lots", 1))
        placed = lots
        partial_err = None
        try:
            res = await self._place(rule, side, strike, ot, exp, lots)
        except PartialFill as pf:
            placed, partial_err = pf.placed, pf
            res = {"mode": "live"}
        except Exception as exc:  # noqa: BLE001
            self._emit(rule, "error", f"entry order failed: {exc}")
            return held_back(f"the entry order failed ({exc})")
        now_ts = time.time()
        st["open"] = {
            "side": side, "strike": strike, "ot": ot, "expiry": exp, "label": f"{strike:g}{ot}",
            "entryPx": float(entry_px), "lots": placed, "entryLots": placed,
            "lotSize": chain.get("lotSize", 1), "ts": now_ts, "tid": str(int(now_ts * 1000)),
            "mode": res.get("mode", "paper"),
            "peak": float(entry_px), "stopPx": None,
        }
        st["tradesToday"] = st.get("tradesToday", 0) + 1
        st["weekTrades"] = st.get("weekTrades", 0) + 1
        self._emit(rule, "entry", f"{side} {strike:g}{ot} x{placed} @~{float(entry_px):.1f} [{res.get('mode')}]")
        if partial_err:
            self._emit(rule, "error", f"entry only got {placed} of {lots} lots away: {partial_err.cause}")
        self._set_why(rid, {"phase": "open", "list": "exit", "conds": [], "logic": rule.get("exitLogic", "any"), "reason": None})
        return True

    # ---- multi-leg structures ------------------------------------------- #
    async def _open_structure(self, rule: dict, legs: list[dict], exp: str, lots: int):
        """Place every leg, protective (bought) legs first so the margin they provide is in
        place before the shorts go on. Returns (legs placed, failure or None, mode)."""
        placed: list[dict] = []
        mode = "paper"
        for lg in sorted(legs, key=lambda l: 0 if l["side"] == "BUY" else 1):
            try:
                res = await self._place(rule, lg["side"], lg["strike"], lg["ot"], exp, lots * int(lg.get("mult", 1)))
            except Exception as exc:  # noqa: BLE001
                return placed, exc, mode
            mode = res.get("mode", mode)
            placed.append(lg)
        return placed, None, mode

    async def _unwind_legs(self, rule: dict, legs: list[dict], exp: str, lots: int):
        """Reverse legs that are already at the broker (shorts bought back first). Returns the
        legs that could NOT be reversed."""
        stuck: list[dict] = []
        for lg in sorted(legs, key=lambda l: 0 if l["side"] == "SELL" else 1):
            try:
                await self._place(rule, "SELL" if lg["side"] == "BUY" else "BUY", lg["strike"], lg["ot"],
                                  exp, lots * int(lg.get("mult", 1)))
            except Exception:  # noqa: BLE001
                stuck.append(lg)
        return stuck

    async def _enter_structure(self, rule: dict, st: dict, chain: dict, held_back) -> bool:
        key = rule["structure"]
        sym = (rule.get("symbol") or "").upper()
        exp = chain["expiry"]
        legs = ST.legs_for(key, chain["atmStrike"], chain.get("strikeStep") or 50, rule.get("offset"), rule.get("width"))
        prices: list[float] = []
        for lg in legs:
            px = store._mark_price(sym, exp, lg["strike"], lg["ot"])
            if not px:
                self._emit(rule, "warn", f"no LTP for {lg['strike']:g}{lg['ot']}")
                return held_back(f"{lg['strike']:g}{lg['ot']} has no price")
            prices.append(float(px))
        net = ST.net_premium(legs, prices)
        if net == 0:
            return held_back("the legs net to zero premium")
        side = "BUY" if net > 0 else "SELL"      # a debit structure is long premium, a credit one is short
        base = abs(net)

        # only the premium band applies to a structure: delta / %-change bands describe one option
        ef = {k: v for k, v in (rule.get("entryFilter") or {}).items() if k in ("premOp", "premVal", "premTol")}
        ef_ok, ef_why = _entry_filter_ok(ef, base, 0.5, 0.0, 0.0)
        if not ef_ok:
            return held_back(f"the entry filter says no ({ef_why})")

        max_spread = _num_or_none(rule.get("maxSpreadPct")) or 0.0
        if max_spread > 0:
            for lg in legs:
                crow = next((r for r in chain.get("rows", []) if r["strike"] == lg["strike"]), None)
                q = (crow or {}).get("call" if lg["ot"] == "CE" else "put", {}) if crow else {}
                bid, ask = float(q.get("bid") or 0), float(q.get("ask") or 0)
                if bid > 0 and ask > 0 and (ask - bid) / ((ask + bid) / 2) * 100 > max_spread:
                    return held_back(f"{lg['strike']:g}{lg['ot']} spread is {(ask - bid) / ((ask + bid) / 2) * 100:.1f}% (limit {max_spread:g}%)")

        lots = int(rule.get("lots", 1))
        placed, failure, mode = await self._open_structure(rule, legs, exp, lots)
        for lg, px in zip(legs, prices):
            lg["entryPx"] = px
        if failure is not None:
            name = ST.title(key)
            if not placed:
                self._emit(rule, "error", f"{name} entry failed on the first leg: {failure}")
                return held_back(f"the entry order failed ({failure})")
            stuck = await self._unwind_legs(rule, placed, exp, lots)
            if not stuck:
                self._emit(rule, "error", f"{name} entry aborted - a leg failed ({failure}); the {len(placed)} leg(s) already "
                                          f"placed were reversed")
                return held_back(f"the {name.lower()} entry aborted after a leg failed ({failure})")
            # some legs can't be reversed: they ARE open, so track them and keep trying to close them
            now_ts = time.time()
            st["open"] = {
                "side": side, "strike": stuck[0]["strike"], "ot": "STR", "expiry": exp, "structure": key,
                "legs": stuck, "label": ST.label(key, stuck), "entryPx": base, "lots": lots, "entryLots": lots,
                "lotSize": chain.get("lotSize", 1), "ts": now_ts, "tid": str(int(now_ts * 1000)), "mode": mode,
                "peak": base, "stopPx": None, "forceExit": True, "unwind": True,
            }
            stuck_txt = ", ".join("%g%s" % (lg["strike"], lg["ot"]) for lg in stuck)
            self._emit(rule, "error", f"{name} entry failed ({failure}) AND {len(stuck)} placed leg(s) could not be reversed "
                                      f"({stuck_txt}) - the rule will keep trying to close them; CHECK THE BROKER")
            return True

        now_ts = time.time()
        label = ST.label(key, legs)
        st["open"] = {
            "side": side, "strike": chain["atmStrike"], "ot": "STR", "expiry": exp, "structure": key,
            "legs": legs, "label": label, "entryPx": base, "lots": lots, "entryLots": lots,
            "lotSize": chain.get("lotSize", 1), "ts": now_ts, "tid": str(int(now_ts * 1000)), "mode": mode,
            "peak": base, "stopPx": None,
        }
        st["tradesToday"] = st.get("tradesToday", 0) + 1
        st["weekTrades"] = st.get("weekTrades", 0) + 1
        self._emit(rule, "entry", f"{label} x{lots} net {'debit' if side == 'BUY' else 'credit'} ~{base:.1f} [{mode}]")
        self._set_why(rule.get("id", ""), {"phase": "open", "list": "exit", "conds": [],
                                           "logic": rule.get("exitLogic", "any"), "reason": None})
        return True



autobot = AutoBot()
