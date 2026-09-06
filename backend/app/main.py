"""FastAPI app: REST + WebSocket + background poller lifecycle."""
from __future__ import annotations

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.base import BaseHTTPMiddleware

from .auth import auth_middleware, auth_required, expected_token, token_ok, app_password
from .broker_feed import run_broker_feed
from .brokers import get_broker
from .hub import hub
from .nse_client import client
from .poller import run_poller, run_universe_scan
from .routes import router
from .routes_autobot import router as autobot_router
from .routes_broker import router as broker_router
from .routes_upstox import router as upstox_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = asyncio.Event()
    tasks = [
        asyncio.create_task(run_poller(stop)),
        asyncio.create_task(run_universe_scan(stop)),
        asyncio.create_task(run_broker_feed(stop)),
    ]
    try:
        yield
    finally:
        stop.set()
        for t in tasks:
            t.cancel()
        for t in tasks:
            with contextlib.suppress(asyncio.CancelledError):
                await t
        await client.aclose()
        with contextlib.suppress(Exception):
            await get_broker().aclose()
        with contextlib.suppress(Exception):
            from .brokers.upstox import get_upstox

            await get_upstox().aclose()


app = FastAPI(title="GammaTerminal API", version="0.1.0", lifespan=lifespan)
# inner: single-password gate (no-op unless APP_PASSWORD is set)
app.add_middleware(BaseHTTPMiddleware, dispatch=auth_middleware)
# outer: CORS wraps everything so even a 401 carries the headers the APK needs
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(router)
app.include_router(broker_router)
app.include_router(autobot_router)
app.include_router(upstox_router)


@app.get("/api/health")
def health():
    from .store import store

    return {
        "ok": True,
        "symbols": store.all_symbols(),
        "expiries": {k: v[:3] for k, v in store.expiries.items()},
        "errors": store.errors,
        "lastFetch": {f"{s}|{e}": ts for (s, e), ts in store.fetched_at.items()},
    }


@app.get("/api/auth/status")
def auth_status(request: Request):
    h = request.headers.get("authorization") or ""
    tok = h[7:].strip() if h.lower().startswith("bearer ") else request.headers.get("x-app-token")
    return {"required": auth_required(), "ok": token_ok(tok)}


@app.post("/api/auth/login")
async def auth_login(body: dict):
    if not auth_required():
        return {"token": "", "required": False}
    if (body.get("password") or "").strip() != app_password():
        raise HTTPException(status_code=401, detail="Wrong password")
    return {"token": expected_token(), "required": True}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    if auth_required():
        tok = ws.query_params.get("token") or ws.headers.get("x-app-token")
        if not token_ok(tok):
            await ws.close(code=1008)
            return
    await hub.connect(ws)
    try:
        while True:
            msg = await ws.receive_json()
            action = msg.get("action")
            if action == "subscribe":
                await hub.subscribe(ws, msg["symbol"], msg.get("expiry"))
            elif action == "unsubscribe":
                await hub.unsubscribe(ws, msg["symbol"])
            elif action == "ping":
                await hub.send(ws, {"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        await hub.disconnect(ws)
