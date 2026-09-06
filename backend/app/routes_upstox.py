"""Upstox data-source auth + diagnostics. Orders are unaffected (Flattrade)."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse

from .brokers.upstox import get_upstox
from .processing import build_chain
from . import upstox_data

router = APIRouter(prefix="/api/upstox", tags=["upstox"])


@router.get("/status")
def status():
    return get_upstox().status()


@router.get("/login-url")
def login_url():
    ux = get_upstox()
    if not ux.configured:
        raise HTTPException(400, "Set UPSTOX_API_KEY / UPSTOX_API_SECRET / UPSTOX_REDIRECT_URL")
    return {"url": ux.login_url()}


@router.get("/callback", response_class=HTMLResponse)
async def callback(code: str | None = None, error: str | None = None):
    if error or not code:
        return HTMLResponse(f"<p>Upstox login failed: {error or 'no code'}</p>", status_code=400)
    try:
        await get_upstox().exchange_code(code)
    except Exception as exc:  # noqa: BLE001
        return HTMLResponse(f"<p>Token exchange failed: {exc}</p>", status_code=400)
    return HTMLResponse(
        "<p>Upstox connected. You can close this tab and return to GammaTerminal.</p>"
        "<script>setTimeout(()=>window.close(),800)</script>"
    )


@router.post("/token")
async def set_token(body: dict):
    tok = (body.get("token") or "").strip()
    if not tok:
        raise HTTPException(400, "token required")
    # default long-lived: the Analytics Access Token is 1-year / read-only
    get_upstox().set_token(tok, long_lived=body.get("longLived", True))
    return get_upstox().status()


@router.get("/data-source")
def get_data_source():
    from .store import store

    return {"source": store.data_source()}


@router.post("/data-source")
def set_data_source(body: dict):
    from .store import store

    src = body.get("source")
    if src == "upstox" and not get_upstox().authed:
        raise HTTPException(400, "Connect Upstox (paste the analytics token) before switching")
    return {"source": store.set_data_source(src)}


@router.delete("/token")
def clear_token():
    get_upstox().clear()
    return get_upstox().status()


def _need_auth() -> None:
    if not get_upstox().authed:
        raise HTTPException(401, "Upstox not connected — open /api/upstox/login-url")


@router.get("/expiries")
async def expiries(symbol: str = Query(...)):
    _need_auth()
    try:
        return {"symbol": symbol.upper(), "expiries": await upstox_data.fetch_expiries(symbol)}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Upstox expiries failed: {exc}")


@router.get("/chain-preview")
async def chain_preview(symbol: str = Query(...), expiry: str = Query(...)):
    """Run the Upstox -> NSE-shape -> build_chain() path and hand back the
    processed chain, so each field can be eyeballed before flipping
    DATA_SOURCE=upstox."""
    _need_auth()
    try:
        payload = await upstox_data.fetch_chain_payload(symbol.upper(), expiry)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(502, f"Upstox chain fetch failed: {exc}")
    if not payload:
        raise HTTPException(502, "no data from Upstox (check symbol / expiry)")
    chain = build_chain(payload, symbol.upper(), expiry)
    rows = chain.get("rows", [])
    return {
        "symbol": symbol.upper(),
        "expiry": expiry,
        "spot": chain.get("spot"),
        "atmStrike": chain.get("atmStrike"),
        "pcr": chain.get("pcr"),
        "maxPain": chain.get("maxPain"),
        "atmIV": chain.get("atmIV"),
        "strikes": len(rows),
        "sample": rows[len(rows) // 2 : len(rows) // 2 + 3],
    }
