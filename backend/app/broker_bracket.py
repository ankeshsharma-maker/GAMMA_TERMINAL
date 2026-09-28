"""Portfolio-level auto square-off for live broker positions.

Arm an SL (rupee loss) and/or a Target (rupee profit).  Every poller loop we
read the broker PositionBook, add up the P&L, and if it breaches either
threshold we flatten every open position with opposite-side MARKET orders,
then disarm.  Runs server-side so it works even with the app closed.

Profit Guard (the "I was in profit and it slipped away" part), all measured off the day's peak:
  * lock: once the peak reaches `lockAfter`, keep at least `lockPct`% of it (0 = breakeven);
  * giveback: exit once P&L falls `givebackPct`% below the peak;
  * warn: an alert (no orders) once P&L has given back `warnPct`% of the peak -- once per peak;
  * action "alert" instead of "squareoff": a hit only alerts (re-arming if P&L recovers above
    the level) -- nothing is sold or bought.

State: kv_store key "broker_bracket"
"""
from __future__ import annotations

import time

from . import db

_KV_KEY = "broker_bracket"

_DEFAULT = {
    "enabled": False,
    "slAmount": 0.0,      # arm a stop when P&L <= -slAmount  (0 = off)
    "targetAmount": 0.0,  # arm a target when P&L >= targetAmount (0 = off)
    "trailAmount": 0.0,   # once armed, stop rises with the peak P&L and
                           # fires if P&L falls trailAmount off that peak (0 = off)
    "floorAmount": 0.0,   # fixed absolute P&L floor — fires if P&L ever drops
                           # to/below this exact rupee level, regardless of
                           # where the peak ends up (0 = off)
    "lockAfter": 0.0,     # Profit Guard: once the peak reaches this (Rs) ...
    "lockPct": 0.0,       # ... keep at least this % of the peak (0 = breakeven)
    "givebackPct": 0.0,   # exit once P&L is this % below its peak (0 = off)
    "warnPct": 0.0,       # alert (no orders) once this % of the peak has been given back (0 = off)
    "action": "squareoff",  # "squareoff" = flatten everything | "alert" = only tell me
    "basis": "today",     # "today" = MTM + realised, "mtm" = open MTM only
    "warnedPeak": None,   # the peak the last give-back warning was about (one warning per peak)
    "tripped": False,     # alert mode: the stop was hit and alerted; re-arms once P&L recovers
    "armedAt": None,
    "triggeredAt": None,
    "lastReason": "",
    "lastPnl": None,
    "peakPnl": None,       # highest P&L seen since arming (trail anchor)
}


def _load() -> dict:
    return {**_DEFAULT, **(db.get_kv(_KV_KEY) or {})}


def _save(cfg: dict) -> None:
    db.set_kv(_KV_KEY, cfg)


def get() -> dict:
    return _load()


def set_cfg(patch: dict) -> dict:
    cfg = _load()
    for k in ("slAmount", "targetAmount", "trailAmount", "floorAmount", "lockAfter", "lockPct", "givebackPct", "warnPct"):
        if k in patch:
            try:
                cfg[k] = max(0.0, float(patch[k] or 0))
            except (TypeError, ValueError):
                cfg[k] = 0.0
    for k in ("lockPct", "givebackPct", "warnPct"):
        cfg[k] = min(cfg[k], 99.0 if k != "lockPct" else 100.0)
    if patch.get("action") in ("squareoff", "alert"):
        cfg["action"] = patch["action"]
    if "basis" in patch and patch["basis"] in ("today", "mtm"):
        cfg["basis"] = patch["basis"]
    if "enabled" in patch:
        cfg["enabled"] = bool(patch["enabled"])
        if cfg["enabled"]:
            cfg["armedAt"] = time.time()
            cfg["triggeredAt"] = None
            cfg["lastReason"] = ""
            cfg["peakPnl"] = None
            cfg["warnedPeak"] = None
            cfg["tripped"] = False
    _save(cfg)
    return cfg


