"""Flattrade (Noren / Pi Connect) adapter.

Auth flow:
  1. browser -> https://auth.flattrade.in/?app_key=<API_KEY>
  2. after login Flattrade redirects to REDIRECT_URL?code=<request_code>&client=<CLIENT>
  3. POST https://authapi.flattrade.in/trade/apitoken
     {api_key, request_code, api_secret: sha256(api_key + request_code + api_secret)}
     -> {token, client}
Session token is good for the trading day; cached in data/broker_session.json.

REST: POST https://piconnect.flattrade.in/PiConnectAPI/<Endpoint>  body: jData=<json>&jKey=<token>
WS:   wss://piconnect.flattrade.in/PiConnectWSAPI/
(host + WS match flattrade's own reference client: github.com/flattrade/pythonAPI)
"""
from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import re
import struct
import time
from datetime import datetime
from typing import Awaitable, Callable


def _totp(secret: str) -> str:
    """RFC-6238 TOTP (30s, 6 digits, SHA-1). `secret` is the base32 string from
    the broker's 2FA setup. If a 6-digit code is passed instead, it's returned
    as-is so the same field accepts either."""
    s = (secret or "").strip().replace(" ", "")
    if s.isdigit() and len(s) == 6:
        return s
    key = base64.b32decode(s.upper() + "=" * ((8 - len(s) % 8) % 8))
    counter = struct.pack(">Q", int(time.time()) // 30)
    digest = hmac.new(key, counter, hashlib.sha1).digest()
    off = digest[-1] & 0x0F
    code = (struct.unpack(">I", digest[off:off + 4])[0] & 0x7FFFFFFF) % 1_000_000
    return f"{code:06d}"

import httpx

try:
    import websockets
except ImportError:  # pragma: no cover
    websockets = None

from ..config import (
    DATA_DIR,
    FLATTRADE_API_KEY,
    FLATTRADE_API_SECRET,
    FLATTRADE_CLIENT_ID,
    FLATTRADE_REDIRECT_URL,
    INDEX_FEED_TOKENS,
)

log = logging.getLogger("flattrade")

_AUTH_URL = "https://auth.flattrade.in/"
_TOKEN_URL = "https://authapi.flattrade.in/trade/apitoken"
# Base URLs per flattrade's official python client (github.com/flattrade/pythonAPI):
#   host      = https://piconnect.flattrade.in/PiConnectAPI/
#   websocket = wss://piconnect.flattrade.in/PiConnectWSAPI/
# (was NorenWClientTP / PiConnectWSTp — a legacy path that pattern-matches but
#  rejects current-gen session tokens with "Invalid Session Key".)
_REST = "https://piconnect.flattrade.in/PiConnectAPI"
_WS = "wss://piconnect.flattrade.in/PiConnectWSAPI/"
_SESSION_FILE = DATA_DIR / "broker_session.json"

# Flattrade sits behind Cloudflare, which 404s/blocks header-less datacentre requests.
_BROWSERISH = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://pi.flattrade.in",
    "Referer": "https://pi.flattrade.in/",
}

TickHandler = Callable[[str, dict], Awaitable[None] | None]

_TSYM_RE = re.compile(r"^([A-Z]+)(\d{2}[A-Z]{3}\d{2})([CP])(\d+(?:\.\d+)?)$")


def parse_noren_tsym(tsym: str) -> dict | None:
    """Reverse of resolve_nfo's tsym build: 'NIFTY08SEP26C24050' ->
    {symbol, expiry ('08-Sep-2026'), optionType, strike}. None if tsym isn't a
    NFO option in that conventional form (e.g. an equity '-EQ' symbol)."""
    m = _TSYM_RE.match((tsym or "").upper())
    if not m:
        return None
    name, datepart, cp, strike_s = m.groups()
    try:
        d = datetime.strptime(datepart, "%d%b%y")
    except ValueError:
        return None
    return {
        "symbol": name,
        "expiry": d.strftime("%d-%b-%Y"),
        "optionType": "CE" if cp == "C" else "PE",
        "strike": float(strike_s),
    }


