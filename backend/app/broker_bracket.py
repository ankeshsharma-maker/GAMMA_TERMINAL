"""Portfolio-level auto square-off for live broker positions.

Arm an SL (rupee loss) and/or a Target (rupee profit).  Every poller loop we
read the broker PositionBook, add up the P&L, and if it breaches either
threshold we flatten every open position with opposite-side MARKET orders,
then disarm.  Runs server-side so it works even with the app closed.

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
    "basis": "today",     # "today" = MTM + realised, "mtm" = open MTM only
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
    for k in ("slAmount", "targetAmount", "trailAmount", "floorAmount"):
        if k in patch:
            try:
                cfg[k] = max(0.0, float(patch[k] or 0))
            except (TypeError, ValueError):
                cfg[k] = 0.0
    if "basis" in patch and patch["basis"] in ("today", "mtm"):
        cfg["basis"] = patch["basis"]
    if "enabled" in patch:
        cfg["enabled"] = bool(patch["enabled"])
        if cfg["enabled"]:
            cfg["armedAt"] = time.time()
            cfg["triggeredAt"] = None
            cfg["lastReason"] = ""
            cfg["peakPnl"] = None
    _save(cfg)
    return cfg


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
    if trail_amt > 0 or floor_amt > 0:
        cfg["peakPnl"] = max(cfg["peakPnl"], pnl) if cfg.get("peakPnl") is not None else pnl

    fixed_level = -cfg["slAmount"] if cfg["slAmount"] > 0 else None
    trail_level = (cfg["peakPnl"] - trail_amt) if (trail_amt > 0 and cfg.get("peakPnl") is not None) else None
    # the floor only arms once P&L has actually risen above it -- otherwise a
    # floor set at +4000 would fire immediately while still down/at breakeven
    floor_level = (
        floor_amt if (floor_amt > 0 and cfg.get("peakPnl") is not None and cfg["peakPnl"] > floor_amt) else None
    )
    levels = [v for v in (fixed_level, trail_level, floor_level) if v is not None]
    stop_level = max(levels) if levels else None

    hit_sl = stop_level is not None and pnl <= stop_level
    hit_tgt = cfg["targetAmount"] > 0 and pnl >= cfg["targetAmount"]
    if not (hit_sl or hit_tgt):
        _save(cfg)
        return []

    is_trail = hit_sl and trail_level is not None and stop_level == trail_level
    is_floor = hit_sl and not is_trail and floor_level is not None and stop_level == floor_level
    kind = "TARGET" if hit_tgt else ("TRAIL" if is_trail else ("FLOOR" if is_floor else "SL"))
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
    elif hit_sl:
        thresh = f"≤ −₹{cfg['slAmount']:.0f}"
    else:
        thresh = f"≥ ₹{cfg['targetAmount']:.0f}"
    reason = f"{kind} hit — broker P&L ₹{pnl:.0f} ({thresh}); flattened {squared} position(s)"
    cfg["lastReason"] = reason
    cfg["peakPnl"] = None
    _save(cfg)
    return [{"kind": "broker-bracket", "message": reason}]
