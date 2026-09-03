"""Broker adapters. Step A wires Flattrade (Noren / Pi Connect) for read-only
data: auth, real-time ticks, historical candles, funds, positions, order book.
Live order routing is added in a later step behind a PAPER/LIVE toggle.
"""
from __future__ import annotations

from ..config import BROKER
from .flattrade import FlattradeBroker

_broker: FlattradeBroker | None = None


def get_broker() -> FlattradeBroker:
    global _broker
    if _broker is None:
        # only Flattrade implemented for now; the factory keeps room for others
        _broker = FlattradeBroker()
    return _broker