class FlattradeBroker:
    name = "flattrade"

    def __init__(self) -> None:
        self.api_key = FLATTRADE_API_KEY
        self.api_secret = FLATTRADE_API_SECRET
        self.client_id = FLATTRADE_CLIENT_ID
        self.redirect_url = FLATTRADE_REDIRECT_URL
        self._token: str | None = None
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(15.0), follow_redirects=True, headers=_BROWSERISH
        )
        self._ws = None
        self._ws_task: asyncio.Task | None = None
        self._exchanges: dict[str, dict] = {}  # endpoint -> last {request, response} (jKey masked)
        self._subs: set[str] = set()
        self._on_tick: TickHandler | None = None
        self._ws_connected = False
        self._load_session()

    # ---- config / session -------------------------------------------
    @property
    def configured(self) -> bool:
        return bool(self.api_key and self.api_secret and self.client_id)

    @property
    def authed(self) -> bool:
        return bool(self._token)

    def _load_session(self) -> None:
        try:
            data = json.loads(_SESSION_FILE.read_text("utf-8"))
        except (FileNotFoundError, ValueError):
            return
        today = datetime.now().strftime("%Y-%m-%d")
        if data.get("date") == today and data.get("token"):
            self._token = data["token"]
            if data.get("client"):
                self.client_id = data["client"].upper()
            log.info("restored Flattrade session for %s", self.client_id)

    def _save_session(self) -> None:
        _SESSION_FILE.write_text(
            json.dumps(
                {
                    "token": self._token,
                    "client": self.client_id,
                    "date": datetime.now().strftime("%Y-%m-%d"),
                    "savedAt": time.time(),
                }
            ),
            "utf-8",
        )

    def login_url(self) -> str:
        return f"{_AUTH_URL}?app_key={self.api_key}"

    async def direct_login(
        self, uid: str, pwd: str, totp: str, vc: str = "", api_key: str = ""
    ) -> dict:
        """Noren QuickAuth: uid + password + TOTP -> session token, no OAuth redirect.
        `totp` may be the base32 2FA secret (code computed here) or a live 6-digit code.
        `vc` (vendor code) defaults to `<uid>_U`; `api_key` defaults to the .env key."""
        uid = uid.strip().upper()
        vc = (vc or f"{uid}_U").strip()
        key = (api_key or self.api_key or "").strip()
        code = _totp(totp)
        payload = {
            "source": "API",
            "apkversion": "1.0.0",
            "uid": uid,
            "pwd": hashlib.sha256(pwd.encode()).hexdigest(),
            "factor2": code,
            "vc": vc,
            "appkey": hashlib.sha256(f"{uid}|{key}".encode()).hexdigest(),
            "imei": "gammaterminal",
        }
        raw = f"jData={json.dumps(payload, separators=(',', ':'))}"
        r = await self._http.post(
            f"{_REST}/QuickAuth",
            content=raw,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        try:
            data = r.json()
        except ValueError:
            raise RuntimeError(f"QuickAuth: non-JSON response ({r.status_code}) {r.text[:200]}")
        log.info("Flattrade QuickAuth: http=%s stat=%s emsg=%s", r.status_code, data.get("stat"), data.get("emsg"))
        if data.get("stat") == "Ok" and data.get("susertoken"):
            self._token = data["susertoken"]
            self.client_id = uid
            self._save_session()
            if self._ws_task:
                self._ws_task.cancel()
                self._ws_task = None
            log.info("Flattrade QuickAuth ok for %s", uid)
            return {"ok": True, "client": uid}
        raise RuntimeError(f"QuickAuth failed: {data.get('emsg') or data}")

    def set_token(self, token: str, client: str | None = None) -> dict:
        """Manually install a session token (e.g. one generated from the Flattrade
        portal directly), bypassing the OAuth redirect."""
        token = (token or "").strip()
        if not token:
            raise RuntimeError("empty token")
        self._token = token
        if client:
            self.client_id = client.strip().upper()
        self._save_session()
        log.info("Flattrade token set manually for %s (len=%s)", self.client_id, len(token))
        # kick the WS to reconnect with the new token
        if self._ws_task:
            self._ws_task.cancel()
            self._ws_task = None
        return {"ok": True, "client": self.client_id}

    async def exchange_token(self, request_code: str) -> dict:
        if not self.configured:
            raise RuntimeError("Flattrade API key / secret / client id not set in .env")
        hashed = hashlib.sha256(
            (self.api_key + request_code + self.api_secret).encode()
        ).hexdigest()
        resp = await self._http.post(
            _TOKEN_URL,
            json={"api_key": self.api_key, "request_code": request_code, "api_secret": hashed},
        )
        data = resp.json()
        log.info(
            "Flattrade apitoken resp: http=%s keys=%s stat=%s emsg=%s token_len=%s client=%s",
            resp.status_code, sorted(data) if isinstance(data, dict) else type(data),
            data.get("stat"), data.get("emsg"), len(data.get("token") or ""), data.get("client"),
        )
        if data.get("stat") == "Ok" and data.get("token"):
            self._token = data["token"]
            if data.get("client"):
                self.client_id = data["client"].upper()
            self._save_session()
            log.info("Flattrade authenticated as %s (token_len=%s)", self.client_id, len(self._token))
            return {"ok": True, "client": self.client_id}
        raise RuntimeError(f"token exchange failed: {data.get('emsg') or data}")

    def logout(self) -> None:
        self._token = None
        try:
            _SESSION_FILE.unlink()
        except FileNotFoundError:
            pass

    def status(self) -> dict:
        return {
            "broker": self.name,
            "configured": self.configured,
            "authed": self.authed,
            "clientId": self.client_id if self.authed else None,
            "wsConnected": self._ws_connected,
        }

    def last_exchange(self, endpoint: str | None = None) -> dict:
        """The last request/response per Noren endpoint (jKey masked), for support tickets."""
        if endpoint:
            return self._exchanges.get(endpoint, {})
        return dict(self._exchanges)

    async def refresh(self) -> dict:
        """Re-read the persisted session, validate the token with a live call,
        and bounce the WebSocket feed so it reconnects. Driven by the header
        'refresh broker' button."""
        self._load_session()
        ok, err = False, None
        if self._token:
            try:
                r = await self._post("UserDetails", {})
                ok = isinstance(r, dict) and r.get("stat") == "Ok"
                if not ok:
                    err = (r or {}).get("emsg") or "token rejected"
            except Exception as exc:  # noqa: BLE001
                err = str(exc)
        else:
            err = "no session token"
        # bounce the WS regardless so a dropped/stale socket reconnects
        if self._ws_task:
            self._ws_task.cancel()
            self._ws_task = None
        self._ws_connected = False
        self._subs.clear()
        if ok and self._on_tick:
            try:
                await self.start_ws(self._on_tick)
            except Exception as exc:  # noqa: BLE001
                log.warning("refresh: WS restart failed: %s", exc)
        return {"ok": ok, "error": err, **self.status()}

    # ---- REST helper -----------------------------------------------
    async def _post(self, endpoint: str, payload: dict) -> dict | list:
        if not self._token:
            raise RuntimeError("not authenticated with Flattrade")
        body = {"uid": self.client_id, **payload}
        url = f"{_REST}/{endpoint}"
        # Noren wants the body as the literal string `jData=<compact-json>&jKey=<token>`
        # (NOT form-encoded key/values — that yields "jData is not valid json object").
        jdata = json.dumps(body, separators=(",", ":"))
        raw = f"jData={jdata}&jKey={self._token}"
        r = await self._http.post(
            url, content=raw, headers={"Content-Type": "application/x-www-form-urlencoded"}
        )
        # keep the last request/response per endpoint so it can be handed to
        # broker support verbatim (jKey masked). See GET /api/broker/last-request.
        self._exchanges[endpoint] = {
            "ts": datetime.now().isoformat(timespec="seconds"),
            "method": "POST",
            "url": url,
            "contentType": "application/x-www-form-urlencoded",
            "jData": jdata,
            "requestBody": f"jData={jdata}&jKey=<{len(self._token or '')}-char session token, masked>",
            "httpStatus": r.status_code,
            "responseText": (r.text or "")[:2000],
        }
        try:
            data = r.json()
        except ValueError:
            snippet = (r.text or "")[:300].replace("\n", " ")
            log.warning(
                "Flattrade %s -> HTTP %s (%s) at %s :: %s",
                endpoint, r.status_code, r.headers.get("content-type", "?"), r.url, snippet,
            )
            raise RuntimeError(f"{endpoint}: non-JSON response ({r.status_code})")
        if isinstance(data, dict) and data.get("stat") not in ("Ok", None):
            if "emsg" in data and "no data" in data["emsg"].lower():
                return data
            raise RuntimeError(f"{endpoint}: {data.get('emsg', data)}")
        return data

    # ---- account -------------------------------------------------
    async def funds(self) -> dict:
        return await self._post("Limits", {"actid": self.client_id})

    async def positions(self) -> list:
        out = await self._post("PositionBook", {"actid": self.client_id})
        return out if isinstance(out, list) else []

    async def order_book(self) -> list:
        out = await self._post("OrderBook", {"actid": self.client_id})
        return out if isinstance(out, list) else []

    async def holdings(self) -> list:
        out = await self._post("Holdings", {"actid": self.client_id, "prd": "C"})
        return out if isinstance(out, list) else []

    # ---- instruments / quotes / history -----------------------------
    async def search_scrip(self, exch: str, text: str) -> list:
        out = await self._post("SearchScrip", {"stext": text, "exch": exch})
        return out.get("values", []) if isinstance(out, dict) else []

    async def get_option_chain(self, exch: str, tsym: str, strprc: str, cnt: int = 15) -> dict:
        """Noren GetOptionChain: strikes + tokens around `strprc` for the expiry encoded in `tsym`."""
        out = await self._post(
            "GetOptionChain",
            {"exch": exch, "tsym": tsym, "strprc": str(strprc), "cnt": str(cnt)},
        )
        return out if isinstance(out, dict) else {"stat": "Not_Ok", "raw": out}

    async def feed_token(self, symbol: str) -> tuple[str, str] | None:
        sym = symbol.upper()
        if sym in INDEX_FEED_TOKENS:
            return INDEX_FEED_TOKENS[sym]
        vals = await self.search_scrip("NSE", sym)
        for v in vals:
            if v.get("tsym", "").upper() in (f"{sym}-EQ", sym) and v.get("token"):
                return ("NSE", v["token"])
        return ("NSE", vals[0]["token"]) if vals and vals[0].get("token") else None

    async def quotes(self, exch: str, token: str) -> dict:
        out = await self._post("GetQuotes", {"exch": exch, "token": token})
        return out if isinstance(out, dict) else {}

    async def tpseries(
        self, exch: str, token: str, minutes_back: int = 1500, interval: str = "1"
    ) -> list[dict]:
        et = int(time.time())
        st = et - minutes_back * 60
        out = await self._post(
            "TPSeries",
            {"exch": exch, "token": token, "st": str(st), "et": str(et), "intrv": interval},
        )
        rows = out if isinstance(out, list) else []
        candles: list[dict] = []
        for r in rows:
            try:
                t = datetime.strptime(r["time"], "%d-%m-%Y %H:%M:%S").timestamp()
                candles.append(
                    {
                        "time": int(t),
                        "open": float(r["into"]),
                        "high": float(r["inth"]),
                        "low": float(r["intl"]),
                        "close": float(r["intc"]),
                        "volume": float(r.get("intv", 0) or 0),
                    }
                )
            except (KeyError, ValueError):
                continue
        candles.sort(key=lambda c: c["time"])
        return candles

    # ---- orders -------------------------------------------------
    async def resolve_nfo(self, name: str, expiry: str, strike: float, opt_type: str) -> dict:
        """Resolve an NFO option contract to its Noren trading symbol / token / lot size.

        `expiry` is the NSE form 'DD-Mon-YYYY'. Builds the conventional Noren tsym
        (e.g. NIFTY08SEP26C24050) and confirms it via SearchScrip when possible;
        PlaceOrder only needs exch + tsym, so an unconfirmed tsym still works.
        """
        d = datetime.strptime(expiry, "%d-%b-%Y")
        strike_s = f"{strike:g}"
        cp = "C" if opt_type.upper() == "CE" else "P"
        tsym = f"{name.upper()}{d.strftime('%d%b%y').upper()}{cp}{strike_s}"
        token: str | None = None
        lot: int | None = None
        error: str | None = None
        try:
            rows = await self.search_scrip("NFO", tsym)
            for r in rows:
                if r.get("tsym", "").upper() == tsym.upper():
                    token = r.get("token")
                    tsym = r["tsym"]
                    try:
                        lot = int(float(r.get("ls", 0))) or None
                    except (TypeError, ValueError):
                        lot = None
                    break
            else:
                error = f"not found in {len(rows)} SearchScrip results"
        except Exception as exc:  # noqa: BLE001
            error = str(exc)
            log.warning("resolve_nfo search failed for %s: %s", tsym, exc)
        return {
            "tsym": tsym, "token": token, "lotSize": lot,
            "confirmed": token is not None, "error": error,
        }

    def build_order_payload(
        self,
        *,
        exch: str,
        tsym: str,
        qty: int,
        side: str,
        order_type: str = "MKT",
        price: float = 0.0,
        product: str = "M",
        validity: str = "DAY",
    ) -> dict:
        """The exact `jData` object PlaceOrder sends. Field set + order matches
        Flattrade support's canonical example."""
        prctyp = {"MKT": "MKT", "LMT": "LMT", "SL": "SL-LMT", "SL-MKT": "SL-MKT"}.get(
            order_type.upper(), "MKT"
        )
        return {
            "uid": self.client_id,
            "actid": self.client_id,
            "exch": exch,
            "tsym": tsym,
            "qty": str(int(qty)),
            "prc": str(price if prctyp != "MKT" else 0),
            "prd": product,
            "trantype": "B" if side.upper() == "BUY" else "S",
            "prctyp": prctyp,
            "ret": validity,
        }

    async def place_order(
        self,
        *,
        exch: str,
        tsym: str,
        qty: int,
        side: str,
        order_type: str = "MKT",
        price: float = 0.0,
        product: str = "M",
        validity: str = "DAY",
    ) -> dict:
        payload = self.build_order_payload(
            exch=exch, tsym=tsym, qty=qty, side=side, order_type=order_type,
            price=price, product=product, validity=validity,
        )
        payload.pop("uid", None)  # _post adds uid itself
        out = await self._post("PlaceOrder", payload)
        if isinstance(out, dict) and out.get("stat") == "Ok":
            return {"ok": True, "orderId": out.get("norenordno"), "raw": out}
        raise RuntimeError(out.get("emsg") if isinstance(out, dict) else str(out))

    async def cancel_order(self, order_id: str) -> dict:
        return await self._post("CancelOrder", {"actid": self.client_id, "norenordno": order_id})

    async def modify_order(self, order_id: str, **kw) -> dict:
        return await self._post(
            "ModifyOrder", {"actid": self.client_id, "norenordno": order_id, **kw}
        )

    # ---- websocket feed -------------------------------------------
    async def start_ws(self, on_tick: TickHandler) -> None:
        if websockets is None:
            log.warning("websockets package missing; live feed disabled")
            return
        self._on_tick = on_tick
        if self._ws_task and not self._ws_task.done():
            return
        self._ws_task = asyncio.create_task(self._ws_loop())

    async def stop_ws(self) -> None:
        if self._ws_task:
            self._ws_task.cancel()
        self._ws_connected = False

    async def subscribe(self, feed_keys: set[str]) -> None:
        """feed_keys like {'NSE|26000', 'NFO|54321'}."""
        new = feed_keys - self._subs
        self._subs |= feed_keys
        if new and self._ws and self._ws_connected:
            await self._ws.send(json.dumps({"t": "t", "k": "#".join(sorted(new))}))

    async def _ws_loop(self) -> None:
        while self._token:
            try:
                async with websockets.connect(_WS, ping_interval=20, close_timeout=5) as ws:
                    self._ws = ws
                    await ws.send(
                        json.dumps(
                            {
                                "t": "c",
                                "uid": self.client_id,
                                "actid": self.client_id,
                                "susertoken": self._token,
                                "source": "API",
                            }
                        )
                    )
                    async for raw in ws:
                        try:
                            msg = json.loads(raw)
                        except ValueError:
                            continue
                        mt = msg.get("t")
                        if mt == "ck":
                            self._ws_connected = msg.get("s") == "OK"
                            if self._ws_connected and self._subs:
                                await ws.send(
                                    json.dumps({"t": "t", "k": "#".join(sorted(self._subs))})
                                )
                        elif mt in ("tf", "tk", "df", "dk") and self._on_tick:
                            tok = msg.get("tk") or msg.get("token")
                            if tok:
                                res = self._on_tick(tok, msg)
                                if asyncio.iscoroutine(res):
                                    await res
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("Flattrade WS dropped: %s; retrying in 5s", exc)
            self._ws_connected = False
            self._ws = None
            await asyncio.sleep(5)

    async def aclose(self) -> None:
        await self.stop_ws()
        await self._http.aclose()
