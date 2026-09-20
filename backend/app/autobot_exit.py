"""The exit maths for one open AutoBot position: stop-loss, breakeven, trailing stop,
target and scale-out.

This is the ONE implementation. The live engine (`autobot.AutoBot.tick`) and the
backtester (`autobot_backtest`) both call it, so a rule can't behave one way in a
backtest and another way with real money -- before this existed the backtester had
its own copy that had quietly diverged (no breakeven, no scale-out).

Everything here is a pure function of numbers; nothing touches the store or the
clock. A position is described by four things:

    buy   True for a long-premium position (profit when the price rises), False for
          a short-premium one. A multi-leg structure passes its net premium the same
          way: a credit structure is `buy=False` with `base` = the credit received
          and `ltp` = what it would cost to close now.
    base  entry premium (per unit; for a structure, the net premium)
    ltp   current premium, on the same footing as `base`
    peak  the best favourable premium seen so far (None -> `base`)

`rule["slBasis"]` picks the unit of every threshold: "pct" (% of the entry
premium, default), "pts" (premium points) or "rs" (rupee P&L on `qty`).
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass
class ExitEval:
    buy: bool
    base: float
    ltp: float
    peak: float
    qty: int
    basis: str          # pct | pts | rs
    unit: str           # % | pts | ₹
    signed: float       # favourable move in % of base (positive = in profit)
    fav: float          # peak run-up, in `basis` units
    cur_fav: float      # current run-up, in `basis` units
    stop_px: float | None
    be_on: bool
    trail_on: bool


def basis_of(rule: dict) -> str:
    return (rule.get("slBasis") or "pct").lower()


def unit_of(rule: dict) -> str:
    b = basis_of(rule)
    return "pts" if b == "pts" else "₹" if b == "rs" else "%"


def _num(v, default: float = 0.0) -> float:
    return float(v or default)


def evaluate(rule: dict, *, buy: bool, base: float, ltp: float,
             peak: float | None, qty: int) -> ExitEval:
    """Update the peak with `ltp` and work out the effective stop for this instant.

    The effective stop is the tightest of: the fixed stop-loss, breakeven (once the
    trade has run `beArmPct` in favour) and the trailing stop (once it has run
    `trailArmPct`, trailing `trailPct` behind the peak)."""
    base = base or 1.0
    qty = max(1, int(qty))
    basis = basis_of(rule)
    move = (ltp - base) / base * 100
    signed = move if buy else -move

    peak = base if peak is None else peak
    peak = max(peak, ltp) if buy else min(peak, ltp)

    def to_pts(v):
        if v in (None, ""):
            return None
        v = abs(float(v))
        if basis == "pts":
            return v
        if basis == "rs":
            return v / qty
        return base * v / 100.0

    if basis == "pts":
        fav = (peak - base) if buy else (base - peak)
        cur_fav = (ltp - base) if buy else (base - ltp)
    elif basis == "rs":
        fav = ((peak - base) if buy else (base - peak)) * qty
        cur_fav = ((ltp - base) if buy else (base - ltp)) * qty
    else:
        fav = (peak - base) / base * 100 if buy else (base - peak) / base * 100
        cur_fav = signed

    stop_px = None
    sl_pts = to_pts(rule.get("slPct"))
    if sl_pts is not None:
        stop_px = base - sl_pts if buy else base + sl_pts
    be_arm = _num(rule.get("beArmPct"))
    be_on = be_arm > 0 and fav >= be_arm
    if be_on:
        stop_px = base if stop_px is None else (max(stop_px, base) if buy else min(stop_px, base))
    trail_v = _num(rule.get("trailPct"))
    trail_arm = _num(rule.get("trailArmPct"))
    trail_pts = to_pts(rule.get("trailPct")) if trail_v > 0 else None
    trail_on = trail_pts is not None and fav >= trail_arm
    if trail_on:
        ts_px = peak - trail_pts if buy else peak + trail_pts
        stop_px = ts_px if stop_px is None else (max(stop_px, ts_px) if buy else min(stop_px, ts_px))

    return ExitEval(
        buy=buy, base=base, ltp=ltp, peak=peak, qty=qty, basis=basis, unit=unit_of(rule),
        signed=signed, fav=fav, cur_fav=cur_fav, stop_px=stop_px, be_on=be_on, trail_on=trail_on,
    )


def stop_hit(ev: ExitEval) -> bool:
    if ev.stop_px is None:
        return False
    return ev.ltp <= ev.stop_px if ev.buy else ev.ltp >= ev.stop_px


def target_hit(rule: dict, ev: ExitEval) -> bool:
    tp = rule.get("targetPct")
    return tp not in (None, "") and float(tp) != 0 and ev.cur_fav >= abs(float(tp))


def stop_reason(rule: dict, ev: ExitEval) -> str:
    return (
        "trailing stop" if ev.trail_on
        else "breakeven stop" if ev.be_on
        else f"SL {rule.get('slPct')}{ev.unit}"
    )


def target_reason(rule: dict, ev: ExitEval) -> str:
    return f"target {rule.get('targetPct')}{ev.unit}"


def partial_close_lots(rule: dict, ev: ExitEval, *, entry_lots: int, lots: int, done: bool) -> int:
    """Lots to book at the scale-out target, or 0 if it isn't due (or there's nothing
    to leave running: with a single lot left the whole position simply rides on)."""
    t1 = rule.get("target1Pct")
    if t1 in (None, "") or float(t1) == 0 or done or ev.cur_fav < abs(float(t1)):
        return 0
    close = round(int(entry_lots or lots) * float(rule.get("target1LotsPct") or 50) / 100)
    close = max(1, min(close, lots - 1))
    return close if lots > close else 0


def pnl_rs(ev: ExitEval, lots: int, lot_size: int) -> float:
    """Rupee P&L for `lots` lots at the current price (the engine's estimate; a live
    order's true fill isn't known at decision time)."""
    return ev.signed / 100 * ev.base * lots * lot_size
