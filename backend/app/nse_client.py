"""Async client for NSE's current option-chain API (v3, per-expiry).

Legacy `/api/option-chain-indices` was retired by NSE. The live endpoints are:
  GET /api/option-chain-contract-info?symbol=NIFTY      -> {expiryDates:[...], strikePrice:[...]}
  GET /api/option-chain-v3?type=Indices&symbol=NIFTY&expiry=08-Sep-2026
      -> {records:{data:[{strikePrice, CE, PE}], expiryDates, underlyingValue, timestamp}, filtered:{...}}

NSE blocks requests without a warmed-up browser session, so we hit an HTML page
first for cookies and refresh on any non-JSON / 401 / 403 response.
"""
from __future__ import annotations

import asyncio
import time

import httpx

from urllib.parse import quote

from .config import INDEX_SYMBOLS

# NSE chart-databyindex index names for the intraday spot backfill
_INDEX_CHART_NAME = {
    "NIFTY": "NIFTY 50",
    "BANKNIFTY": "NIFTY BANK",
    "FINNIFTY": "NIFTY FINANCIAL SERVICES",
    "MIDCPNIFTY": "NIFTY MIDCAP SELECT",
    "NIFTYNXT50": "NIFTY NEXT 50",
}

_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate",
    "Connection": "keep-alive",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
}

_BID = ("buyPrice1", "bidprice")
_ASK = ("sellPrice1", "askPrice")
_BIDQ = ("buyQuantity1", "bidQty")
_ASKQ = ("sellQuantity1", "askQty")


def _alias(leg: dict) -> dict:
    """Map v3 quote keys onto the names processing.build_chain expects."""
    if not leg:
        return {}
    leg.setdefault("bidprice", leg.get(_BID[0]))
    leg.setdefault("askPrice", leg.get(_ASK[0]))
    leg.setdefault("bidQty", leg.get(_BIDQ[0]))
    leg.setdefault("askQty", leg.get(_ASKQ[0]))
    return leg


class NSEClient:
    BASE = "https://www.nseindia.com"
    _BOOTSTRAP_TTL = 600  # seconds

    def __init__(self) -> None:
        self._client = httpx.AsyncClient(
            headers=_HEADERS, timeout=httpx.Timeout(15.0), follow_redirects=True
        )
        self._lock = asyncio.Lock()
        self._bootstrapped_at = 0.0

    async def aclose(self) -> None:
        await self._client.aclose()

    async def _bootstrap(self, force: bool = False) -> None:
        async with self._lock:
            if not force and time.time() - self._bootstrapped_at < self._BOOTSTRAP_TTL:
                return
            for path in ("/", "/option-chain"):
                try:
                    await self._client.get(
                        self.BASE + path,
                        headers={"Accept": "text/html,application/xhtml+xml"},
                    )
                except httpx.HTTPError:
                    pass
            self._bootstrapped_at = time.time()

    async def _get_json(self, url: str) -> dict:
        last: Exception | None = None
        for attempt in range(4):
            await self._bootstrap(force=attempt > 0)
            try:
                resp = await self._client.get(
                    url, headers={"Referer": self.BASE + "/option-chain"}
                )
            except httpx.HTTPError as exc:
                last = exc
                await asyncio.sleep(1.0 + attempt)
                continue
            ctype = resp.headers.get("content-type", "")
            if resp.status_code == 200 and "json" in ctype:
                try:
                    return resp.json()
                except ValueError as exc:
                    last = exc
            else:
                last = RuntimeError(f"HTTP {resp.status_code} ({ctype or 'no ctype'})")
            await asyncio.sleep(1.0 + attempt)
        raise RuntimeError(f"NSE fetch failed for {url}: {last}")

    @staticmethod
    def _type(symbol: str) -> str:
        return "Indices" if symbol.upper() in INDEX_SYMBOLS else "Equities"

    async def contract_info(self, symbol: str) -> dict:
        symbol = symbol.upper()
        return await self._get_json(
            f"{self.BASE}/api/option-chain-contract-info?symbol={symbol}"
        )

    async def expiries(self, symbol: str) -> list[str]:
        info = await self.contract_info(symbol)
        return list(info.get("expiryDates", []) or [])

    async def option_chain(self, symbol: str, expiry: str) -> dict:
        """Raw v3 payload for one expiry, with quote-key aliases applied in place."""
        symbol = symbol.upper()
        url = (
            f"{self.BASE}/api/option-chain-v3?type={self._type(symbol)}"
            f"&symbol={symbol}&expiry={expiry}"
        )
        payload = await self._get_json(url)
        records = payload.get("records", {})
        for row in records.get("data", []) or []:
            row.setdefault("expiryDate", expiry)
            row.setdefault("strikePrice", row.get("strikePrice"))
            _alias(row.get("CE") or {})
            _alias(row.get("PE") or {})
        return payload

    async def all_indices(self) -> list[dict]:
        """Every NSE index (incl. INDIA VIX) with last / %change."""
        try:
            data = await self._get_json(f"{self.BASE}/api/allIndices")
        except RuntimeError:
            return []
        return data.get("data", []) or []

    async def index_intraday(self, symbol: str) -> list:
        """Best-effort: today's intraday spot ticks as [[epoch_ms, value], ...].

        Empty outside market hours or if NSE strips the response.
        """
        name = _INDEX_CHART_NAME.get(symbol.upper())
        if not name:
            return []
        url = f"{self.BASE}/api/chart-databyindex?index={quote(name)}&indices=true"
        try:
            data = await self._get_json(url)
        except RuntimeError:
            return []
        pts = data.get("grapthData") or []
        return [p for p in pts if isinstance(p, list) and len(p) >= 2]


client = NSEClient()
