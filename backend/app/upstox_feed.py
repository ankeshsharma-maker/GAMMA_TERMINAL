"""Upstox live-quote fallback feed.

Flattrade only allows one market-data socket per login, so when that socket
is held by another session (Pi app, Pi web, a second GammaTerminal) the
broker feed sits on a 1008 "policy violation" and the charts fall back to a
slow REST poll.

This task polls Upstox `/v2/market-quote/quotes` for the watched underlyings
and pushes them through the same `set_live_spot` + `tick` path the broker WS
uses.  It runs fast (~1.5s) whenever the broker WS is down (or the broker
isn't configured at all), and slowly (10s) otherwise just to keep the BSE
indices — SENSEX / BANKEX, which Flattrade can't feed — moving.
"""
from __future__ import annotations

import asyncio
import logging
import time

from .brokers.upstox import get_upstox, INDEX_KEYS
from .brokers import get_broker
from .config import DEFAULT_SYMBOLS
from .hub import hub
from .store import store

log = logging.getLogger("upstox_feed")

_BSE = {"SENSEX", "BANKEX"}
_last_emit: dict[str, float] = {}


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def _want() -> set[str]:
    subs = {s for s, _ in hub.subscriptions()}
    wl = {e.split("|")[0].upper() for e in store.watchlist}
    return {s.upper() for s in (set(DEFAULT_SYMBOLS) | wl | subs)}


def _key_for(sym: str) -> str | None:
    if sym in INDEX_KEYS:
        return INDEX_KEYS[sym]
    ux = get_upstox()
    try:
        return ux.underlying_key(sym) or ux.instrument_key(sym)
    except Exception:  # noqa: BLE001
        return None


async def _poll_once(fast: bool) -> None:
    ux = get_upstox()
    if not ux.authed:
        return
    want = _want()
    if not fast:
        want = {s for s in want if s in _BSE}  # slow mode: only what Flattrade can't feed
    # match on every shape Upstox might echo back: the raw "EXCH|Name" key, the
    # "EXCH:Name" response-dict key, and the bare instrument name.
    keymap: dict[str, str] = {}  # any-form key -> our symbol
    req: list[str] = []
    for s in want:
        k = _key_for(s)
        if not k:
            continue
        req.append(k)
        keymap[k] = s
        keymap[k.replace("|", ":")] = s
        keymap[k.split("|", 1)[-1]] = s
    if not req:
        return
    try:
        d = await ux.get("/market-quote/quotes", {"instrument_key": ",".join(req[:250])})
    except Exception as exc:  # noqa: BLE001
        log.debug("upstox quotes poll failed: %s", exc)
        return

    data = (d or {}).get("data") or {}
    now = time.time()
    for rkey, q in data.items():
        sym = (
            keymap.get(q.get("instrument_token") or "")
            or keymap.get(rkey)
            or keymap.get(rkey.replace(":", "|"))
            or keymap.get(str(q.get("symbol") or ""))
        )
        if not sym:
            continue
        ltp = _num(q.get("last_price"))
        if ltp is None:
            continue
        prev = _num((q.get("ohlc") or {}).get("close")) or _num(q.get("close_price"))
        chg = round((ltp - prev) / prev * 100, 2) if prev else _num(q.get("net_change"))
        store.set_live_spot(sym, ltp, chg)
        if now - _last_emit.get(sym, 0) >= 0.9:
            _last_emit[sym] = now
            try:
                await hub.broadcast_all(
                    {"type": "tick", "data": {"symbol": sym, "ltp": ltp, "chgPct": chg, "ts": now}}
                )
            except Exception:  # noqa: BLE001
                pass


async def run_upstox_feed(stop: asyncio.Event) -> None:
    ux = get_upstox()
    if not ux.configured:
        log.info("upstox not configured; fallback feed disabled")
        return
    log.info("upstox fallback feed started (fast when broker WS is down, slow otherwise)")
    # let the instrument master load first so equity keys resolve
    try:
        await asyncio.wait_for(stop.wait(), timeout=8)
    except asyncio.TimeoutError:
        pass

    was_fast: bool | None = None
    while not stop.is_set():
        timeout = 10.0
        try:
            broker = get_broker()
            try:
                ws_ok = bool(
                    broker.configured
                    and broker.authed
                    and broker.status().get("wsConnected")
                )
            except Exception:  # noqa: BLE001
                ws_ok = False
            fast = not ws_ok
            if fast != was_fast:
                log.info("upstox feed -> %s mode", "FAST (broker WS down)" if fast else "slow (BSE only)")
                was_fast = fast
            await _poll_once(fast)
            timeout = 1.5 if fast else 10.0
        except Exception as exc:  # noqa: BLE001
            log.debug("upstox feed loop: %s", exc)
            timeout = 5.0
        try:
            await asyncio.wait_for(stop.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass
    log.info("upstox fallback feed stopped")
