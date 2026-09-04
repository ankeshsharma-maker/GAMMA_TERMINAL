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

    def __init__(self, symbol: str):
        hist = list(store.history.get(symbol, []))
        self.n = len(hist)
        self.spot = [float(h["spot"]) for h in hist if h.get("spot") is not None]
        self.pcr = [float(h["pcr"]) for h in hist if h.get("pcr") is not None]
        self.gex = [float(h["netGex"]) for h in hist if h.get("netGex") is not None]
        self.maxpain = [float(h["maxPain"]) for h in hist if h.get("maxPain")]
        self.ce_oi_chg = [float(h.get("ceOIChg") or 0) for h in hist]
        self.pe_oi_chg = [float(h.get("peOIChg") or 0) for h in hist]

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

    _DISPATCH = {
        "rsi": _rsi, "ema_cross": _ema_cross, "price_vs_ema": _price_vs_ema,
        "macd": _macd, "spot_move_pct": _spot_move_pct, "pcr": _pcr,
        "oi_change": _oi_change, "spot_vs_maxpain": _spot_vs_maxpain, "net_gex": _net_gex,
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


# --------------------------------------------------------------------------- #
# instrument resolution                                                        #
# --------------------------------------------------------------------------- #
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
                move = (ltp - base) / base * 100
                signed = move if pos["side"] == "BUY" else -move
                reason = None
                sq = _parse_hhmm(rule.get("squareOff"))
                if pos.get("forceExit"):
                    reason = "kill"
                elif rule.get("slPct") and signed <= -abs(float(rule["slPct"])):
                    reason = f"SL {rule['slPct']}%"
                elif rule.get("targetPct") and signed >= abs(float(rule["targetPct"])):
                    reason = f"target {rule['targetPct']}%"
                elif not open_mkt or (sq and now.time() >= sq):
                    reason = "square-off"
                else:
                    cx = ctx_cache.setdefault(sym, _Ctx(sym))
                    if cx.eval_any(rule.get("exit", [])):
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
            if cx.n < 5 or not cx.eval_all(rule.get("entry", [])):
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
