"""User-defined OI threshold watches on a single strike/leg.

A rule = "tell me when NIFTY 24000 CE's OI (or change-in-OI) crosses N."
More precise than the existing unusual-activity detector, which is
Greeks-based (delta jump / gamma spike) and not strike-specific.

    {
      "id": "...",
      "symbol": "NIFTY", "expiry": "25-Sep-2026", "strike": 24000, "optionType": "CE",
      "metric": "oi" | "oiChg",   # absolute OI, or the day's change-in-OI
      "op": ">" | "<",
      "value": 500000,
      "repeat": false,           # false -> disables itself after firing once
      "enabled": true,
      "firedAt": null,
      "lastValue": null,
    }

The poller calls `tick()` every loop. A fired rule goes through the normal
`store.add_alert` feed -- the same "Alerts" tab everything else lands in, no
separate UI needed to see it fire.

State lives in data/oi_alerts.json.
"""
from __future__ import annotations

import time
import uuid

from .config import DATA_DIR

_FILE = DATA_DIR / "oi_alerts.json"


def _load() -> list[dict]:
    try:
        import json

        return json.loads(_FILE.read_text())
    except Exception:  # noqa: BLE001
        return []


def _save(rows: list[dict]) -> None:
    try:
        import json

        _FILE.write_text(json.dumps(rows, indent=2))
    except Exception:  # noqa: BLE001
        pass


def list_rules() -> list[dict]:
    return _load()


def add_rule(d: dict) -> dict:
    row = {
        "id": uuid.uuid4().hex[:12],
        "createdAt": time.time(),
        "symbol": str(d["symbol"]).upper(),
        "expiry": d["expiry"],
        "strike": float(d["strike"]),
        "optionType": str(d["optionType"]).upper(),
        "metric": d.get("metric") if d.get("metric") in ("oi", "oiChg") else "oi",
        "op": d.get("op") if d.get("op") in (">", "<") else ">",
        "value": float(d["value"]),
        "repeat": bool(d.get("repeat", False)),
        "enabled": True,
        "firedAt": None,
        "lastValue": None,
    }
    rows = _load()
    rows.append(row)
    _save(rows)
    return row


def cancel(rid: str) -> list[dict]:
    rows = [r for r in _load() if r["id"] != rid]
    _save(rows)
    return rows


def _leg(store, symbol: str, expiry: str, strike: float, ot: str) -> dict | None:
    chain = store.get_chain(symbol, expiry)
    if not chain:
        return None
    for row in chain.get("rows", []):
        if abs(row["strike"] - strike) < 1e-6:
            return row["call"] if ot == "CE" else row["put"]
    return None


async def tick() -> list[dict]:
    from .store import store

    rows = _load()
    if not rows:
        return []
    events: list[dict] = []
    changed = False

    for r in rows:
        if not r.get("enabled"):
            continue
        leg = _leg(store, r["symbol"], r["expiry"], r["strike"], r["optionType"])
        if not leg:
            continue
        v = leg.get(r["metric"])
        if v is None:
            continue
        v = float(v)
        r["lastValue"] = round(v, 2)
        hit = v > r["value"] if r["op"] == ">" else v < r["value"]
        if not hit:
            changed = True
            continue

        tag = f"{r['symbol']} {int(r['strike'])}{r['optionType']}"
        metric_label = "OI" if r["metric"] == "oi" else "ΔOI"
        msg = f"{tag} {metric_label} {r['op']} {r['value']:,.0f} -- now {v:,.0f}"
        events.append({"symbol": r["symbol"], "message": msg})
        r["firedAt"] = time.time()
        if not r.get("repeat"):
            r["enabled"] = False
        changed = True

    if changed:
        _save(rows)
    return events
