"""Option-flow tracker: who is buying, who is writing, the direction that adds up to, and when it turns.

For one window (a rolling 5 / 15 / 30 minutes, or "day" = since the previous close) every option leg near the money is
classified by how its PRICE and its OPEN INTEREST moved:

    price up   + OI up      BUYING            (long build-up)
    price down + OI up      WRITING           (short build-up)
    price up   + OI down    SHORT COVERING
    price down + OI down    LONG UNWINDING

Summed over the strikes around the money that gives four flows, in contracts:

    put writing  + call buying   -> bullish
    call writing + put buying    -> bearish        (covering / unwinding are kept and shown but do not move the
                                                    bias: they are exits, not new positions)
    bias = (bullish - bearish) / (bullish + bearish)        -1 .. +1

Option prices follow the spot, so in a range-bound market the same classification flips with every wiggle. A direction
is therefore only called when the market has really MOVED over the window (MOVE_MIN_PCT of spot); a flat market is MIXED
however lopsided the flows look (the lean is still reported). Then a small state machine turns the bias into
BULL / BEAR / MIXED -- smoothed, with hysteresis and a confirmation delay so it does not flicker -- and every confirmed
change is an event. A bull <-> bear flip is a REVERSAL, the only event
that alerts. The leader (the biggest of the four flows) is tracked for the banner; a decisive change of SIDE is logged.

Inputs are chain snapshots (`record`, called by the poller). The classification is an inference from price x OI, not
trade-side data. Pure functions where possible; `now` is a parameter so it can be tested.
"""
from __future__ import annotations

import threading
import time
from collections import OrderedDict, deque
from datetime import datetime
from zoneinfo import ZoneInfo

from .history_archive import in_session

IST = ZoneInfo("Asia/Kolkata")

WINDOWS = (5, 15, 30)                      # rolling minutes
DAY = "day"                                # since the previous close (the chain's own change fields)
WINDOW_KEYS = tuple(str(w) for w in WINDOWS) + (DAY,)
DEFAULT_WINDOW = "15"                      # the one that alerts

NEAR_STRIKES = 8                           # ATM +- this many strikes
SAMPLE_S = 55.0                            # one sample a minute per (symbol, expiry)
SNAP_KEEP_S = (max(WINDOWS) + 10) * 60.0   # snapshots kept for the rolling baselines
BASE_TOL_S = 90.0                          # a baseline further than this from "W minutes ago" is stale (feed gap)
MIN_FLOW_PCT = 0.001                       # flow smaller than 0.1% of the chain's OI is too quiet to call
MIN_LEG_OI_PCT = 0.0002                    # a leg's OI move under 0.02% of its own OI is reporting noise
PX_EPS_ABS, PX_EPS_PCT = 0.05, 0.002       # a price move under one tick / 0.2% is "flat" (cannot classify)

MOVE_MIN_PCT = {"5": 0.0007, "15": 0.0010, "30": 0.0015, DAY: 0.0030}   # spot move (fraction) that makes a direction real
OPEN_SPOT_WITHIN_S = 20 * 60               # the DAY window's reference is the spot recorded in the first 20 min of the session
ENTER, EXIT = 0.25, 0.10                   # smoothed bias needed to call BULL/BEAR, and to drop back to MIXED
SMOOTH_N = 3                               # samples averaged into the smoothed bias
CONFIRM_N = 3                              # consecutive samples a new state must hold before it is real
LEAD_MARGIN = 1.2                          # a new leader must beat the old one by 20% to take over the banner ...
LEAD_EVENT_MARGIN = 1.5                    # ... and by 50% to be LOGGED, which it only is when it crosses sides
LEAD_GAP_S = 900.0                         # (bullish leader <-> bearish leader), at most one every 15 minutes
REV_GAP_S = 1800.0                         # BULL -> MIXED -> BEAR inside this still counts as one reversal

SERIES_MAX, EVENTS_MAX, BOOKS_MAX = 420, 80, 60
KEEP_STRIKES = NEAR_STRIKES + 6            # a stored snapshot keeps this many strikes either side of the spot (memory)
SERIES_FIELDS = ("t", "spot", "bias", "raw", "sm", "st", "pw", "cw", "cb", "pb")   # series points are stored as tuples
ALERT_SYMBOLS = frozenset({"NIFTY", "BANKNIFTY"})

