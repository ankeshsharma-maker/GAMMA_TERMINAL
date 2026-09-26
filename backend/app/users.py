"""View-only user accounts (up to 5) next to the owner's single app password.

The owner keeps logging in with APP_PASSWORD alone. Each viewer has a name and
a password (PBKDF2-hashed, never stored in the clear) and gets a stateless
token: "v1.<id>.<hmac>" signed with the app password and the user's current
hash -- so changing a viewer's password or deleting them instantly kills every
token they hold, and changing the app password kills them all.

Viewers see market data only. The server enforces it (``viewer_allowed``):
anything not on the allowlist -- orders, positions, funds, journal, broker,
AutoBot, alert settings, the owner's alerts / strategies / schedules -- is 403,
including routes added later (default deny). Their watchlists are their own
(``store`` keys them by the request's user via ``current_user``)."""
from __future__ import annotations

import contextvars
import hashlib
import hmac
import re
import secrets
import time

from . import db
from .auth import app_password, session_epoch

MAX_VIEWERS = 5
_KV = "users"

# the viewer behind the current request / socket (None = the owner). Set by the
# auth middleware and the websocket handler; read by the store's watchlists.
current_user: contextvars.ContextVar[str | None] = contextvars.ContextVar("current_user", default=None)


def _load() -> list[dict]:
    return list((db.get_kv(_KV) or {}).get("users") or [])


def _save(users: list[dict]) -> None:
    db.set_kv(_KV, {"users": users})


def _hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000).hex()


def public(u: dict) -> dict:
    return {"id": u["id"], "name": u["name"], "role": "viewer", "created": u.get("created")}


def list_users() -> list[dict]:
    return [public(u) for u in _load()]


_NAME_RE = re.compile(r"^[A-Za-z0-9 ._-]{2,24}$")


def create(name: str, password: str) -> dict:
    name = (name or "").strip()
    users = _load()
    if len(users) >= MAX_VIEWERS:
        raise ValueError(f"at most {MAX_VIEWERS} viewers")
    if not _NAME_RE.match(name):
        raise ValueError("name: 2-24 letters, digits, space, . _ -")
    if name.lower() == "owner" or any(u["name"].lower() == name.lower() for u in users):
        raise ValueError("that name is taken")
    if len(password or "") < 6:
        raise ValueError("password: at least 6 characters")
    salt = secrets.token_hex(16)
    u = {"id": secrets.token_hex(6), "name": name, "salt": salt, "hash": _hash(password, salt), "created": time.time()}
    users.append(u)
    _save(users)
    return public(u)


def set_password(uid: str, password: str) -> dict:
    if len(password or "") < 6:
        raise ValueError("password: at least 6 characters")
    users = _load()
    for u in users:
        if u["id"] == uid:
            u["salt"] = secrets.token_hex(16)
            u["hash"] = _hash(password, u["salt"])
            _save(users)
            return public(u)
    raise KeyError(uid)


def delete(uid: str) -> None:
    users = _load()
    left = [u for u in users if u["id"] != uid]
    if len(left) == len(users):
        raise KeyError(uid)
    _save(left)
    db.set_kv(f"watchlists:{uid}", None)
    db.set_kv(f"paper:{uid}", None)


def _sign(u: dict) -> str:
    # the session key too: "sign out all devices" signs viewers out as well
    ep = session_epoch()
    msg = f"viewer.{u['id']}.{u['hash']}" + (f".{ep}" if ep else "")
    return hmac.new(app_password().encode(), msg.encode(), hashlib.sha256).hexdigest()


def login(name: str, password: str) -> tuple[str, dict] | None:
    name = (name or "").strip().lower()
    for u in _load():
        if u["name"].lower() == name:
            if hmac.compare_digest(_hash(password or "", u["salt"]), u["hash"]):
                return f"v1.{u['id']}.{_sign(u)}", public(u)
            return None
    return None


def resolve(token: str | None) -> dict | None:
    """A viewer token -> the viewer (None for anything else / a revoked one)."""
    if not token or not token.startswith("v1."):
        return None
    try:
        _, uid, sig = token.split(".", 2)
    except ValueError:
        return None
    for u in _load():
        if u["id"] == uid:
            return public(u) if hmac.compare_digest(sig, _sign(u)) else None
    return None


# ---- what a viewer may reach (method, path regex); everything else is 403 ----
_SYM = r"[^/]+"
_ALLOW: list[tuple[str, re.Pattern]] = [
    (m, re.compile(p + r"$"))
    for m, p in [
        # market data
        ("GET", r"/api/symbols(/search)?"),
        ("GET", rf"/api/expiries/{_SYM}"),
        ("GET", r"/api/indices/header(/options)?"),
        # (not /api/chart/drawings -- the owner's saved drawings)
        ("GET", rf"/api/(option-chain|volatility|history|pcr|gex-intraday|oi-change|oi-walls|flow|chart)/(?!drawings$){_SYM}"),
        ("GET", rf"/api/(scan|screener)(/{_SYM})?"),
        ("GET", r"/api/(alerts|unusual)"),
        ("GET", r"/api/health"),
        ("GET", r"/api/upstox/(expiries|history-chain|history-greeks|weekly-gex|movers-history|chain-preview|data-source)"),
        ("POST", r"/api/upstox/(scan-history|indicator-scan|backtest)"),
        # their own chart layouts (GET is matched by the chart line above)
        ("POST", r"/api/chart/layouts"),
        # their own watchlists
        ("GET", r"/api/watchlists?"),
        ("POST", r"/api/watchlist"),
        ("DELETE", rf"/api/watchlist/{_SYM}"),
        ("POST", r"/api/watchlists/(add|active)"),
        ("DELETE", r"/api/watchlists/\d+"),
        ("POST", r"/api/watchlists/\d+/(rename|add|clear|add-strikes|add-future)"),
        ("DELETE", rf"/api/watchlists/\d+/{_SYM}"),
        # their own PAPER book: positions, orders, paper fills, close (never live;
        # /order, /order/future and /strategy/execute can go live and stay off)
        ("GET", r"/api/paper"),
        ("POST", r"/api/paper/(order|close|strategy)"),
        # the strategy builder, analysis only (no execute / import / save / schedule)
        ("GET", r"/api/strategy/templates"),
        ("POST", r"/api/strategy/(analyze|chart|hedge)"),
    ]
]


def viewer_allowed(method: str, path: str) -> bool:
    return any(m == method and rx.match(path) for m, rx in _ALLOW)


# ---- alerts a viewer may see: about the market, never about the owner's book ----
_MARKET_KINDS = {"blast-crit", "blast-warn", "blast-build", "iv-spike", "straddle-exp", "oi-surge", "flow-reversal"}


def market_alert(a: dict) -> bool:
    return a.get("kind") in _MARKET_KINDS or a.get("category") == "greeks"
