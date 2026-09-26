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
from .broker_feed import run_broker_feed, run_position_feed
from .brokers import get_broker
from .upstox_feed import run_upstox_feed
from .hub import hub
from .nse_client import client
from .poller import run_poller, run_universe_scan
from . import volume_screener
from .routes import router
from .routes_autobot import router as autobot_router
from .routes_broker import router as broker_router
from .routes_upstox import router as upstox_router

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


async def _load_lot_sizes() -> None:
    """Pull the exchange lot-size map from the Upstox instrument dump so the
    builder / analyzer / paper book use real F&O stock lot sizes."""
    try:
        from .brokers.upstox import get_upstox

        ux = get_upstox()
        if ux.authed:
            await ux.load_instruments()
    except Exception:  # noqa: BLE001
        pass


@asynccontextmanager
async def lifespan(app: FastAPI):
    stop = asyncio.Event()
    tasks = [
        asyncio.create_task(run_poller(stop)),
        asyncio.create_task(run_universe_scan(stop)),
        asyncio.create_task(run_broker_feed(stop)),
        asyncio.create_task(run_position_feed(stop)),
        asyncio.create_task(run_upstox_feed(stop)),
        asyncio.create_task(volume_screener.run_baseline(stop)),
        asyncio.create_task(volume_screener.run_quotes(stop)),
        asyncio.create_task(_load_lot_sizes()),
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
    from . import users

    h = request.headers.get("authorization") or ""
    tok = h[7:].strip() if h.lower().startswith("bearer ") else request.headers.get("x-app-token")
    if token_ok(tok):
        return {"required": auth_required(), "ok": True, "role": "owner", "name": None}
    viewer = users.resolve(tok)
    if viewer:
        return {"required": True, "ok": True, "role": "viewer", "name": viewer["name"]}
    return {"required": auth_required(), "ok": False, "role": None, "name": None}


@app.post("/api/auth/login")
async def auth_login(body: dict):
    """The owner: {password}. A view-only user: {name, password}."""
    from . import users

    if not auth_required():
        return {"token": "", "required": False, "role": "owner"}
    name = (body.get("name") or "").strip()
    if name and name.lower() != "owner":
        got = users.login(name, body.get("password") or "")
        if not got:
            raise HTTPException(status_code=401, detail="Wrong name or password")
        return {"token": got[0], "required": True, "role": "viewer", "name": got[1]["name"]}
    if (body.get("password") or "").strip() != app_password():
        raise HTTPException(status_code=401, detail="Wrong password")
    return {"token": expected_token(), "required": True, "role": "owner"}


@app.post("/api/sessions/logout-all")
async def logout_all():
    """Sign out every device -- this one too. Owner only: it's behind the auth
    middleware and not on the viewer allowlist. A new session key changes every
    owner and viewer token, and every open live socket is closed now."""
    from .auth import rotate_sessions

    rotate_sessions()
    await hub.kick_all()
    return {"ok": True}


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    from . import users

    viewer_id = None
    if auth_required():
        tok = ws.query_params.get("token") or ws.headers.get("x-app-token")
        if not token_ok(tok):
            viewer = users.resolve(tok)
            if not viewer:
                await ws.close(code=1008)
                return
            # a view-only socket: its own watchlist, market data only (hub filters)
            viewer_id = viewer["id"]
            users.current_user.set(viewer_id)
    await hub.connect(ws, viewer_id)
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
