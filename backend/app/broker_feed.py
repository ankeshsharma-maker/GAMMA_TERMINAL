"""Background task: when a broker session exists, stream real-time underlying
ticks over the broker WebSocket and fan them out as `tick` messages.
"""
from __future__ import annotations

import asyncio
import logging
import time

from .brokers import get_broker
from .config import DEFAULT_SYMBOLS
from .hub import hub
from .store import store

log = logging.getLogger("broker_feed")

_tok2sym: dict[str, str] = {}
_token_cache: dict[str, tuple[str, str]] = {}
_last_emit: dict[str, float] = {}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


async def _on_tick(token: str, msg: dict) -> None:
    sym = _tok2sym.get(token)
    if not sym:
        return
    ltp = _num(msg.get("lp"))
    if ltp is None:
        return
    chg = _num(msg.get("pc"))
    store.set_live_spot(sym, ltp, chg)

    now = time.time()
    if now - _last_emit.get(sym, 0) < 0.5:  # throttle to ~2/s per symbol
        return
    _last_emit[sym] = now
    await hub.broadcast_all(
        {"type": "tick", "data": {"symbol": sym, "ltp": ltp, "chgPct": chg, "ts": now}}
    )


async def _desired_symbols() -> set[str]:
    subs = {s for s, _ in hub.subscriptions()}
    wl = {e.split("|")[0].upper() for e in store.watchlist}
    return {s.upper() for s in (set(DEFAULT_SYMBOLS) | wl | subs)}


async def run_broker_feed(stop: asyncio.Event) -> None:
    broker = get_broker()
    if not broker.configured:
        log.info("broker not configured; live feed disabled")
        return

    # wait for a session (user completes the login flow)
    while not stop.is_set() and not broker.authed:
        try:
            await asyncio.wait_for(stop.wait(), timeout=5)
        except asyncio.TimeoutError:
            pass
    if stop.is_set():
        return

    log.info("broker feed starting for %s", broker.status().get("clientId"))
    await broker.start_ws(_on_tick)

    while not stop.is_set():
        if broker.authed:
            want = await _desired_symbols()
            keys: set[str] = set()
            for sym in want:
                cached = _token_cache.get(sym)
                if not cached:
                    try:
                        cached = await broker.feed_token(sym)
                    except Exception as exc:  # noqa: BLE001
                        log.debug("feed token lookup failed for %s: %s", sym, exc)
                        cached = None
                    if cached:
                        _token_cache[sym] = cached
                        _tok2sym[cached[1]] = sym
                if cached:
                    keys.add(f"{cached[0]}|{cached[1]}")
            if keys:
                try:
                    await broker.subscribe(keys)
                except Exception as exc:  # noqa: BLE001
                    log.debug("subscribe failed: %s", exc)
        try:
            await asyncio.wait_for(stop.wait(), timeout=20)
        except asyncio.TimeoutError:
            pass

    await broker.stop_ws()
    log.info("broker feed stopped")
