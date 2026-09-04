"""Broker (Flattrade) auth + read-only account/data endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
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
async def callback(request: Request):
    import logging as _lg

    b = get_broker()
    qp = dict(request.query_params)
    _lg.getLogger("flattrade").info("callback query params: %s", qp)
    # accept any of the names Noren brokers have used for the request code
    rc = next(
        (qp[k] for k in ("code", "request_code", "requestCode", "reqcode", "request_token", "authcode")
         if qp.get(k)),
        None,
    )
    if not rc:
        return HTMLResponse(
            _CALLBACK_HTML.format(
                color="#dc2626",
                title="No request code",
                msg=f"Flattrade returned no code. Params seen: {qp or '(none)'}",
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


@router.post("/direct-login")
async def direct_login(body: dict):
    """Noren QuickAuth: {uid, pwd, totp, vc?, apiKey?} -> session, no OAuth redirect."""
    b = get_broker()
    d = body or {}
    try:
        res = await b.direct_login(
            d.get("uid", ""), d.get("pwd", ""), d.get("totp", ""),
            d.get("vc", ""), d.get("apiKey", ""),
        )
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc))
    return {**res, **b.status()}


@router.post("/token")
def set_token(body: dict):
    """Manually install a Flattrade session token (from the portal's 'Generate
    Token' button) when the OAuth redirect flow isn't producing a working one."""
    b = get_broker()
    tok = (body or {}).get("token", "")
    client = (body or {}).get("client")
    try:
        res = b.set_token(tok, client)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc))
    return {**res, **b.status()}


@router.post("/logout")
def logout():
    get_broker().logout()
    return {"ok": True}


@router.get("/last-request")
def last_request(
    request: Request,
    endpoint: str = Query("", description="e.g. PlaceOrder; blank = all endpoints"),
    reveal: int = Query(0, description="1 = include the real jKey token (server-local calls only)"),
):
    """The raw request GammaTerminal last sent to Flattrade (jKey masked) plus their
    response — copy this into a broker support ticket. `?endpoint=PlaceOrder` for the
    last order punch. `?reveal=1` swaps the real session token back in, but only when
    the call is made directly on the server (not through the public nginx proxy)."""
    b = get_broker()
    data = b.last_exchange(endpoint or None)
    if not reveal:
        return data
    # nginx adds X-Forwarded-For; a bare curl on the box does not -> only reveal then
    local = "x-forwarded-for" not in {k.lower() for k in request.headers}
    if not (local and b._token):
        return {"_note": "reveal=1 ignored: run this directly on the server, not via the public URL",
                "data": data}

    def _unmask(d: dict) -> dict:
        if isinstance(d, dict) and isinstance(d.get("requestBody"), str):
            return {**d, "requestBody": f"jData={d.get('jData', '')}&jKey={b._token}", "jKey": b._token}
        return d

    return _unmask(data) if endpoint else {k: _unmask(v) for k, v in data.items()}


@router.post("/refresh")
async def refresh():
    """Reload the saved session, re-validate the token, and reconnect the feed."""
    b = get_broker()
    if not b.configured:
        raise HTTPException(status_code=400, detail="Flattrade not configured")
    try:
        res = await b.refresh()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    return res


def _require_auth():
    b = get_broker()
    if not b.authed:
        raise HTTPException(status_code=401, detail="Flattrade not connected")
    return b


@router.get("/funds")
async def funds():
    """Normalised margin view: {available, used, total, raw}. Never hard-fails so the
    UI can still show the paper-margin figures when the broker isn't connected."""
    b = get_broker()
    if not b.authed:
        return {"connected": False, "available": None, "used": None, "total": None, "raw": None}
    try:
        raw = await b.funds()
    except Exception as exc:  # noqa: BLE001
        return {"connected": True, "available": None, "used": None, "total": None,
                "error": str(exc), "raw": None}
    d = raw if isinstance(raw, dict) else {}

    def num(*keys: str) -> float:
        for k in keys:
            v = d.get(k)
            if v not in (None, ""):
                try:
                    return float(v)
                except (TypeError, ValueError):
                    pass
        return 0.0

    # Noren `Limits`: `cash` is the net available balance, `payin` today's deposits.
    # margin used = `marginused` if present, else SPAN + exposure + option premium blocked.
    used = num("marginused")
    if used == 0.0:
        used = num("span", "spanused") + num("expo", "exposuremargin") + num("premium")
    available = num("cash") + num("payin") - num("payout") + num("brkcollamt", "collateral")
    return {
        "connected": True,
        "available": round(available, 2),
        "used": round(used, 2),
        "total": round(available + used, 2),
        "raw": d,
    }


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


@router.get("/probe")
async def probe(symbol: str = Query("NIFTY"), strike: float = Query(0)):
    """Diagnostic: raw Flattrade responses for the pieces the NSE->Flattrade
    data migration needs (limits, index quote, scrip search, option chain)."""
    import json as _json
    from datetime import datetime as _dt

    b = _require_auth()
    out: dict = {"symbol": symbol.upper(), "token_len": len(b._token or "")}

    async def safe(name, coro):
        try:
            out[name] = await coro
        except Exception as exc:  # noqa: BLE001
            out[name] = {"__error__": str(exc)}

    await safe("user_details", b._post("UserDetails", {}))
    await safe("limits", b.funds())

    # index feed token + a quote on it
    tok = None
    try:
        tok = await b.feed_token(symbol)
        out["feed_token"] = tok
    except Exception as exc:  # noqa: BLE001
        out["feed_token"] = {"__error__": str(exc)}
    if tok:
        await safe("index_quote", b.quotes(tok[0], tok[1]))

    # NFO option scrip search — see what tsym / expiry / strike fields look like
    await safe("searchscrip_nfo", b.search_scrip("NFO", symbol.upper()))

    # try a GetOptionChain around an ATM-ish strike using a constructed near-expiry tsym
    try:
        raw_idx = out.get("index_quote") or {}
        spot = float(raw_idx.get("lp") or raw_idx.get("c") or 0) or strike or 24000
        atm = round(spot / 50) * 50 if "NIFTY" in symbol.upper() else round(spot / 100) * 100
        vals = out.get("searchscrip_nfo") or []
        base_tsym = None
        if isinstance(vals, list) and vals:
            # pick any CE near atm to use as the anchor tsym
            base_tsym = next(
                (v.get("tsym") for v in vals if v.get("tsym", "").upper().endswith(f"C{int(atm)}")),
                vals[0].get("tsym"),
            )
        out["oc_anchor"] = {"spot": spot, "atm": atm, "base_tsym": base_tsym}
        if base_tsym:
            await safe("option_chain", b.get_option_chain("NFO", base_tsym, str(int(atm)), 8))
    except Exception as exc:  # noqa: BLE001
        out["oc_anchor"] = {"__error__": str(exc)}

    out["_at"] = _dt.now().isoformat(timespec="seconds")
    # keep the payload compact in the response
    return _json.loads(_json.dumps(out, default=str))
