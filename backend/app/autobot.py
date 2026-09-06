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
      "entry": [ {condition}, ... ], # ALL must be true to enter
      "exit":  [ {condition}, ... ], # ANY true -> exit
      "slPct": 30,                   # stop-loss % on option premium (signed by side)
      "targetPct": 60,              # take-profit % on option premium
      "maxTradesPerDay": 3,
      "cooldownMin": 5,
      "squareOff": "15:20",         # force flat at/after this IST time
      "noEntryAfter": "15:00"       # optional: no new entries at/after this time
    }

Condition kinds
---------------
Indicator (computed from the spot series in ``store.history``):
    {"kind":"rsi","period":14,"op":"<"|">"|"cross_up"|"cross_down","value":30}
    {"kind":"ema_cross","fast":9,"slow":21,"dir":"up"|"down"}
    {"kind":"price_vs_ema","period":20,"op":"above"|"below"|"cross_up"|"cross_down"}
    {"kind":"macd","fast":12,"slow":26,"signal":9,"op":"hist_up"|"hist_down"|"cross_up"|"cross_down"}
    {"kind":"spot_move_pct","op":"<"|">","value":0.5}   # % change from the day's first sample

OI / chain:
    {"kind":"pcr","op":"<"|">"|"cross_up"|"cross_down","value":0.9}
    {"kind":"oi_change","leg":"call"|"put","action":"build"|"unwind","minOi":0}
    {"kind":"spot_vs_maxpain","op":"above"|"below","bufferPct":0}
    {"kind":"net_gex","op":"pos"|"neg"|"cross_up"|"cross_down"}
