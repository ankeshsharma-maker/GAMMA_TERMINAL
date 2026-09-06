"""Time-based strategy runner for the Builder.

A schedule = a set of legs plus an optional entry time and/or exit time (IST
"HH:MM").  The poller calls `tick()` every loop; when the wall clock passes a
schedule's entry time it places the legs (paper or live, same path as the
Execute button), and when it passes the exit time it squares them off.  With
`repeat` the schedule re-arms for the next trading day.

State lives in data/schedules.json so it survives a restart.
"""
from __future__ import annotations

import json
import time
import uuid
from datetime import datetime

from .config import DATA_DIR
from .processing import IST

_FILE = DATA_DIR / "schedules.json"

_MKT_OPEN = "09:15"
_MKT_CLOSE = "15:30"


def _load() -> list[dict]:
    try:
        return json.loads(_FILE.read_text())
    except Exception:  # noqa: BLE001
        return []


def _save(rows: list[dict]) -> None:
    try:
        _FILE.write_text(json.dumps(rows, indent=2))
    except Exception:  # noqa: BLE001
        pass


def list_schedules() -> list[dict]:
    return _load()


def add_schedule(d: dict) -> dict:
    rows = _load()
    row = {
        "id": uuid.uuid4().hex[:12],
        "createdAt": time.time(),
        "symbol": d["symbol"],
        "expiry": d["expiry"],
        "legs": d["legs"],
        "mode": d.get("mode") or "paper",
        "entryTime": d.get("entryTime") or None,
        "exitTime": d.get("exitTime") or None,
        "repeat": bool(d.get("repeat")),
        "note": (d.get("note") or "").strip()[:80],
        "status": "armed",  # armed | entered | done | cancelled
        "lastEntryDate": None,
        "lastExitDate": None,
        "log": [],
    }
    rows.append(row)
    _save(rows)
    return row


def cancel(sid: str) -> list[dict]:
    rows = _load()
    for r in rows:
        if r["id"] == sid and r["status"] not in ("done", "cancelled"):
            r["status"] = "cancelled"
            r["log"].append({"ts": time.time(), "msg": "cancelled"})
    _save(rows)
    return rows


def clear_finished() -> list[dict]:
    rows = [r for r in _load() if r["status"] in ("armed", "entered")]
    _save(rows)
    return rows


async def _run_legs(row: dict, reverse: bool) -> None:
    """Fire every option leg of the schedule (reverse=True to square)."""
    from .routes import _route_leg  # lazy: avoid an import cycle at module load

    for leg in row["legs"]:
        if str(leg.get("optionType", "")).upper() == "FUT":
            continue
        side = leg["side"].upper()
        if reverse:
            side = "SELL" if side == "BUY" else "BUY"
        try:
            await _route_leg(
                symbol=row["symbol"],
                expiry=row["expiry"],
                strike=float(leg["strike"]),
                option_type=leg["optionType"],
                side=side,
                qty_lots=int(leg["lots"]),
                order_type="MKT",
                price=None,
                product="NRML",
                mode=row["mode"],
            )
        except Exception as exc:  # noqa: BLE001
            row["log"].append({"ts": time.time(), "msg": f"leg failed: {exc}"})


async def tick() -> list[dict]:
    """Fire any due entries/exits. Returns event dicts for the alert feed."""
    rows = _load()
    if not rows:
        return []

    now = datetime.now(IST)
    if now.weekday() >= 5:  # Sat / Sun
        return []
    hhmm = now.strftime("%H:%M")
    if not (_MKT_OPEN <= hhmm <= _MKT_CLOSE):
        return []
    today = now.strftime("%Y-%m-%d")

    events: list[dict] = []
    changed = False

    for r in rows:
        if r["status"] in ("done", "cancelled"):
            continue

        # ---- entry ----
        if (
            r.get("entryTime")
            and r["status"] == "armed"
            and r["lastEntryDate"] != today
            and hhmm >= r["entryTime"]
        ):
            await _run_legs(r, reverse=False)
            r["status"] = "entered"
            r["lastEntryDate"] = today
            msg = (
                f"scheduled entry · {r['symbol']} {len(r['legs'])} legs "
                f"@ {hhmm} ({r['mode']})"
            )
            r["log"].append({"ts": time.time(), "msg": msg})
            events.append({"kind": "sched-entry", "symbol": r["symbol"], "message": msg})
            changed = True

        # ---- exit ----
        entered_state = r["status"] == "entered" or (
            r.get("repeat") and not r.get("entryTime")
        )
        if (
            r.get("exitTime")
            and entered_state
            and r["lastExitDate"] != today
            and hhmm >= r["exitTime"]
        ):
            await _run_legs(r, reverse=True)
            r["lastExitDate"] = today
            if r.get("repeat"):
                r["status"] = "armed"
                r["lastEntryDate"] = None
            else:
                r["status"] = "done"
            msg = f"scheduled square · {r['symbol']} @ {hhmm}"
            r["log"].append({"ts": time.time(), "msg": msg})
            events.append({"kind": "sched-exit", "symbol": r["symbol"], "message": msg})
            changed = True

    if changed:
        _save(rows)
    return events