LABELS = {
    "pw": "Put writing", "cw": "Call writing", "cb": "Call buying", "pb": "Put buying",
    "cs": "Call short covering", "ps": "Put short covering", "cu": "Call long unwinding", "pu": "Put long unwinding",
}
PRIMARY = ("pw", "cb", "cw", "pb")
BULL_KEYS, BEAR_KEYS = ("pw", "cb"), ("cw", "pb")
_KEY = {
    ("CE", "buy"): "cb", ("CE", "write"): "cw", ("CE", "cover"): "cs", ("CE", "unwind"): "cu",
    ("PE", "buy"): "pb", ("PE", "write"): "pw", ("PE", "cover"): "ps", ("PE", "unwind"): "pu",
}
DIR_WORD = {"bull": "BULLISH", "bear": "BEARISH", "mixed": "MIXED"}
_OPP = {"bull": "bear", "bear": "bull"}

_LOCK = threading.RLock()
_BOOKS: "OrderedDict[tuple[str, str], Book]" = OrderedDict()


# --------------------------------------------------------------------------- #
# classification + aggregation (pure)                                          #
# --------------------------------------------------------------------------- #
def classify(d_oi: float, d_px: float, oi_base: float, px_ref: float) -> str | None:
    """'buy' | 'write' | 'cover' | 'unwind' -- or None when either move is too small to mean anything."""
    if not d_oi or abs(d_oi) < MIN_LEG_OI_PCT * max(oi_base, 1.0):
        return None
    if abs(d_px) < max(PX_EPS_ABS, PX_EPS_PCT * abs(px_ref)):
        return None
    if d_oi > 0:
        return "buy" if d_px > 0 else "write"
    return "cover" if d_px > 0 else "unwind"


def compute_flow(cur: dict, base: dict, spot: float, total_oi: float) -> dict:
    """`cur` / `base`: {strike: (ceOi, peOi, ceLtp, peLtp)}. Only the NEAR_STRIKES either side of the money count.
    Returns the eight flows (contracts), the biggest strike per flow, the bias (None when too quiet) and every leg."""
    both = [k for k in cur if k in base]
    near = sorted(sorted(both, key=lambda k: abs(k - spot))[: 2 * NEAR_STRIKES + 1])
    flows = {k: 0.0 for k in LABELS}
    top: dict[str, tuple[float, float]] = {}
    legs: list[dict] = []
    for k in near:
        c, b = cur[k], base[k]
        for side, i_oi, i_px in (("CE", 0, 2), ("PE", 1, 3)):
            d_oi, d_px = c[i_oi] - b[i_oi], c[i_px] - b[i_px]
            cls = classify(d_oi, d_px, b[i_oi], b[i_px])
            key = _KEY[(side, cls)] if cls else None
            if key:
                flows[key] += abs(d_oi)
                if abs(d_oi) > top.get(key, (0.0, 0.0))[1]:
                    top[key] = (k, abs(d_oi))
            legs.append({"strike": k, "side": side, "oi": c[i_oi], "ltp": c[i_px], "dOi": d_oi, "dPx": d_px, "key": key})
    bull = sum(flows[k] for k in BULL_KEYS)
    bear = sum(flows[k] for k in BEAR_KEYS)
    total = bull + bear
    min_flow = MIN_FLOW_PCT * max(total_oi, 0.0)
    bias = (bull - bear) / total if total > 0 and total >= min_flow else None
    return {"flows": flows, "top": top, "bias": bias, "bull": bull, "bear": bear, "total": total,
            "minFlow": min_flow, "legs": legs}


def gate(flow: dict, move: float | None, spot: float, window: str) -> dict:
    """Apply the movement gate to a compute_flow result (in place): `raw` keeps the flows' own lean, `bias` is what the
    state machine sees -- 0.0 when the market has not moved enough over the window for the flows to mean a direction.
    `move` None (no reference price, e.g. after a mid-day restart) leaves the bias ungated."""
    raw = flow["bias"]
    flow["raw"], flow["move"], flow["needMove"], flow["flat"] = raw, move, MOVE_MIN_PCT[window] * spot, False
    if raw is not None and move is not None and abs(move) < flow["needMove"]:
        flow["bias"], flow["flat"] = 0.0, True
    return flow