"""
from __future__ import annotations

import logging
import time
from collections import deque
from datetime import datetime, time as dtime
from zoneinfo import ZoneInfo

from .config import DATA_DIR
from .store import _load, _save, store

log = logging.getLogger("autobot")
IST = ZoneInfo("Asia/Kolkata")
_MKT_OPEN, _MKT_CLOSE = dtime(9, 15), dtime(15, 30)
_FILE = DATA_DIR / "autobot.json"
_STATE_FILE = DATA_DIR / "autobot_state.json"


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

    def __init__(self, symbol: str, hist: list | None = None):
        hist = list(store.history.get(symbol, [])) if hist is None else list(hist)
        self.n = len(hist)
        self.hist = hist
        self.ts = [float(h.get("t") or 0) for h in hist]
        self.spot = [float(h["spot"]) for h in hist if h.get("spot") is not None]
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

    def _supertrend(self, c) -> bool:
        """Spot-only Supertrend proxy: trailing band = rolling stdev of spot
        moves x `mult`. dir 'up' -> spot just crossed above the band."""
        period = int(c.get("period", 10))
        mult = float(c.get("mult", 3.0))
        s = self.spot
        if len(s) < period + 3:
            return False
        import statistics
        # per-step absolute moves as a volatility proxy (ATR stand-in)
        moves = [abs(s[i] - s[i - 1]) for i in range(1, len(s))]
        band = None
        up = True
        flips: list[bool] = []
        for i in range(period, len(s)):
            vol = statistics.fmean(moves[i - period:i]) or 1.0
            basis = statistics.fmean(s[i - period:i])
            lower, upper = basis - mult * vol, basis + mult * vol
            if band is None:
                band, up = lower, True
            if up:
                band = max(band, lower)
                if s[i] < band:
                    up = False
                    band = upper
            else:
                band = min(band, upper)
                if s[i] > band:
                    up = True
                    band = lower
            flips.append(up)
        if len(flips) < 2:
            return False
        want_up = c.get("dir", "up") == "up"
        if c.get("op", "is") == "flip":
            return flips[-1] != flips[-2] and flips[-1] == want_up
        return flips[-1] == want_up

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

    _DISPATCH = {
        "rsi": _rsi, "ema_cross": _ema_cross, "price_vs_ema": _price_vs_ema,
        "macd": _macd, "spot_move_pct": _spot_move_pct, "pcr": _pcr,
        "oi_change": _oi_change, "spot_vs_maxpain": _spot_vs_maxpain, "net_gex": _net_gex,
        "bos": _bos, "opening_range": _opening_range, "oi_velocity": _oi_velocity,
        "vol_surge": _vol_surge, "oi_divergence": _oi_divergence,
        "maxpain_shift": _maxpain_shift, "pcr_roc": _pcr_roc, "iv_skew": _iv_skew,
        "gamma_flip": _gamma_flip,
        "oi_state": _oi_state, "supertrend": _supertrend, "pivot": _pivot,
        "delta_change": _delta_change, "gamma_change": _gamma_change,
    }

    def eval_one(self, cond: dict) -> bool:
        fn = self._DISPATCH.get((cond or {}).get("kind", ""))
        if not fn:
            return False
        try:
            return bool(fn(self, cond))
        except Exception as exc:  # noqa: BLE001
            log.debug("condition %s failed: %s", cond, exc)
            return False

    def eval_all(self, conds: list) -> bool:
        conds = conds or []
        return bool(conds) and all(self.eval_one(c) for c in conds)

    def eval_any(self, conds: list) -> bool:
        return any(self.eval_one(c) for c in (conds or []))

    def eval_conds(self, conds: list, logic: str = "all") -> bool:
        """AND ('all') or OR ('any') over the condition list."""
        return self.eval_any(conds) if (logic or "all") == "any" else self.eval_all(conds)


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
class AutoBot:
    def __init__(self) -> None:
        doc = _load(_FILE, {})
        self.master: bool = bool(doc.get("master", False))
        self.max_loss_per_day: float = float(doc.get("maxLossPerDay", 0) or 0)
        self.rules: list[dict] = list(doc.get("rules", []))
        self.state: dict[str, dict] = _load(_STATE_FILE, {}) or {}
        self.log: deque = deque(
            (_load(_STATE_FILE.with_name("autobot_log.json"), []) or [])[-200:], maxlen=200
        )
        self.daily_pnl: float = 0.0
        self._pnl_day: str = ""

    # -- persistence ------------------------------------------------------- #
    def _save_doc(self) -> None:
        _save(_FILE, {
            "master": self.master,
            "maxLossPerDay": self.max_loss_per_day,
            "rules": self.rules,
        })

    def _save_state(self) -> None:
        _save(_STATE_FILE, self.state)
        _save(_STATE_FILE.with_name("autobot_log.json"), list(self.log))

    def _emit(self, rule: dict, level: str, msg: str) -> None:
        rec = {
            "ts": time.time(), "ruleId": rule.get("id"),
            "ruleName": rule.get("name", rule.get("id", "?")), "level": level, "msg": msg,
        }
        self.log.appendleft(rec)
        log.info("[%s] %s", rec["ruleName"], msg)

    # -- CRUD ------------------------------------------------------------- #
    def snapshot(self) -> dict:
        return {
            "master": self.master,
            "maxLossPerDay": self.max_loss_per_day,
            "marketOpen": _in_market_hours(),
            "dailyPnl": round(self.daily_pnl, 2),
            "rules": [
                {**r, "_state": {
                    "open": self.state.get(r.get("id", ""), {}).get("open"),
                    "tradesToday": self.state.get(r.get("id", ""), {}).get("tradesToday", 0),
                }}
                for r in self.rules
            ],
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
        self._save_doc()
        self._save_state()
        return self.snapshot()

    def set_rule_enabled(self, rid: str, on: bool) -> dict:
        for r in self.rules:
            if r.get("id") == rid:
                r["enabled"] = bool(on)
        self._save_doc()
        return self.snapshot()

    def kill(self) -> dict:
        """Panic button: master OFF + flag every open rule position for square-off."""
        self.master = False
        for rid, st in self.state.items():
            if st.get("open"):
                st["open"]["forceExit"] = True
        self._save_doc()
        self._save_state()
        log.warning("autobot KILL invoked")
        return self.snapshot()

    # -- order helpers -------------------------------------------------- #
    async def _place(self, rule: dict, side: str, strike: float, ot: str,
                     expiry: str, lots: int) -> dict:
        from .routes import _route_leg  # lazy: routes imports store, not autobot
        from .brokers import get_broker

        want_live = rule.get("mode") == "live"
        mode = "live" if (want_live and store.order_mode() == "live"
                          and get_broker().authed) else "paper"
        return await _route_leg(
            symbol=rule["symbol"], expiry=expiry, strike=strike, option_type=ot,
            side=side, qty_lots=int(lots), order_type="MKT", price=None,
            product=rule.get("product", "NRML"), mode=mode,
        )

    # -- main loop ------------------------------------------------------ #
    async def tick(self) -> bool:
        """Evaluate every enabled rule once.  Returns True if anything changed."""
        if not self.master or not self.rules:
            return False

        now = datetime.now(IST)
        day = now.date().isoformat()
        if day != self._pnl_day:
            self.daily_pnl = 0.0
            self._pnl_day = day

        open_mkt = _in_market_hours(now)
        loss_lock = self.max_loss_per_day > 0 and self.daily_pnl <= -self.max_loss_per_day
        changed = False
        ctx_cache: dict[str, _Ctx] = {}

        for rule in self.rules:
            if not rule.get("enabled"):
                continue
            rid = rule.get("id", "")
            sym = (rule.get("symbol") or "").upper()
            if not sym:
                continue
            st = self.state.setdefault(rid, {})
            if st.get("day") != day:
                st.clear()
                st.update({"day": day, "tradesToday": 0, "open": None, "lastExitTs": 0})

            pos = st.get("open")

            # ---- manage an open position ------------------------------- #
            if pos:
                ltp = store._mark_price(sym, pos["expiry"], pos["strike"], pos["ot"]) \
                    or pos["entryPx"]
                base = pos["entryPx"] or 1.0
                buy = pos["side"] == "BUY"
                move = (ltp - base) / base * 100
                signed = move if buy else -move  # favourable P&L %

                # peak = best favourable premium seen; fav = favourable run-up %
                peak = pos.get("peak", base)
                peak = max(peak, ltp) if buy else min(peak, ltp)
                pos["peak"] = round(peak, 2)
                fav = (peak - base) / base * 100 if buy else (base - peak) / base * 100

                # assemble the effective stop price: fixed SL, then ratcheted up
                # by breakeven-arm and trailing-stop once their triggers are hit
                stop_px = None
                sl_pct = float(rule["slPct"]) if rule.get("slPct") not in (None, "") else None
                if sl_pct is not None:
                    stop_px = base * (1 - sl_pct / 100) if buy else base * (1 + sl_pct / 100)
                be_arm = float(rule.get("beArmPct") or 0)
                be_on = be_arm > 0 and fav >= be_arm
                if be_on:
                    stop_px = base if stop_px is None else (
                        max(stop_px, base) if buy else min(stop_px, base)
                    )
                trail_pct = float(rule.get("trailPct") or 0)
                trail_arm = float(rule.get("trailArmPct") or 0)
                trail_on = trail_pct > 0 and fav >= trail_arm
                if trail_on:
                    ts_px = peak * (1 - trail_pct / 100) if buy else peak * (1 + trail_pct / 100)
                    stop_px = ts_px if stop_px is None else (
                        max(stop_px, ts_px) if buy else min(stop_px, ts_px)
                    )
                new_stop = round(stop_px, 2) if stop_px is not None else None
                if new_stop != pos.get("stopPx"):
                    pos["stopPx"] = new_stop
                    changed = True

                reason = None
                sq = _parse_hhmm(rule.get("squareOff"))
                stop_hit = stop_px is not None and (ltp <= stop_px if buy else ltp >= stop_px)
                if pos.get("forceExit"):
                    reason = "kill"
                elif stop_hit:
                    reason = (
                        "trailing stop" if trail_on
                        else "breakeven stop" if be_on
                        else f"SL {rule.get('slPct')}%"
                    )
                elif rule.get("targetPct") and signed >= abs(float(rule["targetPct"])):
                    reason = f"target {rule['targetPct']}%"
                elif not open_mkt or (sq and now.time() >= sq):
                    reason = "square-off"
                else:
                    cx = ctx_cache.setdefault(sym, _Ctx(sym))
                    if cx.eval_conds(rule.get("exit", []), rule.get("exitLogic", "any")):
                        reason = "exit signal"
                if reason:
                    exit_side = "SELL" if pos["side"] == "BUY" else "BUY"
                    try:
                        await self._place(rule, exit_side, pos["strike"], pos["ot"],
                                          pos["expiry"], pos["lots"])
                    except Exception as exc:  # noqa: BLE001
                        self._emit(rule, "error", f"exit order failed: {exc}")
                        continue
                    pnl = signed / 100 * base * pos["lots"] * pos.get("lotSize", 1)
                    self.daily_pnl += pnl
                    self._emit(
                        rule, "exit",
                        f"{exit_side} {pos['strike']}{pos['ot']} @~{ltp:.1f} "
                        f"({reason}) P&L~{pnl:+.0f}",
                    )
                    st["open"] = None
                    st["lastExitTs"] = time.time()
                    changed = True
                continue

            # ---- look for an entry ------------------------------------ #
            if not open_mkt or loss_lock:
                continue
            if st.get("tradesToday", 0) >= int(rule.get("maxTradesPerDay", 3)):
                continue
            if time.time() - st.get("lastExitTs", 0) < float(rule.get("cooldownMin", 5)) * 60:
                continue
            nea = _parse_hhmm(rule.get("noEntryAfter"))
            if nea and now.time() >= nea:
                continue

            cx = ctx_cache.setdefault(sym, _Ctx(sym))
            if cx.n < 5 or not cx.eval_conds(rule.get("entry", []), rule.get("entryLogic", "all")):
                continue

            chain = store.get_chain(sym, rule.get("expiry"))
            if not chain or not chain.get("atmStrike"):
                self._emit(rule, "warn", "entry signal but no chain")
                continue
            strike, ot = _resolve_instrument(
                rule.get("instrument", "ATM_CE"), chain["atmStrike"],
                chain.get("strikeStep") or 50,
            )
            exp = chain["expiry"]
            entry_px = store._mark_price(sym, exp, strike, ot)
            if not entry_px:
                self._emit(rule, "warn", f"no LTP for {strike}{ot}")
                continue

            # ---- premium / delta entry filter --------------------------- #
            crow = next((r for r in chain.get("rows", []) if r["strike"] == strike), None)
            leg = (crow or {}).get("call" if ot == "CE" else "put", {}) if crow else {}
            ef_ok, ef_why = _entry_filter_ok(
                rule.get("entryFilter") or {}, float(entry_px),
                abs(float(leg.get("delta") or 0)),
                float(leg.get("chg") or 0),
                float(leg.get("chgPct") or 0),
            )
            if not ef_ok:
                continue

            side = rule.get("side", "BUY")
            lots = int(rule.get("lots", 1))
            try:
                res = await self._place(rule, side, strike, ot, exp, lots)
            except Exception as exc:  # noqa: BLE001
                self._emit(rule, "error", f"entry order failed: {exc}")
                continue
            st["open"] = {
                "side": side, "strike": strike, "ot": ot, "expiry": exp,
                "entryPx": float(entry_px), "lots": lots,
                "lotSize": chain.get("lotSize", 1), "ts": time.time(),
                "mode": res.get("mode", "paper"),
                "peak": float(entry_px), "stopPx": None,
            }
            st["tradesToday"] = st.get("tradesToday", 0) + 1
            self._emit(
                rule, "entry",
                f"{side} {strike}{ot} x{lots} @~{float(entry_px):.1f} [{res.get('mode')}]",
            )
            changed = True

        if changed:
            self._save_state()
        return changed


autobot = AutoBot()
