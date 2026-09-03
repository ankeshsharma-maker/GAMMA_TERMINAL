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
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self._conns[ws] = {}
        await self.send(ws, {"type": "watchlist", "data": store.watch_quotes()})
        await self.send(ws, {"type": "scan", "data": store.get_scan()})
        await self.send(ws, {"type": "alerts", "data": store.get_alerts(50)})
        await self.send(ws, {"type": "unusual", "data": store.get_unusual(60)})
        await self.send(
            ws,
            {"type": "screener", "data": store.get_universe(), "progress": store.universe_progress},
        )

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            self._conns.pop(ws, None)

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
            await self.send(ws, {"type": "watchlist", "data": quotes})

    async def broadcast_all(self, msg: dict) -> None:
        async with self._lock:
            conns = list(self._conns)
        for ws in conns:
            await self.send(ws, msg)


hub = Hub()
