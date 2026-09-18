"""MTM alerts: fire once when total live broker P&L crosses a rupee level
the user set (>= for "above", <= for "below"). One-shot -- once triggered
it stops watching; create a fresh one to re-arm. Feeds the same
store.add_alert choke point every other alert source uses, so the in-app
Alerts feed and webhook/Telegram/push delivery all pick it up for free.

P&L computation mirrors broker_bracket.py's tick() exactly (sum urmtom/mtm
+ rpnl across every PositionBook row) rather than sharing state with it --
this alert type is meant to work standalone, whether or not the user also
has the auto-square-off bracket armed.

State lives in the "mtm_alerts" table so it survives a restart.
"""
from __future__ import annotations

import time
import uuid

from . import db

_TABLE = "mtm_alerts"


def _load() -> list[dict]:
    return db.load_rows(_TABLE)


def _save(rows: list[dict]) -> None:
    db.replace_all(_TABLE, rows, ts_key="createdAt")


def list_alerts() -> list[dict]:
    return _load()


def add_alert(d: dict) -> dict:
    direction = d.get("direction") or "above"
    if direction not in ("above", "below"):
        raise ValueError("direction must be 'above' or 'below'")
    basis = d.get("basis") or "today"
    if basis not in ("today", "mtm"):
        raise ValueError("basis must be 'today' or 'mtm'")
    rows = _load()
    row = {
        "id": uuid.uuid4().hex[:12],
        "createdAt": time.time(),
        "level": float(d["level"]),
        "direction": direction,
        "basis": basis,  # "today" = MTM + realised, "mtm" = open MTM only
        "note": (d.get("note") or "").strip()[:80],
        "status": "active",  # active | triggered | cancelled
        "triggeredAt": None,
        "triggeredPnl": None,
    }
    rows.append(row)
    _save(rows)
    return row


def cancel(aid: str) -> list[dict]:
    """Cancel a still-active alert (stops watching, kept as history) or
    dismiss an already-triggered/cancelled one (removed outright -- there's
    nothing left to cancel, the ✕ just clears it from the list)."""
    rows = _load()
    out = []
    for r in rows:
        if r["id"] == aid:
            if r["status"] == "active":
                r["status"] = "cancelled"
                out.append(r)
            continue
        out.append(r)
    _save(out)
    return out


def clear_finished() -> list[dict]:
    rows = [r for r in _load() if r["status"] == "active"]
    _save(rows)
    return rows


def _num(v) -> float:
    try:
        x = float(v)
        return x if x == x else 0.0  # drop NaN
    except (TypeError, ValueError):
        return 0.0


async def tick() -> list[dict]:
    """Check every active MTM alert against live broker P&L. Returns alert
    events for whichever ones just fired."""
    rows = _load()
    active = [r for r in rows if r["status"] == "active"]
    if not active:
        return []

    from .brokers import get_broker

    broker = get_broker()
    if not getattr(broker, "authed", False):
        return []

    try:
        pos_rows = await broker.positions()
    except Exception:  # noqa: BLE001
        return []

    mtm = 0.0
    realised = 0.0
    for r in pos_rows or []:
        mtm += _num(r.get("urmtom")) or _num(r.get("mtm"))
        realised += _num(r.get("rpnl"))
    pnl_today = mtm + realised

    events: list[dict] = []
    changed = False
    for r in active:
        pnl = pnl_today if r["basis"] == "today" else mtm
        hit = pnl >= r["level"] if r["direction"] == "above" else pnl <= r["level"]
        if not hit:
            continue
        r["status"] = "triggered"
        r["triggeredAt"] = time.time()
        r["triggeredPnl"] = round(pnl, 2)
        arrow = "≥" if r["direction"] == "above" else "≤"
        label = "MTM" if r["basis"] == "mtm" else "P&L"
        msg = f"{label} {arrow} ₹{r['level']:,.0f} — now ₹{pnl:,.0f}"
        if r["note"]:
            msg += f" · {r['note']}"
        events.append({"kind": "mtm-alert", "message": msg})
        changed = True

    if changed:
        _save(rows)
    return events