def _target(sm: float, cur: str | None) -> str:
    """The state a smoothed bias points at, with hysteresis (a held BULL/BEAR lasts until |bias| decays under EXIT)."""
    if sm >= ENTER:
        return "bull"
    if sm <= -ENTER:
        return "bear"
    if cur == "bull" and sm > EXIT:
        return "bull"
    if cur == "bear" and sm < -EXIT:
        return "bear"
    return "mixed"


def _fmt_l(x: float) -> str:
    return f"{x / 1e5:+.1f}L"


def _drivers_of(flow: dict, keys: tuple, n: int = 2) -> list[dict]:
    """The biggest legs among the given flow keys, biggest OI move first."""
    legs = [lg for lg in flow["legs"] if lg["key"] in keys]
    legs.sort(key=lambda lg: -abs(lg["dOi"]))
    return [{"strike": lg["strike"], "side": lg["side"], "label": LABELS[lg["key"]], "dOi": lg["dOi"]} for lg in legs[:n]]


def _drivers(flow: dict, to: str, n: int = 2) -> list[dict]:
    """The legs that carried the new direction: put writing / call buying for BULL, call writing / put buying for BEAR."""
    return _drivers_of(flow, BULL_KEYS if to == "bull" else BEAR_KEYS if to == "bear" else PRIMARY, n)


def _drivers_text(drivers: list[dict]) -> str:
    return ", ".join(f"{d['label'].lower()} {d['strike']:g} {d['side']} {_fmt_l(d['dOi'])}" for d in drivers)


