"""Tells you the moment Flattrade rejects an order.

Placing an order only tells the app that Flattrade ACCEPTED the request (it hands back an order
number). Whether the exchange / risk system then takes it -- margin, price bands, freeze quantity,
"not allowed" contracts -- shows up a moment later as a REJECTED row in the OrderBook, which nothing
was watching: the rejection only appeared once the order history was opened in the Flattrade app.

This loop reads the OrderBook every few seconds while a broker session exists and, for each order
that turns REJECTED, raises a critical alert (the in-app Alerts feed, Telegram / webhook and phone
push all take it through store.add_alert) and a `order-rejected` message the app shows as a red banner
with a sound. Owner-only: the hub never forwards unknown message types to view-only users.
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from datetime import datetime
from zoneinfo import ZoneInfo

from .brokers import get_broker
from .hub import hub
from .store import store

log = logging.getLogger(__name__)
IST = ZoneInfo("Asia/Kolkata")

_POLL_LIVE_S = 3.0      # market hours
_POLL_IDLE_S = 20.0     # outside them
_RECENT_S = 180         # on the first read after a start, only a rejection this fresh is announced
_seen: dict[str, str] = {}   # order number -> last status read
_primed = False


def _market_hours() -> bool:
    now = datetime.now(IST)
    return now.weekday() < 5 and (9, 0) <= (now.hour, now.minute) <= (15, 45)


def _age_s(norentm: str | None) -> float | None:
    """Seconds since the order time Noren reports ("13:05:41 30-09-2026", IST)."""
    try:
        t = datetime.strptime(str(norentm or "").strip(), "%H:%M:%S %d-%m-%Y").replace(tzinfo=IST)
        return max(0.0, time.time() - t.timestamp())
    except ValueError:
        return None


def _inr(v: float) -> str:
    """₹ with Indian digit grouping (1,23,456)."""
    n = int(round(v))
    s = str(abs(n))
    if len(s) > 3:
        head, tail = s[:-3], s[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        s = ",".join(parts + [tail])
    return ("-" if n < 0 else "") + "₹" + s


_MARGIN_RE = re.compile(r"margin\s*shortfall\s*:?\s*INR\s*([\d,]+(?:\.\d+)?)(?:.*?available\s*:?\s*INR\s*([\d,]+(?:\.\d+)?))?", re.I)
_PLAIN = (
    (re.compile(r"freeze", re.I), "The quantity is above the exchange's freeze limit — send it in smaller orders"),
    (re.compile(r"price\s*(out\s*of\s*)?(band|range)|circuit|dpr|price is out", re.I), "The price is outside the allowed range for this contract"),
    (re.compile(r"insufficient|no\s+funds|fund", re.I), "Not enough funds in the account"),
    (re.compile(r"not\s*(allowed|permitted|tradable)|blocked|ban", re.I), "This contract is not allowed to be traded right now"),
    (re.compile(r"lot\s*size|multiple\s*of\s*lot", re.I), "The quantity is not a whole number of lots"),
    (re.compile(r"market\s*(is\s*)?closed|not\s*in\s*session|after\s*market", re.I), "The market is closed for this order"),
)


def plain_reason(raw: str | None) -> str:
    """Flattrade's rejection text ("RED:Margin Shortfall:INR 5089.84 Available:INR 993181.66 for C-XX [..]")
    in words: how much margin is missing, or what the rule was."""
    text = str(raw or "").strip()
    if not text:
        return "no reason given by the broker"
    m = _MARGIN_RE.search(text)
    if m:
        short = float(m.group(1).replace(",", ""))
        out = f"Not enough margin: short by {_inr(short)}"
        if m.group(2):
            out += f" (available {_inr(float(m.group(2).replace(',', '')))})"
        return out
    for rx, words in _PLAIN:
        if rx.search(text):
            return f"{words} ({text[:80]})"
    return text


def _describe(o: dict) -> tuple[str, str]:
    side = "BUY" if str(o.get("trantype")) == "B" else "SELL"
    name = str(o.get("dname") or o.get("tsym") or "order").strip()
    qty = o.get("qty")
    prc = o.get("prc")
    px = "MKT" if "MKT" in str(o.get("prctyp") or "").upper() else (f"@ {prc}" if prc not in (None, "", "0", "0.00") else "")
    raw = str(o.get("rejreason") or "").strip()
    reason = plain_reason(raw)
    text = f"Order REJECTED: {side} {qty} {name} {px}".replace("  ", " ").strip() + f" — {reason}"
    return text, raw or reason


async def check_once() -> list[dict]:
    """Read the OrderBook; return (and announce) the orders that newly turned REJECTED."""
    global _primed
    b = get_broker()
    rows = await b.order_book()
    first = not _primed
    fresh: list[dict] = []
    for o in rows or []:
        oid = str(o.get("norenordno") or "")
        if not oid:
            continue
        st = str(o.get("status") or "").upper()
        prev = _seen.get(oid)
        _seen[oid] = st
        if st != "REJECTED" or prev == "REJECTED":
            continue
        if prev is None and first:
            age = _age_s(o.get("norentm"))
            if age is None or age > _RECENT_S:
                continue  # an old rejection from before this start: not news
        fresh.append(o)
    _primed = True
    if len(_seen) > 2000:
        for k in list(_seen)[:1000]:
            _seen.pop(k, None)

    for o in fresh:
        text, reason = _describe(o)
        log.warning(
            "ORDER REJECTED id=%s %s %s qty=%s at %s | broker said: %s",
            o.get("norenordno"), "BUY" if str(o.get("trantype")) == "B" else "SELL",
            o.get("dname") or o.get("tsym"), o.get("qty"), o.get("norentm"), o.get("rejreason") or "-",
        )
        sym = str(o.get("tsym") or "")
        underlying = "".join(ch for ch in sym.split(" ")[0] if ch.isalpha()) if sym else ""
        now = time.time()
        try:
            store.add_alert({
                "ts": now, "symbol": underlying.upper(), "kind": "order-rejected", "severity": "critical",
                "category": "order", "score": 0, "message": text,
            })
            await hub.broadcast_all({"type": "alerts", "data": store.get_alerts(50)})
            await hub.broadcast_all({"type": "order-rejected", "data": {
                "ts": now, "orderId": str(o.get("norenordno") or ""), "message": text, "reason": reason,
                "side": "BUY" if str(o.get("trantype")) == "B" else "SELL",
                "name": str(o.get("dname") or o.get("tsym") or ""), "qty": o.get("qty"),
            }})
        except Exception as exc:  # noqa: BLE001 - never let an announcement kill the loop
            log.warning("order-rejected announcement failed: %s", exc)
    return fresh


async def run(stop: asyncio.Event) -> None:
    b = get_broker()
    if not b.configured:
        return
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=_POLL_LIVE_S if _market_hours() else _POLL_IDLE_S)
        except asyncio.TimeoutError:
            pass
        if stop.is_set():
            break
        if not b.authed:
            continue
        try:
            await check_once()
        except Exception as exc:  # noqa: BLE001 - keep watching through a bad read
            log.debug("order watch read failed: %s", exc)
