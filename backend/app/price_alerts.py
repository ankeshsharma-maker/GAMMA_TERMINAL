"""Price-level alerts: fire once when a symbol's live spot reaches a level
the user set (>= for "above", <= for "below"). One-shot -- once triggered
it stops watching; create a fresh one to re-arm. Feeds the same
store.add_alert choke point every other alert source uses, so the in-app
Alerts feed and webhook/Telegram/push delivery all pick it up for free.

State lives in the "price_alerts" table so it survives a restart.
"""
from __future__ import annotations

import time
import uuid

from . import db
from .store import store

_TABLE = "price_alerts"


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
    rows = _load()
    row = {
        "id": uuid.uuid4().hex[:12],
        "createdAt": time.time(),
        "symbol": str(d["symbol"]).upper(),
        "level": float(d["level"]),
        "direction": direction,
        "note": (d.get("note") or "").strip()[:80],
        "status": "active",  # active | triggered | cancelled
        "triggeredAt": None,
        "triggeredSpot": None,
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


async def tick() -> list[dict]:
    """Check every active alert against the latest live spot. Returns
    alert events for whichever ones just fired."""
    rows = _load()
    active = [r for r in rows if r["status"] == "active"]
    if not active:
        return []

    events: list[dict] = []
    changed = False
    for r in active:
        live = store.get_live_spot(r["symbol"])
        if not live or live.get("ltp") is None:
            continue
        spot = float(live["ltp"])
        hit = spot >= r["level"] if r["direction"] == "above" else spot <= r["level"]
        if not hit:
            continue
        r["status"] = "triggered"
        r["triggeredAt"] = time.time()
        r["triggeredSpot"] = spot
        arrow = "≥" if r["direction"] == "above" else "≤"
        msg = f"{r['symbol']} {arrow} {r['level']:g} — now {spot:g}"
        if r["note"]:
            msg += f" · {r['note']}"
        events.append({"kind": "price-alert", "symbol": r["symbol"], "message": msg})
        changed = True

    if changed:
        _save(rows)
    return events