# --------------------------------------------------------------------------- #
# the state machine, one per (symbol, expiry, window)                          #
# --------------------------------------------------------------------------- #
class Tracker:
    def __init__(self, key: str):
        self.key = key
        self.series: deque = deque(maxlen=SERIES_MAX)
        self.events: deque = deque(maxlen=EVENTS_MAX)        # newest first
        self.state: str | None = None
        self.since: float | None = None
        self.bias: float | None = None                       # smoothed
        self.leader: str | None = None
        self.last: dict | None = None                        # the latest compute_flow result
        self._recent: deque = deque(maxlen=SMOOTH_N)
        self._pend: tuple[str | None, int] = (None, 0)
        self._lead_pend: tuple[str | None, int] = (None, 0)
        self._lead_at = 0.0
        self.last_dir: str | None = None                     # the last real direction (bull / bear) we left ...
        self.last_dir_start = self.last_dir_end = 0.0        # ... and when it started / ended

    # a sample with no reading (window not covered yet): keep the spot line, say nothing about flow
    def no_reading(self, t: float, spot: float) -> None:
        self.series.append((t, spot, None, None, None, self.state, 0, 0, 0, 0))

    def update(self, t: float, spot: float, flow: dict) -> list[dict]:
        events: list[dict] = []
        self.last = flow
        b = flow["bias"]
        if b is not None:
            self._recent.append(b)
        sm = sum(self._recent) / len(self._recent) if self._recent else None

        if b is not None and len(self._recent) >= min(2, SMOOTH_N):
            self.bias = sm
            tgt = _target(sm, self.state)
            if tgt == self.state:
                self._pend = (None, 0)
            else:
                self._pend = (tgt, self._pend[1] + 1 if self._pend[0] == tgt else 1)
                if self._pend[1] >= CONFIRM_N:
                    events.append(self._switch(t, spot, tgt, flow))

        events += self._lead(t, spot, flow)
        f = flow["flows"]
        self.series.append((
            t, spot, None if b is None else round(b, 3), None if flow.get("raw") is None else round(flow["raw"], 3),
            None if self.bias is None or b is None else round(self.bias, 3), self.state,
            round(f["pw"]), round(f["cw"]), round(f["cb"]), round(f["pb"])))
        return events

    def _switch(self, t: float, spot: float, tgt: str, flow: dict) -> dict:
        """Record a confirmed change of state. A real flip almost always passes through a short MIXED stretch
        (the window blends the old flow with the new), so BULL -> MIXED -> BEAR within REV_GAP_S still counts as
        ONE reversal, reported from the direction that was lost."""
        old = self.state
        frm = old
        held = (t - self.since) / 60.0 if (self.since and old in _OPP) else None
        if old is None:
            kind = "start"
        elif tgt == "mixed":
            kind = "fade"
        elif _OPP.get(old) == tgt:
            kind = "reversal"
        elif self.last_dir and _OPP[self.last_dir] == tgt and t - self.last_dir_end <= REV_GAP_S:
            kind, frm = "reversal", self.last_dir
            held = (self.last_dir_end - self.last_dir_start) / 60.0
        else:
            kind = "turn"
        if old in _OPP:                                   # leaving a real direction: remember it
            self.last_dir, self.last_dir_start, self.last_dir_end = old, self.since or t, t
        self.state, self.since, self._pend = tgt, t, (None, 0)
        drivers = _drivers(flow, tgt)
        lead = DIR_WORD[tgt] + (f" ({_drivers_text(drivers)})" if drivers else "")
        text = {"start": f"Tracking started: {lead}",
                "reversal": f"REVERSAL {DIR_WORD.get(frm or '', '')} → {lead}",
                "fade": f"Direction faded to MIXED (was {DIR_WORD.get(old or '', '')})",
                "turn": f"Turned {lead}"}[kind]
        ev = {"t": t, "kind": kind, "from": frm, "to": tgt, "bias": round(self.bias or 0.0, 3), "spot": spot,
              "window": self.key, "heldMin": None if held is None else round(held, 1), "drivers": drivers, "text": text}
        self.events.appendleft(ev)
        return ev

    def _lead(self, t: float, spot: float, flow: dict) -> list[dict]:
        """The biggest of the four flows changing hands. The banner follows every change (margin + confirmation); the log only
        records a decisive change of SIDE, with a cool-down, so a range-bound market does not flood it."""
        if flow["bias"] is None or flow.get("flat"):        # too quiet, or the market has not moved: who "leads" is noise
            self._lead_pend = (None, 0)
            return []
        f = flow["flows"]
        top = max(PRIMARY, key=lambda k: f[k])
        if self.leader is None:
            self.leader = top
            return []
        if top == self.leader or f[top] < LEAD_MARGIN * max(f[self.leader], 1e-9):
            self._lead_pend = (None, 0)
            return []
        self._lead_pend = (top, self._lead_pend[1] + 1 if self._lead_pend[0] == top else 1)
        if self._lead_pend[1] < CONFIRM_N:
            return []
        old, self.leader, self._lead_pend = self.leader, top, (None, 0)
        if (old in BULL_KEYS) == (top in BULL_KEYS) or f[top] < LEAD_EVENT_MARGIN * max(f[old], 1e-9) or t - self._lead_at < LEAD_GAP_S:
            return []                                     # same side, or not decisive, or too soon: the banner moves, the log stays quiet
        self._lead_at = t
        ev = {"t": t, "kind": "lead", "from": None, "to": None, "bias": round(self.bias or 0.0, 3), "spot": spot,
              "window": self.key, "heldMin": None, "drivers": _drivers_of(flow, (top,), 1),
              "leadFrom": old, "leadTo": top,
              "text": f"Lead changed: {LABELS[old]} → {LABELS[top]} ({_fmt_l(f[top])} vs {_fmt_l(f[old])})"}
        self.events.appendleft(ev)
        return [ev]


# --------------------------------------------------------------------------- #
# per (symbol, expiry)                                                         #
# --------------------------------------------------------------------------- #
class Book:
    def __init__(self, symbol: str, expiry: str, now: float):
        self.symbol, self.expiry, self.first_t = symbol, expiry, now
        self.day = _day_of(now)
        self.snaps: deque = deque()                         # (t, {strike: (ceOi, peOi, ceLtp, peLtp)}, spot)
        self.open_spot: float | None = None                 # the DAY window's reference (spot early in the session)
        self.last_sample = 0.0
        self.trackers = {k: Tracker(k) for k in WINDOW_KEYS}


def _day_of(t: float) -> str:
    return datetime.fromtimestamp(t, IST).strftime("%Y-%m-%d")


def _snap_of(chain: dict) -> dict:
    """{strike: (ceOi, peOi, ceLtp, peLtp)} for the KEEP_STRIKES either side of the spot (the rest is never read)."""
    spot = float(chain.get("spot") or 0.0)
    rows = sorted(chain.get("rows") or [], key=lambda r: abs(float(r["strike"]) - spot))[: 2 * KEEP_STRIKES + 1]
    out = {}
    for r in rows:
        c, p = r.get("call") or {}, r.get("put") or {}
        out[float(r["strike"])] = (float(c.get("oi") or 0), float(p.get("oi") or 0),
                                   float(c.get("ltp") or 0), float(p.get("ltp") or 0))
    return out


