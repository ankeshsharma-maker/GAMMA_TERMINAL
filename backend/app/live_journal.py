"""Live trade journal: Flattrade orders -> closed round trips in the Trade
Journal (next to paper trades), plus an end-of-day review of what went wrong.

The broker's OrderBook only holds today, so every order is copied into the
`live_orders` table whenever it is seen (upsert by order id -- a partial fill
that fills further just updates). Round trips are rebuilt first-in-first-out
per contract from ALL stored orders, so a position carried overnight still
closes against its real entry. Fill P&L is gross; the day's brokerage from the
broker's Limits call is kept per day so the review can net it."""
from __future__ import annotations

import time
from datetime import datetime

from . import db
from .brokers.flattrade import parse_noren_tsym
from .processing import IST, lot_size

_TABLE = "live_orders"
_CHARGES_KEY = "live_charges"   # {"YYYY-MM-DD": brokerage}
REENTRY_MIN = 30                # re-opening the same contract within this long after a loss gets flagged


def _f(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _ts(o: dict) -> float | None:
    for key, fmt in (("norentm", "%H:%M:%S %d-%m-%Y"), ("exch_tm", "%d-%m-%Y %H:%M:%S")):
        s = str(o.get(key) or "").strip()
        if s:
            try:
                return datetime.strptime(s, fmt).replace(tzinfo=IST).timestamp()
            except ValueError:
                continue
    return None


def _day(ts: float) -> str:
    return datetime.fromtimestamp(ts, IST).strftime("%Y-%m-%d")


def ingest(order_rows: list[dict]) -> int:
    """Store broker OrderBook rows; returns how many order ids were new."""
    known = {o["id"] for o in db.load_rows(_TABLE)}
    new = 0
    for o in order_rows or []:
        oid = str(o.get("norenordno") or "").strip()
        ts = _ts(o)
        if not oid or ts is None:
            continue
        rec = {
            "id": oid, "ts": ts, "tsym": str(o.get("tsym") or ""), "dname": o.get("dname") or o.get("cname"),
            "side": "B" if str(o.get("trantype") or "").upper().startswith("B") else "S",
            "qty": _f(o.get("qty")), "filled": _f(o.get("fillshares")), "price": _f(o.get("avgprc")),
            "status": str(o.get("status") or "").upper(), "reject": (o.get("rejreason") or "").strip(),
            "source": str(o.get("ordersource") or ""), "exch": str(o.get("exch") or ""),
        }
        db.save_row(_TABLE, oid, rec, ts=ts)
        new += oid not in known
    return new


def set_charges(day: str, brokerage: float) -> None:
    ch = db.get_kv(_CHARGES_KEY) or {}
    ch[day] = round(brokerage, 2)
    db.set_kv(_CHARGES_KEY, ch)


def _orders() -> list[dict]:
    return sorted(db.load_rows(_TABLE), key=lambda o: (o["ts"], o["id"]))


def trades() -> list[dict]:
    """Closed round trips, newest first, in the paper journal's own shape."""
    book: dict[str, list[list[float]]] = {}   # tsym -> FIFO open lots [signed qty, price, ts]
    out: list[dict] = []
    for o in _orders():
        if o["filled"] <= 0 or o["price"] <= 0:
            continue
        parsed = parse_noren_tsym(o["tsym"], o.get("dname"))
        if not parsed:
            continue
        sgn = 1 if o["side"] == "B" else -1
        lots = book.setdefault(o["tsym"], [])
        left = o["filled"]
        n = 0
        while left > 0 and lots and lots[0][0] * sgn < 0:
            q0, p0, t0 = lots[0]
            take = min(abs(q0), left)
            long_pos = q0 > 0
            pnl = (o["price"] - p0) * take * (1 if long_pos else -1)
            out.append({
                "id": f"live-{o['id']}-{n}", "mode": "live", "symbol": parsed["symbol"],
                "expiry": parsed["expiry"], "strike": parsed["strike"], "optionType": parsed["optionType"],
                "side": "BUY" if long_pos else "SELL", "qty": take, "lotSize": lot_size(parsed["symbol"]),
                "entryPrice": round(p0, 2), "exitPrice": round(o["price"], 2), "pnl": round(pnl, 2),
                "openedTs": t0, "closedTs": o["ts"], "note": o["source"],
            })
            n += 1
            left -= take
            if take >= abs(q0):
                lots.pop(0)
            else:
                lots[0][0] = q0 + take if q0 < 0 else q0 - take
        if left > 0:
            lots.append([sgn * left, o["price"], o["ts"]])
    return sorted(out, key=lambda r: -r["closedTs"])


def days() -> list[str]:
    return sorted({_day(o["ts"]) for o in _orders()}, reverse=True)


def _name(tsym: str, dname: str | None) -> str:
    p = parse_noren_tsym(tsym, dname)
    return f"{p['symbol']} {p['strike']:g} {p['optionType']}" if p else tsym


def review(day: str | None = None) -> dict:
    """What happened on one day, and the patterns that cost money."""
    all_days = days()
    day = day or (all_days[0] if all_days else datetime.now(IST).strftime("%Y-%m-%d"))
    orders = [o for o in _orders() if _day(o["ts"]) == day]
    closed = [t for t in trades() if _day(t["closedTs"]) == day]
    gross = round(sum(t["pnl"] for t in closed), 2)
    charges = (db.get_kv(_CHARGES_KEY) or {}).get(day)
    flags: list[dict] = []

    # 1. re-opening a contract soon after closing it at a loss
    pos: dict[str, float] = {}
    avg: dict[str, float] = {}
    last_loss: dict[str, tuple[float, float, int]] = {}   # tsym -> (ts, loss, direction closed)
    for o in _orders():
        if o["filled"] <= 0 or o["price"] <= 0:
            continue
        k, sgn, q = o["tsym"], (1 if o["side"] == "B" else -1), o["filled"]
        cur = pos.get(k, 0.0)
        if cur * sgn < 0:                                        # reduces / closes
            direction = 1 if cur > 0 else -1
            loss = (o["price"] - avg[k]) * min(q, abs(cur)) * direction
            if loss < 0:
                last_loss[k] = (o["ts"], loss, direction)
            rem = cur + sgn * q
            pos[k] = rem
            if rem * cur < 0:                                    # flipped through zero
                avg[k] = o["price"]
        else:                                                    # opens / adds
            if _day(o["ts"]) == day and k in last_loss:
                t_loss, loss, direction = last_loss[k]
                mins = (o["ts"] - t_loss) / 60.0
                if direction == sgn and 0 <= mins <= REENTRY_MIN:
                    flags.append({"kind": "reentry", "text": (
                        f"Re-{'bought' if sgn > 0 else 'sold'} {_name(k, o.get('dname'))} {mins:.0f} min after closing it "
                        f"at a ₹{abs(loss):,.0f} loss — at {o['price']:g}, into the same move.")})
            new = cur + sgn * q
            avg[k] = (avg.get(k, 0.0) * abs(cur) + o["price"] * q) / abs(new) if new else o["price"]
            pos[k] = new

    # 2. flipping sides on one underlying + option type within the day: closed
    # round trips that were short that type AND ones that were long it
    shorts = {(t["symbol"], t["optionType"]) for t in closed if t["side"] == "SELL"}
    longs = {(t["symbol"], t["optionType"]) for t in closed if t["side"] == "BUY"}
    for sym, ot in sorted(shorts & longs):
        lp = sum(t["pnl"] for t in closed if (t["symbol"], t["optionType"], t["side"]) == (sym, ot, "BUY"))
        flags.append({"kind": "flip", "text": (
            f"Flipped on {sym} {'calls' if ot == 'CE' else 'puts'}: short and long the same day — the long "
            f"{ot} trades {'made' if lp >= 0 else 'lost'} ₹{abs(lp):,.0f}.")})

    # 3. churn: charges against the result
    filled = [o for o in orders if o["filled"] > 0]
    if charges and (abs(gross) < 2 * charges):
        flags.append({"kind": "churn", "text": (
            f"{len(filled)} filled orders; charges ₹{charges:,.0f} against a gross of {'-' if gross < 0 else '+'}₹{abs(gross):,.0f} — "
            f"the day's result was mostly paid away in costs.")})

    # 4. rejected orders
    for o in orders:
        if o["status"] == "REJECTED":
            flags.append({"kind": "rejected", "text": (
                f"Rejected: {'BUY' if o['side'] == 'B' else 'SELL'} {o['qty']:g} {_name(o['tsym'], o.get('dname'))} — "
                f"{o['reject'] or 'no reason given'}")})

    by_contract: dict[str, float] = {}
    for t in closed:
        by_contract[f"{t['symbol']} {t['strike']:g} {t['optionType']}"] = by_contract.get(
            f"{t['symbol']} {t['strike']:g} {t['optionType']}", 0.0) + t["pnl"]
    return {
        "day": day, "days": all_days, "orders": len(orders), "filled": len(filled),
        "rejected": sum(o["status"] == "REJECTED" for o in orders),
        "gross": gross, "charges": charges, "net": round(gross - charges, 2) if charges is not None else None,
        "byContract": [{"name": k, "pnl": round(v, 2)} for k, v in sorted(by_contract.items(), key=lambda kv: kv[1])],
        "flags": flags,
    }


async def sync() -> dict:
    """Pull today's OrderBook + brokerage from Flattrade into the journal."""
    from .brokers import get_broker

    b = get_broker()
    if not (b.configured and b.authed):
        return {"ok": False, "reason": "Flattrade not connected"}
    rows = await b.order_book()
    new = ingest(rows)
    try:
        lim = await b.funds()
        if isinstance(lim, dict) and lim.get("brokerage") is not None:
            set_charges(datetime.now(IST).strftime("%Y-%m-%d"), _f(lim.get("brokerage")))
    except Exception:  # noqa: BLE001 - charges are a nice-to-have
        pass
    return {"ok": True, "orders": len(rows or []), "new": new, "at": time.time()}
