"""Smart Money Concepts alerts -- the chart's ◈ SMC ideas, checked on the server so they reach the
app and Telegram with the app closed. Four kinds (each can be switched off):

  ob     -- price comes back into an order block for the FIRST time (the last opposite candle
            before a move that broke a swing), and doesn't close through it on that bar
  sweep  -- a wick through a swing high / low that closes back inside (stops taken)
  choch  -- swing structure changes: the first close through a swing (10 bars each side)
            against the trend
  aplus  -- the classic entry model in one alert: a sweep, then an internal CHoCH the other way,
            then price's first pullback into the order block that move left -- inside the
            discount half of the move for a long, the premium half for a short

Candles: the chosen timeframe (5m / 15m) built from Upstox 1-minute data (the cached source the
trend guard and charts use). Only CLOSED candles count, so an alert never un-happens. Each event
alerts once -- only events on bars newer than the last check (the first check after a restart
only notes where it is) -- and at most MAX_PER_DAY per symbol."""
from __future__ import annotations

import time
from datetime import datetime

from .processing import IST

KV = "smc_alerts"
KINDS = ("ob", "sweep", "choch", "aplus")
DEFAULTS = {"enabled": False, "symbols": ["NIFTY"], "tf": 300, "kinds": {k: True for k in KINDS}}
TFS = (300, 900)
PIVOT = 3        # internal swings (sweeps, order blocks, the A+ CHoCH)
SWING = 10       # swing structure (the CHoCH alert)
APLUS_BARS = 30  # the A+ pieces must follow each other within this many bars
MAX_PER_DAY = 12
_state: dict[str, dict] = {}  # symbol -> {"last": last bar checked, "day", "n"}


# ---------------- settings ----------------
def settings() -> dict:
    from . import db

    d = db.get_kv(KV) or {}
    out = {**DEFAULTS, **{k: v for k, v in d.items() if k in DEFAULTS}}
    out["kinds"] = {**DEFAULTS["kinds"], **(d.get("kinds") or {})}
    if out["tf"] not in TFS:
        out["tf"] = 300
    return out


def save(body: dict) -> dict:
    from . import db

    cur = settings()
    if "enabled" in body:
        cur["enabled"] = bool(body["enabled"])
    if "tf" in body and int(body["tf"]) in TFS:
        cur["tf"] = int(body["tf"])
    if isinstance(body.get("symbols"), list):
        cur["symbols"] = [str(s).upper().strip() for s in body["symbols"] if str(s).strip()][:6]
    if isinstance(body.get("kinds"), dict):
        cur["kinds"] = {k: bool(body["kinds"].get(k, cur["kinds"][k])) for k in KINDS}
    db.set_kv(KV, cur)
    _state.clear()  # new symbols / timeframe: start fresh (no burst of old events)
    return cur


# ---------------- detection ----------------
def _atr(c: list[dict], n: int = 14) -> list[float]:
    out, a = [], 0.0
    for i, k in enumerate(c):
        tr = k["high"] - k["low"] if i == 0 else max(
            k["high"] - k["low"], abs(k["high"] - c[i - 1]["close"]), abs(k["low"] - c[i - 1]["close"]))
        a = (a * i + tr) / (i + 1) if i < n else (a * (n - 1) + tr) / n
        out.append(a)
    return out


def _swings(c: list[dict], ln: int) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    highs, lows = [], []
    for i in range(ln, len(c) - ln):
        h = all(c[i]["high"] > c[i - k]["high"] and c[i]["high"] >= c[i + k]["high"] for k in range(1, ln + 1))
        lo = all(c[i]["low"] < c[i - k]["low"] and c[i]["low"] <= c[i + k]["low"] for k in range(1, ln + 1))
        if h:
            highs.append((i, c[i]["high"]))
        if lo:
            lows.append((i, c[i]["low"]))
    return highs, lows


