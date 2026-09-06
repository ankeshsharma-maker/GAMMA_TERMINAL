"""Optional single-password gate for the whole API.

Set ``APP_PASSWORD`` in the environment to turn it on. When it is unset or
empty every request passes through unchanged (so a fresh checkout / an
un-migrated server keeps working exactly as before).

There are no user accounts — it is a solo trading terminal. ``/api/auth/login``
takes the password and hands back a bearer token (an HMAC of the password, so
the password itself never travels again and the token is stable across
restarts). Every other ``/api`` route and the ``/ws`` socket must present it.
"""
from __future__ import annotations

import hmac
import os
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


def expected_token() -> str:
    """Deterministic token derived from the password — no server-side storage."""
    return hmac.new(app_password().encode(), b"gammaterminal.v1", sha256).hexdigest()


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
    if not token_ok(_bearer(request)):
        return JSONResponse({"detail": "Login required"}, status_code=401)
    return await call_next(request)
