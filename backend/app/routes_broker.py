"""Broker (Flattrade) auth + read-only account/data endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import HTMLResponse

from .brokers import get_broker
from .store import store

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


@router.get("/build-order")
async def build_order(
    request: Request,
    symbol: str = Query("NIFTY"),
    strike: float = Query(...),
    ot: str = Query("CE", description="CE or PE"),
    side: str = Query("BUY", description="BUY or SELL"),
    lots: int = Query(1, ge=1),
    expiry: str = Query("", description="DD-Mon-YYYY; blank = nearest"),
    product: str = Query("NRML", description="NRML or MIS"),
    order_type: str = Query("MKT", description="MKT or LMT"),
    price: float = Query(0.0),
):
    """Build the *exact* PlaceOrder payload GammaTerminal would send — without
    sending it. Use this to give Flattrade support the request format when a real
    LIVE order can't be punched. `jKey` is masked unless the call is made directly
    on the server (see /last-request)."""
    from .processing import lot_size
    from .store import store

    b = _require_auth()
    exp = expiry or store.nearest_expiry(symbol.upper()) or ""
    if not exp:
        raise HTTPException(status_code=400, detail=f"no expiry known for {symbol}; pass ?expiry=")
    info = await b.resolve_nfo(symbol.upper(), exp, strike, ot)
    lot = info.get("lotSize") or lot_size(symbol)
    qty = lots * lot
    jdata_obj = b.build_order_payload(
        exch="NFO", tsym=info["tsym"], qty=qty, side=side, order_type=order_type,
        price=price, product="I" if product.upper() == "MIS" else "M",
    )
    jdata = _json_compact(jdata_obj)
    local = "x-forwarded-for" not in {k.lower() for k in request.headers}
    jkey = b._token if (local and b._token) else f"<{len(b._token or '')}-char token, masked>"
    return {
        "method": "POST",
        "url": "https://piconnect.flattrade.in/NorenWClientTP/PlaceOrder",
        "contentType": "application/x-www-form-urlencoded",
        "jData": jdata,
        "requestBody": f"jData={jdata}&jKey={jkey}",
        "resolved": info,
        "lotSize": lot,
        "qty": qty,
        "note": "This is the request format only — nothing was sent to Flattrade.",
    }


def _json_compact(obj: dict) -> str:
    import json as _j

    return _j.dumps(obj, separators=(",", ":"))


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


@router.post("/square-off")
async def square_off(body: dict):
    """Flatten one live position with a single opposite-side MARKET order.
    Body: {tsym, exch, qty (signed net qty from PositionBook), prd}."""
    from .brokers.flattrade import parse_noren_tsym

    b = _require_auth()
    d = body or {}
    tsym = d.get("tsym")
    exch = d.get("exch") or "NFO"
    prd = d.get("prd") or "M"
    try:
        net_qty = float(d.get("qty"))
    except (TypeError, ValueError):
        net_qty = 0.0
    if not tsym or not net_qty:
        raise HTTPException(status_code=422, detail="tsym and a non-zero qty are required")

    side = "SELL" if net_qty > 0 else "BUY"
    qty = int(round(abs(net_qty)))
    parsed = parse_noren_tsym(tsym) or {}
    log_base = {
        "mode": "live", "tsym": tsym, "side": side, "qty": qty,
        "symbol": parsed.get("symbol"), "strike": parsed.get("strike"),
        "optionType": parsed.get("optionType"), "note": "square-off",
    }
    try:
        res = await b.place_order(
            exch=exch, tsym=tsym, qty=qty, side=side,
            order_type="MKT", price=0.0, product=prd,
        )
    except Exception as exc:  # noqa: BLE001
        store.log_live_order({**log_base, "status": "REJECTED", "error": str(exc)})
        raise HTTPException(status_code=502, detail=f"broker rejected: {exc}")
    store.log_live_order({**log_base, "status": "PLACED", "orderId": res.get("orderId")})
    return res


@router.post("/order-tsym")
async def order_tsym(body: dict):
    """Place a live order directly against a known Noren tsym (the Broker
    Positions B/S quick-trade buttons). `lots` (default 1) x that symbol's
    configured lot size -> qty; no strike/expiry resolution needed since the
    tsym is already known from the open position."""
    from .brokers.flattrade import parse_noren_tsym
    from .processing import lot_size

    b = _require_auth()
    d = body or {}
    tsym = d.get("tsym")
    exch = d.get("exch") or "NFO"
    prd = d.get("prd") or "M"
    side = str(d.get("side") or "").upper()
    try:
        lots = max(1, int(d.get("lots") or 1))
    except (TypeError, ValueError):
        lots = 1
    if not tsym or side not in ("BUY", "SELL"):
        raise HTTPException(status_code=422, detail="tsym and side (BUY/SELL) are required")

    parsed = parse_noren_tsym(tsym) or {}
    qty = lots * (lot_size(parsed.get("symbol") or "") or 1)
    log_base = {
        "mode": "live", "tsym": tsym, "side": side, "qty": qty,
        "symbol": parsed.get("symbol"), "strike": parsed.get("strike"),
        "optionType": parsed.get("optionType"),
    }
    try:
        res = await b.place_order(
            exch=exch, tsym=tsym, qty=qty, side=side,
            order_type="MKT", price=0.0, product=prd,
        )
    except Exception as exc:  # noqa: BLE001
        store.log_live_order({**log_base, "status": "REJECTED", "error": str(exc)})
        raise HTTPException(status_code=502, detail=f"broker rejected: {exc}")
    store.log_live_order({**log_base, "status": "PLACED", "orderId": res.get("orderId")})
    return {**res, "qty": qty}


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
async def probe(symbol: str = Query("NIFTY"), strike: float = Query(0), exch: str = Query("NFO")):
    """Diagnostic: raw Flattrade responses for the pieces the NSE->Flattrade
    data migration needs (limits, index quote, exact-match scrip search,
    resolved ATM CE/PE + their live GetQuotes, GetOptionChain)."""
    import json as _json
    from datetime import datetime as _dt

    b = _require_auth()
    sym = symbol.upper()
    out: dict = {"symbol": sym, "exch": exch, "token_len": len(b._token or "")}

    async def safe(name, coro):
        try:
            out[name] = await coro
        except Exception as exc:  # noqa: BLE001
            out[name] = {"__error__": str(exc)}

    await safe("user_details", b._post("UserDetails", {}))
    await safe("limits", b.funds())

    # underlying feed token + a quote on it (index or, for BFO, still via NSE/BSE cash)
    tok = None
    try:
        tok = await b.feed_token(sym)
        out["feed_token"] = tok
    except Exception as exc:  # noqa: BLE001
        out["feed_token"] = {"__error__": str(exc)}
    if tok:
        await safe("index_quote", b.quotes(tok[0], tok[1]))

    # SearchScrip is a substring match ("NIFTY" also matches NIFTYFPI, NIFTYNXT50,
    # ...) -- filter to the exact underlying so downstream anchoring is reliable.
    raw_search = []
    try:
        raw_search = await b.search_scrip(exch, sym)
    except Exception as exc:  # noqa: BLE001
        out["searchscrip_error"] = str(exc)
    exact = [v for v in (raw_search or []) if str(v.get("symname", "")).upper() == sym]
    out["searchscrip_total"] = len(raw_search or [])
    out["searchscrip_exact_count"] = len(exact)
    out["searchscrip_exact_sample"] = exact[:8]

    # build the ATM CE/PE tsym directly (known-good SYMBOL+DDMMMYY+C/P+STRIKE
    # convention) off our own nearest-expiry knowledge, then pull live quotes.
    raw_idx = out.get("index_quote") or {}
    spot = float(raw_idx.get("lp") or raw_idx.get("c") or 0) or strike or 24000
    step = 100 if "BANK" in sym or "SENSEX" in sym else 50
    atm = round(spot / step) * step
    exp = store.nearest_expiry(sym)
    out["atm"] = atm
    out["expiry_used"] = exp

    if exp:
        try:
            info_ce = await b.resolve_nfo(sym, exp, atm, "CE")
            info_pe = await b.resolve_nfo(sym, exp, atm, "PE")
            out["resolved_ce"] = info_ce
            out["resolved_pe"] = info_pe
            if info_ce.get("token"):
                await safe("quote_ce", b.quotes(exch, info_ce["token"]))
            if info_pe.get("token"):
                await safe("quote_pe", b.quotes(exch, info_pe["token"]))
            await safe("option_chain", b.get_option_chain(exch, info_ce["tsym"], str(int(atm)), 10))
        except Exception as exc:  # noqa: BLE001
            out["resolve_error"] = str(exc)
    else:
        out["resolve_error"] = f"no expiry known for {sym} yet (store.expiries empty)"

    out["_at"] = _dt.now().isoformat(timespec="seconds")
    # keep the payload compact in the response
    return _json.loads(_json.dumps(out, default=str))
