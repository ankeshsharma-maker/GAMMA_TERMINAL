"""Price-triggered conditional orders on a single option leg.

A rule = "BUY (or SELL) <SYMBOL> <EXPIRY> <STRIKE> <CE|PE> <lots> when its LTP
crosses <trigger>, then bracket the fill with an optional stop-loss, a
trailing stop and a book-profit target."  Distances are read in points, %
of the entry price, or rupees of total P&L (`unit`).

The poller calls `tick()` every loop.  It watches the leg's live LTP off the
option chain, fires the entry via the same `_route_leg()` path the manual
Buy/Sell buttons use, and once filled keeps checking SL / trail / target and
squares the position off when one is hit.

State lives in the "leg_rules" table so it survives a restart.
"""
from __future__ import annotations

import time
import uuid

from . import db
from .processing import IST
from datetime import datetime

_TABLE = "leg_rules"
_MKT_OPEN, _MKT_CLOSE = "09:15", "15:30"


def _load() -> list[dict]:
    return db.load_rows(_TABLE)


def _save(rows: list[dict]) -> None:
    db.replace_all(_TABLE, rows, ts_key="createdAt")


def list_rules() -> list[dict]:
    return _load()


def add_rule(d: dict) -> dict:
    rows = _load()

    def _f(k):
        v = d.get(k)
        try:
            return float(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None

    row = {
        "id": uuid.uuid4().hex[:12],
        "createdAt": time.time(),
        "symbol": str(d["symbol"]).upper(),
        "expiry": d["expiry"],
        "strike": float(d["strike"]),
        "optionType": str(d["optionType"]).upper(),
        "side": str(d.get("side") or "BUY").upper(),
        "lots": max(1, int(d.get("lots") or 1)),
        "mode": d.get("mode") or "paper",
        "product": d.get("product") or "NRML",
        "triggerPx": float(d["triggerPx"]),
        "triggerDir": d.get("triggerDir") or "gte",  # gte | lte
        "sl": _f("sl"),
        "target": _f("target"),
        "trail": _f("trail"),
        "unit": d.get("unit") or "pts",  # pts | pct | rs
        "note": (d.get("note") or "").strip()[:80],
        "status": "waiting",  # waiting | active | done | cancelled
        "entryPx": None,
        "peakPx": None,
        "exitPx": None,
        "exitReason": None,
        "log": [],
    }
    rows.append(row)
    _save(rows)
    return row


def attach_to_position(d: dict) -> dict:
    """Bracket an *already-open* position (manually 1-clicked, scalped, or
    opened outside AutoBot/leg_rules entirely) with SL / trail / target.
    Skips the "wait for a trigger price" phase `add_rule` uses -- this rule
    starts directly in `active`, anchored to the position's real entry
    price, so `tick()` manages the exit exactly like a normal leg rule from
    the very next poll."""
    rows = _load()

    def _f(k):
        v = d.get(k)
        try:
            return float(v) if v not in (None, "") else None
        except (TypeError, ValueError):
            return None

    entry_px = _f("entryPx")
    if entry_px is None:
        raise ValueError("entryPx is required")
    sl, target, trail = _f("sl"), _f("target"), _f("trail")
    if sl is None and target is None and trail is None:
        raise ValueError("set at least one of sl / target / trail")

    row = {
        "id": uuid.uuid4().hex[:12],
        "createdAt": time.time(),
        "symbol": str(d["symbol"]).upper(),
        "expiry": d["expiry"],
        "strike": float(d["strike"]),
        "optionType": str(d["optionType"]).upper(),
        "side": str(d.get("side") or "BUY").upper(),
        "lots": max(1, int(d.get("lots") or 1)),
        "mode": d.get("mode") or "live",
        "product": d.get("product") or "NRML",
        "triggerPx": entry_px,
        "triggerDir": "gte",
        "sl": sl,
        "target": target,
        "trail": trail,
        "unit": d.get("unit") or "pts",
        "note": (d.get("note") or "position bracket").strip()[:80],
        "status": "active",
        "entryPx": entry_px,
        "peakPx": entry_px,
        "exitPx": None,
        "exitReason": None,
        "log": [{"ts": time.time(), "msg": f"bracket attached @ entry {entry_px:.2f}"}],
    }
    rows.append(row)
    _save(rows)
    return row


def cancel(rid: str) -> list[dict]:
    rows = _load()
    for r in rows:
        if r["id"] == rid and r["status"] in ("waiting", "active"):
            r["status"] = "cancelled"
            r["log"].append({"ts": time.time(), "msg": "cancelled"})
    _save(rows)
    return rows


def clear_finished() -> list[dict]:
    rows = [r for r in _load() if r["status"] in ("waiting", "active")]
    _save(rows)
    return rows


def _leg_ltp(store, r: dict) -> float | None:
    chain = store.get_chain(r["symbol"], r["expiry"])
    if not chain:
        return None
    for row in chain.get("rows", []):
        if abs(row["strike"] - r["strike"]) < 1e-6:
            leg = row["call"] if r["optionType"] == "CE" else row["put"]
            v = leg.get("ltp")
            return float(v) if v else None
    return None


def _lot_size(store, sym: str) -> int:
    try:
        from .processing import lot_size

        return int(lot_size(sym)) or 1
    except Exception:  # noqa: BLE001
        return 1


def _delta(r: dict, entry: float, lot_sz: int) -> dict:
    """value -> price-delta for sl / target / trail, per `unit`."""
    n = max(1, r["lots"]) * max(1, lot_sz)
    out = {}
    for k in ("sl", "target", "trail"):
        v = r.get(k)
        if v is None:
            out[k] = None
        elif r["unit"] == "pct":
            out[k] = entry * v / 100.0
        elif r["unit"] == "rs":
            out[k] = v / n
        else:  # pts
            out[k] = v
    return out


async def tick() -> list[dict]:
    from .store import store

    rows = _load()
    if not rows:
        return []
    now = datetime.now(IST)
    if now.weekday() >= 5:
        return []
    if not (_MKT_OPEN <= now.strftime("%H:%M") <= _MKT_CLOSE):
        return []

    from .routes import _route_leg  # lazy: avoids an import cycle

    events: list[dict] = []
    changed = False

    for r in rows:
        if r["status"] in ("done", "cancelled"):
            continue
        ltp = _leg_ltp(store, r)
        if ltp is None:
            continue
        tag = f"{r['symbol']} {int(r['strike'])}{r['optionType']}"

        # ---- entry ----
        if r["status"] == "waiting":
            hit = (
                ltp >= r["triggerPx"] if r["triggerDir"] == "gte" else ltp <= r["triggerPx"]
            )
            if not hit:
                continue
            try:
                await _route_leg(
                    symbol=r["symbol"], expiry=r["expiry"], strike=r["strike"],
                    option_type=r["optionType"], side=r["side"], qty_lots=r["lots"],
                    order_type="MKT", price=None, product=r["product"], mode=r["mode"],
                )
            except Exception as exc:  # noqa: BLE001
                r["log"].append({"ts": time.time(), "msg": f"entry failed: {exc}"})
                r["status"] = "done"
                r["exitReason"] = "entry-error"
                changed = True
                continue
            r["status"] = "active"
            r["entryPx"] = ltp
            r["peakPx"] = ltp
            msg = f"rule entry · {r['side']} {tag} x{r['lots']} @ ~{ltp:.2f} ({r['mode']})"
            r["log"].append({"ts": time.time(), "msg": msg})
            events.append({"kind": "leg-rule", "symbol": r["symbol"], "message": msg})
            changed = True
            continue

        # ---- manage an open position ----
        if r["status"] != "active" or r["entryPx"] is None:
            continue
        entry = float(r["entryPx"])
        lot_sz = _lot_size(store, r["symbol"])
        d = _delta(r, entry, lot_sz)
        long_ = r["side"] == "BUY"

        if long_:
            r["peakPx"] = max(r.get("peakPx") or ltp, ltp)
            stop = None
            if d["sl"] is not None:
                stop = entry - d["sl"]
            if d["trail"] is not None:
                ts = r["peakPx"] - d["trail"]
                stop = ts if stop is None else max(stop, ts)
            tgt = entry + d["target"] if d["target"] is not None else None
            hit_stop = stop is not None and ltp <= stop
            hit_tgt = tgt is not None and ltp >= tgt
        else:
            r["peakPx"] = min(r.get("peakPx") or ltp, ltp)
            stop = None
            if d["sl"] is not None:
                stop = entry + d["sl"]
            if d["trail"] is not None:
                ts = r["peakPx"] + d["trail"]
                stop = ts if stop is None else min(stop, ts)
            tgt = entry - d["target"] if d["target"] is not None else None
            hit_stop = stop is not None and ltp >= stop
            hit_tgt = tgt is not None and ltp <= tgt

        if not (hit_stop or hit_tgt):
            continue
        reason = "target" if hit_tgt else ("trail" if d["trail"] is not None else "SL")
        exit_side = "SELL" if long_ else "BUY"
        try:
            await _route_leg(
                symbol=r["symbol"], expiry=r["expiry"], strike=r["strike"],
                option_type=r["optionType"], side=exit_side, qty_lots=r["lots"],
                order_type="MKT", price=None, product=r["product"], mode=r["mode"],
            )
        except Exception as exc:  # noqa: BLE001
            r["log"].append({"ts": time.time(), "msg": f"exit failed: {exc}"})
            continue
        r["status"] = "done"
        r["exitPx"] = ltp
        r["exitReason"] = reason
        pnl = (ltp - entry if long_ else entry - ltp) * r["lots"] * lot_sz
        msg = f"rule {reason} · {tag} @ ~{ltp:.2f} · P&L ₹{pnl:.0f}"
        r["log"].append({"ts": time.time(), "msg": msg})
        events.append({"kind": "leg-rule", "symbol": r["symbol"], "message": msg})
        changed = True

    if changed:
        _save(rows)
    return events
