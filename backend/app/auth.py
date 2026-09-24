"""Optional single-password gate for the whole API.

Set ``APP_PASSWORD`` in the environment to turn it on. When it is unset or
empty every request passes through unchanged (so a fresh checkout / an
un-migrated server keeps working exactly as before).

The owner logs in with the password alone and gets a bearer token (an HMAC of
the password and the current session key, so the password itself never
travels again and the token is stable across restarts). "Sign out all
devices" (``rotate_sessions``) replaces the session key: every token --
the owner's and every viewer's -- stops working at once. Up to 5 VIEW-ONLY users (users.py) log in with a name +
password and get their own token; for them the middleware lets through only
the market-data allowlist in users.py and answers everything else 403. Every
other ``/api`` route and the ``/ws`` socket must present a token.
"""
from __future__ import annotations

import hmac
import os
import secrets
from hashlib import sha256

from fastapi import Request
from fastapi.responses import JSONResponse

# paths reachable without a token (login itself, the auth probe, health,
# the Flattrade OAuth redirect, and anything that isn't the API)
_OPEN_PREFIXES = (
    "/api/auth/login",
    "/api/auth/status",
    "/api/health",
    "/api/broker/callback",
)


def app_password() -> str:
    return (os.getenv("APP_PASSWORD") or "").strip()


def auth_required() -> bool:
    return bool(app_password())


# the session key: "" until the first "sign out all devices" (so tokens issued
# before this existed stay valid until then); cached -- one backend process
_EPOCH_KV = "auth_epoch"
_epoch: str | None = None


def session_epoch() -> str:
    global _epoch
    if _epoch is None:
        from . import db

        v = db.get_kv(_EPOCH_KV)
        _epoch = v if isinstance(v, str) else ""
    return _epoch


def rotate_sessions() -> None:
    """Sign out every device: a new session key changes every token."""
    global _epoch
    from . import db

    _epoch = secrets.token_hex(16)
    db.set_kv(_EPOCH_KV, _epoch)


def expected_token() -> str:
    """Derived from the password + the session key -- nothing per device stored."""
    ep = session_epoch()
    msg = b"gammaterminal.v1" + (f".{ep}".encode() if ep else b"")
    return hmac.new(app_password().encode(), msg, sha256).hexdigest()


def token_ok(token: str | None) -> bool:
    if not auth_required():
        return True
    return bool(token) and hmac.compare_digest(token, expected_token())


def _bearer(request: Request) -> str | None:
    h = request.headers.get("authorization") or ""
    if h.lower().startswith("bearer "):
        return h[7:].strip()
    return request.headers.get("x-app-token")


async def auth_middleware(request: Request, call_next):
    path = request.url.path
    if (
        not auth_required()
        or not path.startswith("/api/")
        or path.startswith(_OPEN_PREFIXES)
    ):
        return await call_next(request)
    tok = _bearer(request)
    if token_ok(tok):
        return await call_next(request)  # the owner
    from . import users

    viewer = users.resolve(tok)
    if not viewer:
        return JSONResponse({"detail": "Login required"}, status_code=401)
    if not users.viewer_allowed(request.method, path):
        return JSONResponse({"detail": "View-only account"}, status_code=403)
    request.state.viewer = viewer
    ctx = users.current_user.set(viewer["id"])
    try:
        return await call_next(request)
    finally:
        users.current_user.reset(ctx)
