"""Adding-to-a-loser watch on the live broker positions.

2026-09-28: the day's biggest loss (SENSEX 73500 PE, -Rs 11,255) came from selling MORE of a short
put that was already 200 points against it. Most of those orders were placed in the Flattrade app,
which GammaTerminal can't stop -- so the server watches the PositionBook instead: when a position
grows in the same direction (more bought on a long, more sold on a short) while it is losing, it
alerts at once (app + Telegram). One alert per position per growth; resets each day."""
from __future__ import annotations

from datetime import datetime

from .processing import IST
from .store import store

_last: dict[str, int] = {}   # tsym -> netqty at the previous check
_day: str | None = None


def _num(v) -> float:
    try:
        x = float(v)
        return x if x == x else 0.0
    except (TypeError, ValueError):
        return 0.0


def check(rows: list[dict] | None = None) -> list[dict]:
    """Alert events for positions that just grew while losing."""
    global _day
    today = datetime.now(IST).date().isoformat()
    if today != _day:
        _day = today
        _last.clear()
    rows = store.broker_positions if rows is None else rows
    events: list[dict] = []
    seen: set[str] = set()
    for r in rows or []:
        tsym = str(r.get("tsym") or "")
        if not tsym:
            continue
        seen.add(tsym)
        q = int(round(_num(r.get("netqty"))))
        prev = _last.get(tsym)
        _last[tsym] = q
        if prev is None or q == 0 or prev == 0 or (q > 0) != (prev > 0) or abs(q) <= abs(prev):
            continue   # first look, flat, a flip, or reduced -- not adding
        mtm = _num(r.get("urmtom")) or _num(r.get("mtm"))
        if mtm >= 0:
            continue   # adding to a winner is a different decision
        name = r.get("dname") or tsym
        side = "short" if q < 0 else "long"
        events.append({
            "kind": "adding-to-loser", "symbol": name, "severity": "warning",
            "message": (f"⚠ You ADDED to a losing position: {name} is now {abs(q)} {side} "
                        f"(was {abs(prev)}), and it is at ₹{mtm:,.0f}. Adding to a loser turns one bad "
                        "trade into the day's biggest loss — is this part of your plan?"),
        })
    for gone in set(_last) - seen:
        _last.pop(gone, None)
    return events
