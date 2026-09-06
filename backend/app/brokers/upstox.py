"""Upstox as a *data* source (not orders — orders stay on Flattrade).

OAuth2 auth-code flow:
  1. browser -> GET https://api.upstox.com/v2/login/authorization/dialog
       ?response_type=code&client_id=<API_KEY>&redirect_uri=<REDIRECT>
  2. Upstox redirects back to <REDIRECT>?code=<auth_code>
  3. POST https://api.upstox.com/v2/login/authorization/token
       {code, client_id, client_secret, redirect_uri, grant_type=authorization_code}
       -> {access_token, ...}

The access token expires ~03:30 IST daily (same daily-login pattern as
Flattrade). It is cached in data/upstox_session.json with the date it was
issued; a stale one is dropped on load.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime
from pathlib import Path

import httpx

from ..config import (
    DATA_DIR,
    UPSTOX_ACCESS_TOKEN,
    UPSTOX_API_KEY,
    UPSTOX_API_SECRET,
    UPSTOX_REDIRECT_URL,
)

log = logging.getLogger("upstox")

_API = "https://api.upstox.com/v2"
_SESSION_FILE = Path(DATA_DIR) / "upstox_session.json"

# underlying -> Upstox instrument_key (indices). Equities/others fall back to a
# SearchScrip-style lookup via the instrument master (added later).
INDEX_KEYS = {
    "NIFTY": "NSE_INDEX|Nifty 50",
    "BANKNIFTY": "NSE_INDEX|Nifty Bank",
    "FINNIFTY": "NSE_INDEX|Nifty Fin Service",
    "MIDCPNIFTY": "NSE_INDEX|NIFTY MID SELECT",
    "NIFTYNXT50": "NSE_INDEX|Nifty Next 50",
    "SENSEX": "BSE_INDEX|SENSEX",
    "BANKEX": "BSE_INDEX|BANKEX",
    "INDIA VIX": "NSE_INDEX|India VIX",
}


def _today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


class Upstox:
    def __init__(self) -> None:
        self._token: str | None = None
        self._token_date: str = ""
        self._http = httpx.AsyncClient(timeout=15.0)
        if UPSTOX_ACCESS_TOKEN:
            # 1-year analytics token from the env — no OAuth, no daily login
            self._token = UPSTOX_ACCESS_TOKEN.strip()
            self._static = True
            log.info("upstox: using static analytics access token")
        else:
            self._static = False
            self._load_session()

    # ---- config / status --------------------------------------------
    @property
    def configured(self) -> bool:
        return bool(UPSTOX_ACCESS_TOKEN) or bool(
            UPSTOX_API_KEY and UPSTOX_API_SECRET and UPSTOX_REDIRECT_URL
        )

    @property
    def authed(self) -> bool:
        if not self._token:
            return False
        return self._static or self._token_date == _today()

    def status(self) -> dict:
        return {
            "configured": self.configured,
            "authed": self.authed,
            "static": self._static,
            "tokenDate": None if self._static else (self._token_date or None),
            "redirectUrl": UPSTOX_REDIRECT_URL,
        }

    # ---- session persistence --------------------------------------------
    def _load_session(self) -> None:
        try:
            d = json.loads(_SESSION_FILE.read_text())
        except Exception:  # noqa: BLE001
            return
        if d.get("date") == _today() and d.get("access_token"):
            self._token = d["access_token"]
            self._token_date = d["date"]
            log.info("upstox session restored (%s)", self._token_date)
        else:
            log.info("upstox session stale (%s) - re-login needed", d.get("date"))

    def _save_session(self) -> None:
        try:
            _SESSION_FILE.write_text(
                json.dumps({"access_token": self._token, "date": self._token_date})
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("could not persist upstox session: %s", exc)

    # ---- OAuth --------------------------------------------------------
    def login_url(self) -> str:
        return (
            f"{_API}/login/authorization/dialog?response_type=code"
            f"&client_id={UPSTOX_API_KEY}&redirect_uri={UPSTOX_REDIRECT_URL}"
        )

    async def exchange_code(self, code: str) -> None:
        r = await self._http.post(
            f"{_API}/login/authorization/token",
            data={
                "code": code,
                "client_id": UPSTOX_API_KEY,
                "client_secret": UPSTOX_API_SECRET,
                "redirect_uri": UPSTOX_REDIRECT_URL,
                "grant_type": "authorization_code",
            },
            headers={"accept": "application/json"},
        )
        r.raise_for_status()
        tok = r.json().get("access_token")
        if not tok:
            raise RuntimeError(f"no access_token in response: {r.text[:200]}")
        self.set_token(tok)

    def set_token(self, token: str) -> None:
        self._token = token.strip()
        self._token_date = _today()
        self._save_session()
        log.info("upstox token set (%s)", self._token_date)

    def clear(self) -> None:
        if self._static:
            # env-provided token — nothing to clear; it returns on restart
            log.warning("upstox: static analytics token was rejected — check it hasn't expired/revoked")
            return
        self._token = None
        self._token_date = ""
        try:
            _SESSION_FILE.unlink(missing_ok=True)
        except Exception:  # noqa: BLE001
            pass

    # ---- authed GET ------------------------------------------------------
    async def get(self, path: str, params: dict | None = None) -> dict:
        if not self.authed:
            raise RuntimeError("Upstox not authenticated")
        r = await self._http.get(
            f"{_API}{path}",
            params=params or {},
            headers={"Authorization": f"Bearer {self._token}", "Accept": "application/json"},
        )
        if r.status_code == 401:
            self.clear()
            raise RuntimeError("Upstox token rejected (401) - re-login")
        r.raise_for_status()
        return r.json()

    def instrument_key(self, symbol: str) -> str | None:
        return INDEX_KEYS.get(symbol.upper())

    async def aclose(self) -> None:
        await self._http.aclose()


_upstox: Upstox | None = None


def get_upstox() -> Upstox:
    global _upstox
    if _upstox is None:
        _upstox = Upstox()
    return _upstox
