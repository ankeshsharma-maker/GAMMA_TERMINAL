"""Upstox live-tick websocket (Market Data Feed V3) -- the "Upstox" live-feed mode.

Flattrade lets only one market-data socket live per login, so any other session (Pi app / web, a second
terminal) pushes ours into a 1008 refusal and the charts drop to a slow REST poll. The Upstox feed has no such
clash, so in this mode Upstox streams the underlyings and Flattrade only places orders (and keeps feeding the
open-position legs, which is unchanged).

The feed speaks protobuf; only the LTPC part is needed (last price, previous close), so it is read with a
small hand-written reader instead of adding a dependency. Ticks go through the same two calls the broker
feed uses (store.set_live_spot + a "tick" broadcast), so nothing downstream changes.

Setting: store.settings["liveFeed"] = "upstox" | "flattrade" (default "flattrade" until Upstox is proven live).
"""
from __future__ import annotations

import asyncio
import json
import logging
import struct
import time
from datetime import datetime
from zoneinfo import ZoneInfo

import websockets

from .brokers.upstox import get_upstox
from .hub import hub
from .store import store

log = logging.getLogger("upstox_ws")
IST = ZoneInfo("Asia/Kolkata")

_state: dict = {"connected": False, "lastMsg": 0.0, "error": None, "instruments": 0, "since": 0.0}
_last_emit: dict[str, float] = {}
_EMIT_MIN_GAP = 0.9  # same pace as the other feeds; the frontend only needs ~1 update a second


def mode() -> str:
    return "upstox" if store.settings.get("liveFeed") == "upstox" else "flattrade"


def set_mode(m: str) -> str:
    from . import db
    from .store import _lock

    with _lock:
        store.settings["liveFeed"] = "upstox" if m == "upstox" else "flattrade"
        db.set_kv("settings", store.settings)
    return mode()


def _market_open() -> bool:
    n = datetime.now(IST)
    return n.weekday() < 5 and 9 * 60 <= n.hour * 60 + n.minute <= 15 * 60 + 35


def active() -> bool:
    """True while Upstox is the live feed AND its socket is delivering: the other feeds stand down then.
    Outside market hours nothing ticks, so a connected socket counts as delivering."""
    if mode() != "upstox" or not _state["connected"]:
        return False
    return (not _market_open()) or (time.time() - _state["lastMsg"] < 15)


def status() -> dict:
    return {
        "mode": mode(),
        "connected": bool(_state["connected"]),
        "active": active(),
        "instruments": _state["instruments"],
        "lastMsgAgeS": round(time.time() - _state["lastMsg"], 1) if _state["lastMsg"] else None,
        "error": _state["error"],
    }


# ---- minimal protobuf reader -------------------------------------------------------------------
def _varint(b: bytes, i: int) -> tuple[int, int]:
    n = s = 0
    while True:
        c = b[i]
        i += 1
        n |= (c & 0x7F) << s
        s += 7
        if not c & 0x80:
            return n, i


def _parse(b: bytes) -> dict[int, list]:
    out: dict[int, list] = {}
    i = 0
    while i < len(b):
        k, i = _varint(b, i)
        f, w = k >> 3, k & 7
        if w == 0:
            v, i = _varint(b, i)
        elif w == 1:
            v = struct.unpack("<d", b[i:i + 8])[0]
            i += 8
        elif w == 2:
            n, i = _varint(b, i)
            v = b[i:i + n]
            i += n
        elif w == 5:
            v = struct.unpack("<f", b[i:i + 4])[0]
            i += 4
        else:
            raise ValueError("bad wire type")
        out.setdefault(f, []).append(v)
    return out


def decode(msg: bytes) -> list[tuple[str, float, float | None]]:
    """-> [(instrument_key, ltp, previous_close)] from one FeedResponse (empty for market-info frames)."""
    top = _parse(msg)
    res: list[tuple[str, float, float | None]] = []
    for e in top.get(2, []):
        ent = _parse(e)
        if 1 not in ent or 2 not in ent:
            continue
        key = ent[1][0].decode()
        feed = _parse(ent[2][0])
        ltpc = None
        if 1 in feed:  # Feed.ltpc
            ltpc = _parse(feed[1][0])
        elif 2 in feed:  # Feed.fullFeed -> marketFF / indexFF -> ltpc
            ff = _parse(feed[2][0])
            inner = ff.get(1) or ff.get(2)
            if inner:
                p = _parse(inner[0])
                if 1 in p:
                    ltpc = _parse(p[1][0])
        elif 3 in feed:  # Feed.firstLevelWithGreeks -> ltpc
            p = _parse(feed[3][0])
            if 1 in p:
                ltpc = _parse(p[1][0])
        if not ltpc or 1 not in ltpc:
            continue
        ltp = float(ltpc[1][0])
        cp = float(ltpc[4][0]) if 4 in ltpc else None
        res.append((key, ltp, cp))
    return res


