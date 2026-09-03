"""Flattrade (Noren / Pi Connect) adapter.

Auth flow:
  1. browser -> https://auth.flattrade.in/?app_key=<API_KEY>
  2. after login Flattrade redirects to REDIRECT_URL?code=<request_code>&client=<CLIENT>
  3. POST https://authapi.flattrade.in/trade/apitoken
     {api_key, request_code, api_secret: sha256(api_key + request_code + api_secret)}
     -> {token, client}
Session token is good for the trading day; cached in data/broker_session.json.

REST: POST https://piconnect.flattrade.in/PiConnectTP/<Endpoint>  body: jData=<json>&jKey=<token>
WS:   wss://piconnect.flattrade.in/PiConnectWSTp/
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from datetime import datetime
from typing import Awaitable, Callable

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
_REST = "https://piconnect.flattrade.in/NorenWClientTP"
_WS = "wss://piconnect.flattrade.in/NorenWSTP/"
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
        if data.get("stat") == "Ok" and data.get("token"):
            self._token = data["token"]
            if data.get("client"):
                self.client_id = data["client"].upper()
            self._save_session()
            log.info("Flattrade authenticated as %s", self.client_id)
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

    # ---- REST helper -----------------------------------------------
    async def _post(self, endpoint: str, payload: dict) -> dict | list:
        if not self._token:
            raise RuntimeError("not authenticated with Flattrade")
        body = {"uid": self.client_id, **payload}
        url = f"{_REST}/{endpoint}"
        r = await self._http.post(
            url, data={"jData": json.dumps(body), "jKey": self._token}
        )
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
        try:
            for r in await self.search_scrip("NFO", tsym):
                if r.get("tsym", "").upper() == tsym.upper():
                    token = r.get("token")
                    tsym = r["tsym"]
                    try:
                        lot = int(float(r.get("ls", 0))) or None
                    except (TypeError, ValueError):
                        lot = None
                    break
        except Exception as exc:  # noqa: BLE001
            log.debug("resolve_nfo search failed for %s: %s", tsym, exc)
        return {"tsym": tsym, "token": token, "lotSize": lot, "confirmed": token is not None}

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
        prctyp = {"MKT": "MKT", "LMT": "LMT", "SL": "SL-LMT", "SL-MKT": "SL-MKT"}.get(
            order_type.upper(), "MKT"
        )
        payload = {
            "actid": self.client_id,
            "exch": exch,
            "tsym": tsym,
            "qty": str(int(qty)),
            "prc": str(price if prctyp != "MKT" else 0),
            "prd": product,
            "trantype": "B" if side.upper() == "BUY" else "S",
            "prctyp": prctyp,
            "ret": validity,
            "ordersource": "API",
        }
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