def detect(c: list[dict]) -> list[dict]:
    """Every SMC event in these closed candles, oldest first:
    {i, time, kind, dir ("up" = bullish), level / top / bottom, ...}."""
    n = len(c)
    ev: list[dict] = []
    if n < 30:
        return ev
    atr = _atr(c)

    # --- internal pass: sweeps + internal breaks (-> order blocks) ---
    highs, lows = _swings(c, PIVOT)
    hi = lo = None
    hx = lx = 0
    trend = None
    sweeps: list[dict] = []
    obs: list[dict] = []
    for i in range(n):
        while hx < len(highs) and highs[hx][0] + PIVOT <= i:
            hi = highs[hx]
            hx += 1
        while lx < len(lows) and lows[lx][0] + PIVOT <= i:
            lo = lows[lx]
            lx += 1
        k_ = c[i]
        if hi and k_["high"] > hi[1]:
            if k_["close"] < hi[1]:
                sweeps.append({"i": i, "dir": "down", "level": hi[1], "from": hi[0]})
            else:  # a close above it: an internal break up -> the bull order block it leaves
                m = min(range(hi[0], i + 1), key=lambda j: c[j]["low"])
                k = m
                while k > hi[0] and not c[k]["close"] < c[k]["open"]:
                    k -= 1
                if not c[k]["close"] < c[k]["open"]:
                    k = m
                obs.append({"dir": "up", "k": k, "top": c[k]["high"], "bottom": c[k]["low"], "at": i,
                            "choch": trend == "down", "from": hi[0]})
                trend = "up"
            hi = None
        if lo and k_["low"] < lo[1]:
            if k_["close"] > lo[1]:
                sweeps.append({"i": i, "dir": "up", "level": lo[1], "from": lo[0]})
            else:
                m = max(range(lo[0], i + 1), key=lambda j: c[j]["high"])
                k = m
                while k > lo[0] and not c[k]["close"] > c[k]["open"]:
                    k -= 1
                if not c[k]["close"] > c[k]["open"]:
                    k = m
                obs.append({"dir": "down", "k": k, "top": c[k]["high"], "bottom": c[k]["low"], "at": i,
                            "choch": trend == "up", "from": lo[0]})
                trend = "down"
            lo = None
    for s in sweeps:
        ev.append({"i": s["i"], "kind": "sweep", "dir": s["dir"], "level": s["level"]})

    # --- order blocks: the first time price comes back into one (A+ when it closes the setup) ---
    for b in obs:
        up = b["dir"] == "up"
        for j in range(b["at"] + 1, n):
            touched = c[j]["low"] <= b["top"] if up else c[j]["high"] >= b["bottom"]
            if not touched:
                continue
            broken = c[j]["close"] < b["bottom"] if up else c[j]["close"] > b["top"]
            if broken:
                break  # straight through it on the first touch: no alert
            e = {"i": j, "kind": "ob", "dir": b["dir"], "top": b["top"], "bottom": b["bottom"]}
            # A+: a sweep the other way led into this move, the break was an internal CHoCH, and the
            # pullback is into the discount (long) / premium (short) half of the move
            sw = [s for s in sweeps if s["dir"] == b["dir"] and b["from"] <= s["i"] <= b["at"]
                  and b["at"] - s["i"] <= APLUS_BARS and j - b["at"] <= APLUS_BARS]
            if b["choch"] and sw:
                s = sw[-1]
                if up:
                    top = max(x["high"] for x in c[s["i"]: j + 1])
                    eq = (top + s["level"]) / 2
                    ok = b["top"] <= eq
                else:
                    bot = min(x["low"] for x in c[s["i"]: j + 1])
                    eq = (bot + s["level"]) / 2
                    ok = b["bottom"] >= eq
                if ok:
                    e = {**e, "kind": "aplus", "sweep": s["level"], "choch": c[b["from"]]["high" if up else "low"], "eq": eq}
            ev.append(e)
            break

    # --- swing structure: CHoCH (first close through a big swing against the trend) ---
    highs, lows = _swings(c, SWING)
    hi = lo = None
    hx = lx = 0
    trend = None
    for i in range(n):
        while hx < len(highs) and highs[hx][0] + SWING <= i:
            hi = highs[hx]
            hx += 1
        while lx < len(lows) and lows[lx][0] + SWING <= i:
            lo = lows[lx]
            lx += 1
        if hi and c[i]["close"] > hi[1]:
            if trend == "down":
                ev.append({"i": i, "kind": "choch", "dir": "up", "level": hi[1]})
            trend = "up"
            hi = None
        if lo and c[i]["close"] < lo[1]:
            if trend == "up":
                ev.append({"i": i, "kind": "choch", "dir": "down", "level": lo[1]})
            trend = "down"
            lo = None

    for e in ev:
        e["time"] = c[e["i"]]["time"]
    ev.sort(key=lambda e: e["i"])
    return ev