def _guard_on(cfg: dict) -> bool:
    return any((cfg.get(k) or 0) > 0 for k in ("lockAfter", "givebackPct", "warnPct"))


def _min_peak(cfg: dict) -> float:
    """% rules only mean something once there is a real profit to protect (50% of a ₹60 peak is noise)."""
    return max(float(cfg.get("lockAfter") or 0), 1000.0)


def clear() -> dict:
    cfg = dict(_DEFAULT)
    _save(cfg)
    return cfg


def _num(v) -> float:
    try:
        x = float(v)
        return x if x == x else 0.0  # drop NaN
    except (TypeError, ValueError):
        return 0.0


async def tick() -> list[dict]:
    """Check the armed bracket against live broker P&L. Returns alert events."""
    cfg = _load()
    if not cfg.get("enabled"):
        return []
    if not (
        cfg.get("slAmount", 0) > 0
        or cfg.get("targetAmount", 0) > 0
        or cfg.get("trailAmount", 0) > 0
        or cfg.get("floorAmount", 0) > 0
        or _guard_on(cfg)
    ):
        return []

    from .brokers import get_broker

    broker = get_broker()
    if not getattr(broker, "authed", False):
        return []

    try:
        rows = await broker.positions()
    except Exception:  # noqa: BLE001
        return []

    mtm = 0.0
    realised = 0.0
    open_rows: list[dict] = []
    for r in rows or []:
        m = _num(r.get("urmtom")) or _num(r.get("mtm"))
        mtm += m
        realised += _num(r.get("rpnl"))
        if int(round(_num(r.get("netqty")))) != 0:
            open_rows.append(r)

    pnl = mtm + realised if cfg["basis"] == "today" else mtm
    cfg["lastPnl"] = round(pnl, 2)

    trail_amt = cfg.get("trailAmount", 0) or 0
    floor_amt = cfg.get("floorAmount", 0) or 0
    if trail_amt > 0 or floor_amt > 0 or _guard_on(cfg):
        cfg["peakPnl"] = max(cfg["peakPnl"], pnl) if cfg.get("peakPnl") is not None else pnl
    peak = cfg.get("peakPnl")
    events: list[dict] = []

    # ---- Profit Guard levels, all off the peak
    lock_level = give_level = None
    if peak is not None and cfg.get("lockAfter", 0) > 0 and peak >= cfg["lockAfter"]:
        lock_level = round(peak * (cfg.get("lockPct") or 0) / 100.0, 2)   # 0% = breakeven
    if peak is not None and cfg.get("givebackPct", 0) > 0 and peak >= _min_peak(cfg):
        give_level = round(peak * (1 - cfg["givebackPct"] / 100.0), 2)
    # the early warning: alert only, once per new peak
    if (peak is not None and cfg.get("warnPct", 0) > 0 and peak >= _min_peak(cfg)
            and pnl <= peak * (1 - cfg["warnPct"] / 100.0)
            and (cfg.get("warnedPeak") is None or peak > cfg["warnedPeak"])):
        cfg["warnedPeak"] = peak
        gave = peak - pnl
        nxt = max([v for v in (lock_level, give_level) if v is not None], default=None)
        events.append({
            "kind": "profit-guard", "severity": "warning",
            "message": (f"🟠 Profit slipping — your positions peaked at ₹{peak:,.0f} today, now ₹{pnl:,.0f} "
                        f"(gave back ₹{gave:,.0f}, {gave / peak * 100:.0f}%)."
                        + (f" Profit Guard {'exits' if cfg.get('action') != 'alert' else 'alerts'} at ₹{nxt:,.0f}." if nxt is not None else "")),
        })

    fixed_level = -cfg["slAmount"] if cfg["slAmount"] > 0 else None
    trail_level = (cfg["peakPnl"] - trail_amt) if (trail_amt > 0 and cfg.get("peakPnl") is not None) else None
    # the floor only arms once P&L has actually risen above it -- otherwise a
    # floor set at +4000 would fire immediately while still down/at breakeven
    floor_level = (
        floor_amt if (floor_amt > 0 and cfg.get("peakPnl") is not None and cfg["peakPnl"] > floor_amt) else None
    )
    levels = [v for v in (fixed_level, trail_level, floor_level, lock_level, give_level) if v is not None]
    stop_level = max(levels) if levels else None
    cfg["stopLevel"] = stop_level

    hit_sl = stop_level is not None and pnl <= stop_level
    hit_tgt = cfg["targetAmount"] > 0 and pnl >= cfg["targetAmount"]
    if cfg.get("action") == "alert" and cfg.get("tripped"):
        # alert mode already told the user; re-arm once P&L is back above the level (with a little room)
        if not hit_tgt and (stop_level is None or pnl > stop_level + max(100.0, abs(stop_level) * 0.05)):
            cfg["tripped"] = False
        _save(cfg)
        return events
    if not (hit_sl or hit_tgt):
        _save(cfg)
        return events

    is_trail = hit_sl and trail_level is not None and stop_level == trail_level
    is_floor = hit_sl and not is_trail and floor_level is not None and stop_level == floor_level
    is_lock = hit_sl and not (is_trail or is_floor) and lock_level is not None and stop_level == lock_level
    is_give = hit_sl and not (is_trail or is_floor or is_lock) and give_level is not None and stop_level == give_level
    kind = ("TARGET" if hit_tgt else "TRAIL" if is_trail else "FLOOR" if is_floor
            else "PROFIT LOCK" if is_lock else "GIVEBACK" if is_give else "SL")
    if cfg.get("action") == "alert":
        # only tell -- nothing is sold or bought
        cfg["tripped"] = True
        what = ("target reached" if hit_tgt else
                f"profit fell to ₹{pnl:,.0f}, below your guard level ₹{stop_level:,.0f}"
                + (f" (peak ₹{peak:,.0f})" if peak is not None else ""))
        msg = f"🔴 Profit Guard ({kind}) — {what}. Exit now? (alert only: nothing was sold)"
        cfg["lastReason"] = msg
        _save(cfg)
        return events + [{"kind": "profit-guard", "severity": "critical", "message": msg}]
    # flatten every open position
    squared = 0
    for r in open_rows:
        net = int(round(_num(r.get("netqty"))))
        if not net:
            continue
        side = "SELL" if net > 0 else "BUY"
        try:
            await broker.place_order(
                exch=r.get("exch") or "NFO",
                tsym=r.get("tsym"),
                qty=abs(net),
                side=side,
                order_type="MKT",
                price=0.0,
                product=r.get("prd") or "M",
            )
            squared += 1
        except Exception as exc:  # noqa: BLE001
            cfg["lastReason"] = f"{kind} hit but a square-off order failed: {exc}"

    cfg["enabled"] = False
    cfg["triggeredAt"] = time.time()
    if is_trail:
        thresh = f"≤ ₹{stop_level:.0f} (₹{trail_amt:.0f} off peak ₹{cfg['peakPnl']:.0f})"
    elif is_floor:
        thresh = f"≤ ₹{cfg['floorAmount']:.0f} (fixed profit floor)"
    elif is_lock:
        thresh = f"≤ ₹{stop_level:.0f} (kept {cfg.get('lockPct') or 0:g}% of the ₹{peak:.0f} peak)"
    elif is_give:
        thresh = f"≤ ₹{stop_level:.0f} (gave back {cfg.get('givebackPct') or 0:g}% of the ₹{peak:.0f} peak)"
    elif hit_sl:
        thresh = f"≤ −₹{cfg['slAmount']:.0f}"
    else:
        thresh = f"≥ ₹{cfg['targetAmount']:.0f}"
    reason = f"{kind} hit — broker P&L ₹{pnl:.0f} ({thresh}); flattened {squared} position(s)"
    cfg["lastReason"] = reason
    cfg["peakPnl"] = None
    _save(cfg)
    return events + [{"kind": "broker-bracket", "message": reason}]
