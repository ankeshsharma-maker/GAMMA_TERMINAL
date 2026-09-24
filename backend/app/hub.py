"""WebSocket connection manager + broadcast helpers."""
from __future__ import annotations

import asyncio
import contextlib
from typing import Optional

from fastapi import WebSocket

from .store import store


class Hub:
    def __init__(self) -> None:
        self._conns: dict[WebSocket, dict[str, Optional[str]]] = {}
        # the view-only user behind each socket (absent = the owner)
        self._viewer: dict[WebSocket, str] = {}
        self._lock = asyncio.Lock()

    def _for(self, ws: WebSocket, msg: dict) -> Optional[dict]:
        """What this socket may receive: the owner gets everything; a viewer
        only market data (chain / scan / screener / unusual / market alerts /
        their own watchlist) -- never positions, AutoBot, the owner's rules or
        alerts about the owner's positions. Unknown types are dropped."""
        if ws not in self._viewer:
            return msg
        t = msg.get("type")
        if t in ("chain", "scan", "screener", "unusual", "pong", "error"):
            return msg
        if t == "alerts":
            from .users import market_alert

            return {**msg, "data": [a for a in (msg.get("data") or []) if market_alert(a)]}
        if t == "tick":
            # plain underlyings only -- the broker feed also ticks the owner's
            # position contracts, which would give away what they hold
            sym = str((msg.get("data") or {}).get("symbol") or "").upper()
            return msg if sym in set(store.all_symbols()) else None
        return None

    def _quotes_for(self, ws: WebSocket) -> list:
        from .users import current_user

        tok = current_user.set(self._viewer.get(ws))
        try:
            return store.watch_quotes()
        finally:
            current_user.reset(tok)

    async def connect(self, ws: WebSocket, viewer_id: Optional[str] = None) -> None:
        await ws.accept()
        async with self._lock:
            self._conns[ws] = {}
            if viewer_id:
                self._viewer[ws] = viewer_id
        # send the initial state, but never let one bad payload abort the
        # handshake — that was dropping the socket and forcing the client
        # into a reconnect loop (= "no live updates / slowness").
        try:  # the socket's own user's watchlist -- sent as is, never filtered
            await self.send(ws, {"type": "watchlist", "data": self._quotes_for(ws)})
        except Exception:  # noqa: BLE001
            pass
        for msg in (
            lambda: {"type": "scan", "data": store.get_scan()},
            lambda: {"type": "alerts", "data": store.get_alerts(50)},
            lambda: {"type": "unusual", "data": store.get_unusual(60)},
            lambda: {
                "type": "screener",
                "data": store.get_universe(),
                "progress": store.universe_progress,
            },
            lambda: {"type": "positions", "data": store.live_positions()},
        ):
            try:
                m = self._for(ws, msg())
                if m is not None:
                    await self.send(ws, m)
            except Exception:  # noqa: BLE001
                pass

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._conns.pop(ws, None)
            self._viewer.pop(ws, None)

    async def kick_all(self) -> None:
        """Every device was signed out: close every open socket (their tokens are
        already dead, so the app's reconnect fails and it asks for the password)."""
        async with self._lock:
            socks = list(self._conns)
        for ws in socks:
            try:
                await ws.close(code=1008)
            except Exception:  # noqa: BLE001
                pass
            await self.disconnect(ws)

    async def kick_viewer(self, viewer_id: str) -> None:
        """A viewer was removed or given a new password: close their open
        sockets now (their tokens are already dead for every HTTP call; the
        app's reconnect then fails and it shows the sign-in screen)."""
        async with self._lock:
            socks = [ws for ws, v in self._viewer.items() if v == viewer_id]
        for ws in socks:
            try:
                await ws.close(code=1008)
            except Exception:  # noqa: BLE001
                pass
            await self.disconnect(ws)

    async def subscribe(self, ws: WebSocket, symbol: str, expiry: Optional[str]) -> None:
        symbol = symbol.upper()
        async with self._lock:
            self._conns.setdefault(ws, {})[symbol] = expiry
        chain = store.get_chain(symbol, expiry)
        if chain:
            await self.send(ws, {"type": "chain", "data": chain})
        elif symbol in store.errors:
            await self.send(ws, {"type": "error", "symbol": symbol, "message": store.errors[symbol]})

    async def unsubscribe(self, ws: WebSocket, symbol: str) -> None:
        async with self._lock:
            self._conns.get(ws, {}).pop(symbol.upper(), None)

    def subscriptions(self) -> list[tuple[str, Optional[str]]]:
        pairs: set[tuple[str, Optional[str]]] = set()
        for subs in self._conns.values():
            for sym, exp in subs.items():
                pairs.add((sym, exp))
        return list(pairs)

    async def send(self, ws: WebSocket, msg: dict) -> None:
        with contextlib.suppress(Exception):
            await ws.send_json(msg)

    async def broadcast(self, symbol: str, expiry: str) -> None:
        symbol = symbol.upper()
        async with self._lock:
            targets = []
            for ws, subs in self._conns.items():
                if symbol not in subs:
                    continue
                if store.resolve_expiry(symbol, subs[symbol]) == expiry:
                    targets.append((ws, subs[symbol]))
        for ws, sub_exp in targets:
            chain = store.get_chain(symbol, sub_exp)
            if chain:
                await self.send(ws, {"type": "chain", "data": chain})

    async def broadcast_watchlist(self) -> None:
        quotes = store.watch_quotes()
        async with self._lock:
            conns = list(self._conns)
        for ws in conns:
            # each socket gets ITS user's watchlist (the owner's is computed once)
            await self.send(ws, {"type": "watchlist", "data": quotes if ws not in self._viewer else self._quotes_for(ws)})

    async def broadcast_all(self, msg: dict) -> None:
        async with self._lock:
            conns = list(self._conns)
        for ws in conns:
            m = self._for(ws, msg)
            if m is not None:
                await self.send(ws, m)


hub = Hub()