def _p(x: float) -> str:
    return f"{x:,.2f}".rstrip("0").rstrip(".")


def message(sym: str, tf: int, e: dict) -> str:
    t = f"{sym} {tf // 60}m"
    up = e["dir"] == "up"
    if e["kind"] == "sweep":
        return (f"{'▲' if up else '▼'} {t}: liquidity sweep — wick {'below the swing low' if up else 'above the swing high'} "
                f"{_p(e['level'])}, closed back {'above' if up else 'below'} ({'sell' if up else 'buy'}-side stops taken). "
                f"Often a turn {'up' if up else 'down'}; wait for structure to confirm.")
    if e["kind"] == "choch":
        return (f"{'▲' if up else '▼'} {t}: {'bullish' if up else 'bearish'} CHoCH — closed {'above' if up else 'below'} "
                f"the swing {'high' if up else 'low'} {_p(e['level'])}. Possible trend change {'up' if up else 'down'}.")
    if e["kind"] == "ob":
        return (f"{'▲' if up else '▼'} {t}: price back in the {'bull' if up else 'bear'} order block "
                f"{_p(e['bottom'])}–{_p(e['top'])} (first test). Watch for {'support' if up else 'resistance'}.")
    # aplus
    return (f"★ {t}: A+ {'LONG' if up else 'SHORT'} setup — {'sell' if up else 'buy'}-side sweep {_p(e['sweep'])} → "
            f"{'bullish' if up else 'bearish'} CHoCH {_p(e['choch'])} → price back in the "
            f"{'bull' if up else 'bear'} OB {_p(e['bottom'])}–{_p(e['top'])} "
            f"({'discount' if up else 'premium'}, EQ {_p(e['eq'])}). A setup, not a signal: size small, SL beyond the OB.")


async def candles(sym: str, tf: int) -> list[dict]:
    """Closed candles of `tf` seconds for `sym` (the forming one dropped), the last ~400."""
    from . import upstox_data
    from .charting import bucket_start

    raw = await upstox_data.fetch_underlying_candles(sym, tf)
    b: dict[int, dict] = {}
    for x in raw or []:
        k = bucket_start(float(x["time"]), tf)
        cur = b.get(k)
        if cur is None:
            b[k] = {"time": k, "open": x["open"], "high": x["high"], "low": x["low"], "close": x["close"]}
        else:
            cur["high"] = max(cur["high"], x["high"])
            cur["low"] = min(cur["low"], x["low"])
            cur["close"] = x["close"]
    out = [b[k] for k in sorted(b)]
    if out and out[-1]["time"] + tf > time.time():
        out = out[:-1]
    return out[-400:]


async def replay(sym: str, tf: int, days: int = 3) -> list[dict]:
    """What would have alerted over the last `days` sessions (the settings panel's preview)."""
    c = await candles(sym, tf)
    if not c:
        return []
    keep_days = sorted({datetime.fromtimestamp(k["time"], IST).date() for k in c})[-days:]
    out = []
    for e in detect(c):
        if datetime.fromtimestamp(e["time"], IST).date() in keep_days:
            out.append({"time": e["time"], "kind": e["kind"], "dir": e["dir"], "message": message(sym, tf, e)})
    return out


async def tick() -> list[dict]:
    cfg = settings()
    if not cfg["enabled"]:
        return []
    tf = cfg["tf"]
    today = datetime.now(IST).date().isoformat()
    events: list[dict] = []
    for sym in cfg["symbols"]:
        try:
            c = await candles(sym, tf)
        except Exception:  # noqa: BLE001 -- no data (Upstox not connected): try again next minute
            continue
        if len(c) < 40:
            continue
        st = _state.setdefault(sym, {"last": None, "day": today, "n": 0})
        if st["day"] != today:
            st.update(day=today, n=0)
        last = c[-1]["time"]
        if st["last"] is None:  # first look after a start / settings change: no replay of history
            st["last"] = last
            continue
        if last <= st["last"]:
            continue
        new = [e for e in detect(c) if e["time"] > st["last"] and cfg["kinds"].get(e["kind"])]
        st["last"] = last
        for e in new:
            if st["n"] >= MAX_PER_DAY:
                break
            st["n"] += 1
            events.append({
                "kind": "smc", "symbol": sym,
                "severity": "warning" if e["kind"] in ("aplus", "choch") else "info",
                "message": message(sym, tf, e),
            })
    return events