def _day_base(chain: dict) -> dict:
    """The previous close, rebuilt from the chain's own change fields (OI change and price change vs yesterday)."""
    out = {}
    for r in chain.get("rows") or []:
        c, p = r.get("call") or {}, r.get("put") or {}
        out[float(r["strike"])] = (
            float(c.get("oi") or 0) - float(c.get("oiChg") or 0), float(p.get("oi") or 0) - float(p.get("oiChg") or 0),
            float(c.get("ltp") or 0) - float(c.get("chg") or 0), float(p.get("ltp") or 0) - float(p.get("chg") or 0))
    return out


def _baseline(snaps, target: float):
    """The stored (snapshot, spot) nearest to `target`, or None when even the nearest is stale (a feed gap)."""
    best, gap = None, 1e18
    for t, s, sp in snaps:
        g = abs(t - target)
        if g < gap:
            best, gap = (s, sp), g
    return best if gap <= BASE_TOL_S else None


def record(symbol: str, expiry: str, chain: dict | None, now: float | None = None) -> list[dict]:
    """Feed one chain snapshot. At most one sample a minute per (symbol, expiry), in session only.
    Returns the events this sample produced (every window)."""
    now = time.time() if now is None else now
    if not chain or not chain.get("rows") or not in_session(now):
        return []
    key = (symbol.upper(), expiry)
    with _LOCK:
        bk = _BOOKS.get(key)
        if bk is None or bk.day != _day_of(now):
            bk = Book(key[0], expiry, now)
            _BOOKS[key] = bk
            while len(_BOOKS) > BOOKS_MAX:
                _BOOKS.popitem(last=False)
        else:
            _BOOKS.move_to_end(key)
        if now - bk.last_sample < SAMPLE_S:
            return []
        cur = _snap_of(chain)
        if not cur:
            return []
        bk.last_sample = now
        spot = float(chain.get("spot") or 0.0)
        tot = chain.get("totals") or {}
        total_oi = float(tot.get("ceOI") or 0) + float(tot.get("peOI") or 0)
        bk.snaps.append((now, cur, spot))
        while bk.snaps and now - bk.snaps[0][0] > SNAP_KEEP_S:
            bk.snaps.popleft()
        if bk.open_spot is None and spot > 0:
            dt = datetime.fromtimestamp(now, IST)
            if (dt.hour * 3600 + dt.minute * 60 + dt.second) - (9 * 3600 + 15 * 60) <= OPEN_SPOT_WITHIN_S:
                bk.open_spot = spot
        events: list[dict] = []
        for w in WINDOWS:
            base = _baseline(bk.snaps, now - w * 60)
            tr = bk.trackers[str(w)]
            if base is None:
                tr.no_reading(now, spot)
            else:
                fl = gate(compute_flow(cur, base[0], spot, total_oi), spot - base[1] if base[1] > 0 else None, spot, str(w))
                events += tr.update(now, spot, fl)
        fl = gate(compute_flow(cur, _day_base(chain), spot, total_oi),
                  spot - bk.open_spot if bk.open_spot else None, spot, DAY)
        events += bk.trackers[DAY].update(now, spot, fl)
        return events


def due(symbol: str, expiry: str, now: float | None = None) -> bool:
    """Would `record` take a sample now? Lets the caller skip fetching the chain the other 54 seconds of the minute."""
    now = time.time() if now is None else now
    if not in_session(now):
        return False
    with _LOCK:
        bk = _BOOKS.get((symbol.upper(), expiry))
        return bk is None or bk.day != _day_of(now) or now - bk.last_sample >= SAMPLE_S


def alert_for(symbol: str, ev: dict) -> dict | None:
    """The alert (a store.add_alert dict) a reversal deserves, else None. Only the default window on the alert
    symbols alerts; the caller adds the nearest-expiry and de-duplication checks."""
    if ev.get("kind") != "reversal" or ev.get("window") != DEFAULT_WINDOW or symbol.upper() not in ALERT_SYMBOLS:
        return None
    held = ev.get("heldMin")
    was = DIR_WORD.get(ev.get("from") or "", "")
    msg = (f"{symbol.upper()} option flow REVERSED to {DIR_WORD[ev['to']]}"
           + (f" (was {was.lower()} for {held:.0f} min)" if held is not None else "")
           + (f": {_drivers_text(ev['drivers'])}" if ev.get("drivers") else "")
           + f" · spot {ev['spot']:,.0f}")
    return {"ts": ev["t"], "symbol": symbol.upper(), "kind": "flow-reversal", "severity": "warning", "message": msg, "score": 0}


