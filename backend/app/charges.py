"""What a round trip in index/stock OPTIONS really costs, so backtest and ledger P&L
can be shown net of costs instead of flattering the rule.

The rates below are the published Indian options schedule as of 2025-26, entered by
hand and INTENTIONALLY in one place: exchanges and the government revise these, so
they're overridable per call, and a stale rate makes the estimate a little off rather
than wrong in kind. They are estimates -- the contract note is the source of truth.

  brokerage  flat per executed order (Flattrade-style flat-fee broker)
  STT        0.1% of premium, SELL side only
  exchange   NSE options transaction charge, % of premium turnover, both sides
  SEBI       0.0001% of turnover, both sides
  stamp duty 0.003% of premium, BUY side only
  GST        18% on (brokerage + exchange charge + SEBI fee)

Slippage is separate (it's a market effect, not a fee): modelled as a fraction of the
premium given up on each fill, in the direction that hurts.
"""
from __future__ import annotations

BROKERAGE_PER_ORDER = 20.0
STT_SELL = 0.001
EXCHANGE_TXN = 0.0003503
SEBI_FEE = 0.000001
STAMP_BUY = 0.00003
GST = 0.18
DEFAULT_SLIPPAGE_PCT = 0.5     # % of premium lost per fill; options spreads are wide


def order_charges(premium_turnover: float, side: str, *, brokerage: float = BROKERAGE_PER_ORDER) -> float:
    """Charges for ONE executed option order. `premium_turnover` = price x quantity."""
    t = abs(premium_turnover)
    exch = t * EXCHANGE_TXN
    sebi = t * SEBI_FEE
    gst = GST * (brokerage + exch + sebi)
    stt = t * STT_SELL if side.upper() == "SELL" else 0.0
    stamp = t * STAMP_BUY if side.upper() == "BUY" else 0.0
    return brokerage + exch + sebi + gst + stt + stamp


def round_trip_charges(entry_px: float, exit_px: float, qty: float, entry_side: str, *,
                       brokerage: float = BROKERAGE_PER_ORDER, legs: int = 1) -> float:
    """Entry + exit charges for a position of `qty` units. `legs` multiplies the flat
    brokerage for a multi-leg structure (each leg is its own order, each way)."""
    exit_side = "SELL" if entry_side.upper() == "BUY" else "BUY"
    one = order_charges(entry_px * qty, entry_side, brokerage=brokerage) \
        + order_charges(exit_px * qty, exit_side, brokerage=brokerage)
    if legs > 1:
        # the % components scale with turnover (already per whole position); only the flat fee repeats
        one += (legs - 1) * 2 * brokerage * (1 + GST)
    return one


def slippage_cost(entry_px: float, exit_px: float, qty: float, pct: float) -> float:
    """Rupees given up to the spread: `pct`% of the premium on each of the two fills."""
    return (abs(entry_px) + abs(exit_px)) * qty * pct / 100.0