# ---- the feed task ------------------------------------------------------------------------------
def _wanted() -> dict[str, str]:
    """instrument key -> our symbol, for everything the app currently follows (indices, watchlist, cash stocks)."""
    from .upstox_feed import _BSE, _key_for, _want

    out: dict[str, str] = {}
    for s in _want() | _BSE:
        k = _key_for(s)
        if k:
            out[k] = s
    return out


async def _emit(sym: str, ltp: float, cp: float | None) -> None:
    chg = round((ltp - cp) / cp * 100, 2) if cp else None
    store.set_live_spot(sym, ltp, chg)
    now = time.time()
    if now - _last_emit.get(sym, 0) < _EMIT_MIN_GAP:
        return
    _last_emit[sym] = now
    try:
        await hub.broadcast_all({"type": "tick", "data": {"symbol": sym, "ltp": ltp, "chgPct": chg, "ts": now}})
    except Exception:  # noqa: BLE001
        pass


async def _session(ux, stop: asyncio.Event) -> None:
    r = await ux.get("/feed/market-data-feed/authorize", v3=True)
    uri = r["data"]["authorized_redirect_uri"]
    keymap: dict[str, str] = {}
    async with websockets.connect(uri, max_size=None, ping_interval=20, ping_timeout=20) as ws:
        _state.update(connected=True, error=None, since=time.time(), lastMsg=time.time())
        log.info("upstox ws connected")
        last_sync = 0.0
        while not stop.is_set() and mode() == "upstox" and ux.authed:
            if time.time() - last_sync > 3:  # follow the watchlist: subscribe / unsubscribe the difference
                last_sync = time.time()
                want = _wanted()
                add = [k for k in want if k not in keymap]
                drop = [k for k in keymap if k not in want]
                for method, ks in (("sub", add), ("unsub", drop)):
                    for i in range(0, len(ks), 100):
                        await ws.send(json.dumps({"guid": f"g{int(time.time() * 1000)}", "method": method,
                                                  "data": {"mode": "ltpc", "instrumentKeys": ks[i:i + 100]}}).encode())
                keymap = dict(want)
                _state["instruments"] = len(keymap)
            try:
                m = await asyncio.wait_for(ws.recv(), 3)
            except asyncio.TimeoutError:
                continue
            if isinstance(m, str):
                continue
            _state["lastMsg"] = time.time()
            try:
                ticks = decode(m)
            except Exception as exc:  # noqa: BLE001
                log.debug("upstox ws decode: %s", exc)
                continue
            for key, ltp, cp in ticks:
                sym = keymap.get(key)
                if sym:
                    await _emit(sym, ltp, cp)


async def run_upstox_ws(stop: asyncio.Event) -> None:
    ux = get_upstox()
    if not ux.configured:
        log.info("upstox not configured; websocket feed disabled")
        return
    log.info("upstox websocket feed ready (runs only when Live feed = Upstox)")
    try:
        await asyncio.wait_for(stop.wait(), timeout=10)  # let the instrument master load first
    except asyncio.TimeoutError:
        pass
    backoff = 2.0
    while not stop.is_set():
        if mode() != "upstox" or not ux.authed:
            _state["connected"] = False
            try:
                await asyncio.wait_for(stop.wait(), timeout=3)
            except asyncio.TimeoutError:
                pass
            continue
        try:
            await _session(ux, stop)
            backoff = 2.0
        except Exception as exc:  # noqa: BLE001
            _state["error"] = str(exc)[:160]
            log.warning("upstox ws dropped: %s", exc)
        _state["connected"] = False
        try:
            await asyncio.wait_for(stop.wait(), timeout=backoff)
        except asyncio.TimeoutError:
            pass
        backoff = min(30.0, backoff * 1.7)
    _state["connected"] = False
