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
    "basis": "today",     # "today" = MTM + realised, "mtm" = open MTM only
    "armedAt": None,
    "triggeredAt": None,
    "lastReason": "",
    "lastPnl": None,
}


def _load() -> dict:
    return {**_DEFAULT, **(db.get_kv(_KV_KEY) or {})}


def _save(cfg: dict) -> None:
    db.set_kv(_KV_KEY, cfg)


def get() -> dict:
    return _load()


def set_cfg(patch: dict) -> dict:
    cfg = _load()
    for k in ("slAmount", "targetAmount"):
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
    if not (cfg.get("slAmount", 0) > 0 or cfg.get("targetAmount", 0) > 0):
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

    hit_sl = cfg["slAmount"] > 0 and pnl <= -cfg["slAmount"]
    hit_tgt = cfg["targetAmount"] > 0 and pnl >= cfg["targetAmount"]
    if not (hit_sl or hit_tgt):
        _save(cfg)
        return []

    kind = "SL" if hit_sl else "TARGET"
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
    reason = (
        f"{kind} hit — broker P&L ₹{pnl:.0f} "
        f"({'≤ −' if hit_sl else '≥ '}₹{(cfg['slAmount'] if hit_sl else cfg['targetAmount']):.0f}); "
        f"flattened {squared} position(s)"
    )
    cfg["lastReason"] = reason
    _save(cfg)
    return [{"kind": "broker-bracket", "message": reason}]
