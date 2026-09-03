"""Broker (Flattrade) auth + read-only account/data endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import HTMLResponse

from .brokers import get_broker

router = APIRouter(prefix="/api/broker")

_CALLBACK_HTML = """<!doctype html><meta charset=utf-8>
<title>Flattrade</title>
<body style="font-family:system-ui;background:#0a0e14;color:#c8d3e0;display:flex;
align-items:center;justify-content:center;height:100vh;margin:0">
<div style="text-align:center">
<h2 style="color:{color}">{title}</h2>
<p>{msg}</p>
<p style="color:#7a8699">You can close this tab and return to GammaTerminal.</p>
</div></body>"""


@router.get("/status")
def status():
    return get_broker().status()


@router.get("/login")
def login():
    b = get_broker()
    if not b.configured:
        raise HTTPException(
            status_code=400,
            detail="Set FLATTRADE_API_KEY / FLATTRADE_API_SECRET / FLATTRADE_CLIENT_ID in backend/.env",
        )
    return {"url": b.login_url()}


@router.get("/callback", response_class=HTMLResponse)
async def callback(
    code: str | None = Query(None),
    request_code: str | None = Query(None),
    client: str | None = Query(None),
):
    b = get_broker()
    rc = code or request_code
    if not rc:
        return HTMLResponse(
            _CALLBACK_HTML.format(
                color="#dc2626", title="No request code", msg="Flattrade did not return a code."
            ),
            status_code=400,
        )
    try:
        await b.exchange_token(rc)
    except Exception as exc:  # noqa: BLE001
        return HTMLResponse(
            _CALLBACK_HTML.format(color="#dc2626", title="Auth failed", msg=str(exc)),
            status_code=400,
        )
    return HTMLResponse(
        _CALLBACK_HTML.format(
            color="#16a34a", title="Flattrade connected", msg=f"Session active for {b.client_id}."
        )
    )


@router.post("/logout")
def logout():
    get_broker().logout()
    return {"ok": True}


def _require_auth():
    b = get_broker()
    if not b.authed:
        raise HTTPException(status_code=401, detail="Flattrade not connected")
    return b


@router.get("/funds")
async def funds():
    b = _require_auth()
    try:
        return await b.funds()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/positions")
async def positions():
    b = _require_auth()
    try:
        return {"positions": await b.positions()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/orders")
async def orders():
    b = _require_auth()
    try:
        return {"orders": await b.order_book()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))


@router.get("/holdings")
async def holdings():
    b = _require_auth()
    try:
        return {"holdings": await b.holdings()}
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
