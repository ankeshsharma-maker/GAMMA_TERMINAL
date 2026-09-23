"""Indicator alerts: "tell me when SYMBOL's spot is near its EMA9/EMA21, or its
RSI crosses a level" on a timeframe you pick (same candle intervals the chart
offers). One-shot -- once triggered it stops watching; create a fresh one to
re-arm. Feeds the same store.add_alert choke point every other alert source
uses, so the in-app Alerts feed and webhook/Telegram/push delivery all pick
it up for free.

Reuses AutoBot's own indicator engine (_Ctx resamples store.history into
tf-second candles with no extra network calls; ema()/rsi() are the same pure
functions AutoBot's rule conditions use) so this is just a notify-only
sibling of AutoBot's ema_cross / rsi conditions, not a second implementation.

State lives in the "indicator_alerts" table so it survives a restart.
"""
from __future__ import annotations

import time
import uuid

from . import db

_TABLE = "indicator_alerts"

_TF_LABELS = {
    15: "15s", 30: "30s", 60: "1m", 180: "3m", 300: "5m", 900: "15m",
    1800: "30m", 2700: "45m", 3600: "1h", 7200: "2h", 14400: "4h", 86400: "1D",
}


def _tf_label(tf: int) -> str:
    return _TF_LABELS.get(int(tf), f"{int(tf)}s")


def _load() -> list[dict]:
    return db.load_rows(_TABLE)


def _save(rows: list[dict]) -> None:
    db.replace_all(_TABLE, rows, ts_key="createdAt")


def list_alerts() -> list[dict]:
    return _load()


def add_alert(d: dict) -> dict:
    kind = d.get("kind")
    if kind not in ("ema_near", "rsi_level"):
        raise ValueError("kind must be 'ema_near' or 'rsi_level'")
    tf = int(d.get("tf") or 300)
    if tf not in _TF_LABELS:
        raise ValueError("unsupported timeframe")
    row = {
        "id": uuid.uuid4().hex[:12],
        "createdAt": time.time(),
        "symbol": str(d["symbol"]).upper(),
        "tf": tf,
        "kind": kind,
        "note": (d.get("note") or "").strip()[:80],
        "status": "active",  # active | triggered | cancelled
        "triggeredAt": None,
        "triggeredValue": None,
    }
    if kind == "ema_near":
        period = int(d.get("period") or 9)
        if period not in (9, 21, 50):
            raise ValueError("period must be 9, 21 or 50")
        row["period"] = period
        row["tolerancePct"] = max(0.01, float(d.get("tolerancePct") or 0.15))
    else:
        op = d.get("op") or "cross_down"
        if op not in ("<", ">", "cross_up", "cross_down"):
            raise ValueError("op must be '<', '>', 'cross_up' or 'cross_down'")
        row["period"] = int(d.get("period") or 14)
        row["op"] = op
        row["value"] = float(d.get("value") if d.get("value") is not None else 30)
    rows = _load()
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
    """Check every active alert against its own timeframe's latest candles.
    Returns alert events for whichever ones just fired."""
    from .autobot import _Ctx, ema, rsi  # local import: avoid import-time cycle with autobot

    rows = _load()
    active = [r for r in rows if r["status"] == "active"]
    if not active:
        return []

    by_key: dict[tuple[str, int], list[dict]] = {}
    for r in active:
        by_key.setdefault((r["symbol"], int(r["tf"])), []).append(r)

    events: list[dict] = []
    changed = False
    for (sym, tf), group in by_key.items():
        ctx = _Ctx(sym, tf=tf)
        if not ctx.spot:
            continue
        spot = ctx.spot[-1]
        for r in group:
            hit = False
            val: float | None = None
            if r["kind"] == "ema_near":
                series = ema(ctx.spot, int(r["period"]))
                if not series:
                    continue
                val = series[-1]
                tol = float(r["tolerancePct"]) / 100.0
                hit = abs(spot - val) <= abs(val) * tol
            else:
                series = rsi(ctx.spot, int(r["period"]))
                if len(series) < 2:
                    continue
                cur, prev, v, op = series[-1], series[-2], float(r["value"]), r["op"]
                val = cur
                if op == "<":
                    hit = cur < v
                elif op == ">":
                    hit = cur > v
                elif op == "cross_up":
                    hit = prev <= v < cur
                elif op == "cross_down":
                    hit = prev >= v > cur
            if not hit or val is None:
                continue
            r["status"] = "triggered"
            r["triggeredAt"] = time.time()
            r["triggeredValue"] = val
            tfl = _tf_label(tf)
            if r["kind"] == "ema_near":
                msg = f"{sym} near EMA{r['period']} ({tfl}) — spot {spot:g}, EMA {val:g}"
            else:
                op_label = {"<": "<", ">": ">", "cross_up": "crossed above", "cross_down": "crossed below"}[r["op"]]
                msg = f"{sym} RSI{r['period']} ({tfl}) {op_label} {r['value']:g} — now {val:.1f}"
            if r["note"]:
                msg += f" · {r['note']}"
            events.append({"kind": f"indicator-alert-{r['kind']}", "symbol": sym, "message": msg})
            changed = True

    if changed:
        _save(rows)
    return events