# --------------------------------------------------------------------------- #
# the read side                                                                #
# --------------------------------------------------------------------------- #
def _empty_view(symbol: str, expiry: str, window: str, spot: float | None) -> dict:
    return {"symbol": symbol.upper(), "expiry": expiry, "window": window, "windows": list(WINDOW_KEYS), "spot": spot,
            "asOf": None, "trackingSince": None, "coverageMin": 0.0, "warming": window != DAY, "warmupMin": _wmin(window),
            "quiet": False, "lean": None, "move": None, "needMove": 0.0, "flat": False,
            "state": {"dir": None, "since": None, "heldMin": None, "bias": None, "strength": None, "leader": None},
            "flows": {k: 0 for k in LABELS}, "bull": 0, "bear": 0, "top": {}, "series": [], "events": [], "strikes": []}


def _wmin(window: str) -> int:
    return int(window) if window.isdigit() else 0


def view(symbol: str, expiry: str, window: str = DEFAULT_WINDOW, spot: float | None = None,
         now: float | None = None) -> dict:
    """Everything the Flow tab draws, for one (symbol, expiry, window)."""
    now = time.time() if now is None else now
    window = window if window in WINDOW_KEYS else DEFAULT_WINDOW
    with _LOCK:
        bk = _BOOKS.get((symbol.upper(), expiry))
        if bk is None:
            return _empty_view(symbol, expiry, window, spot)
        tr = bk.trackers[window]
        out = _empty_view(symbol, expiry, window, spot)
        last = tr.series[-1] if tr.series else None
        out["spot"] = last[1] if last else spot
        out["asOf"] = bk.last_sample
        out["trackingSince"] = bk.first_t
        out["coverageMin"] = round((bk.snaps[-1][0] - bk.snaps[0][0]) / 60.0, 1) if bk.snaps else 0.0
        fl = tr.last
        out["warming"] = fl is None and window != DAY
        if fl is not None:
            out["flows"] = {k: round(v) for k, v in fl["flows"].items()}
            out["bull"], out["bear"] = round(fl["bull"]), round(fl["bear"])
            out["quiet"] = fl["bias"] is None
            out["lean"] = None if fl.get("raw") is None else round(fl["raw"], 3)
            out["move"] = None if fl.get("move") is None else round(fl["move"], 2)
            out["needMove"] = round(fl.get("needMove") or 0.0, 2)
            out["flat"] = bool(fl.get("flat"))
            out["top"] = {k: {"strike": s, "chg": round(v)} for k, (s, v) in fl["top"].items()}
            by: dict[float, dict] = {}
            for lg in fl["legs"]:
                row = by.setdefault(lg["strike"], {"strike": lg["strike"], "atm": False})
                row["ce" if lg["side"] == "CE" else "pe"] = {
                    "key": lg["key"], "label": LABELS.get(lg["key"] or "", None), "dOi": round(lg["dOi"]),
                    "dPx": round(lg["dPx"], 2), "oi": round(lg["oi"]), "ltp": round(lg["ltp"], 2)}
            if by:
                ref = out["spot"] or 0.0
                atm = min(by, key=lambda k: abs(k - ref))
                by[atm]["atm"] = True
            out["strikes"] = [by[k] for k in sorted(by)]
        st = out["state"]
        st["dir"], st["since"] = tr.state, tr.since
        st["heldMin"] = round((now - tr.since) / 60.0, 1) if tr.since else None
        st["bias"] = None if tr.bias is None else round(tr.bias, 3)
        st["strength"] = None if tr.bias is None else round(min(abs(tr.bias), 1.0) * 100)
        st["leader"] = tr.leader
        out["series"] = [dict(zip(SERIES_FIELDS, p)) for p in tr.series]
        out["events"] = list(tr.events)
        return out


def reset() -> None:
    """Forget everything (tests)."""
    with _LOCK:
        _BOOKS.clear()
