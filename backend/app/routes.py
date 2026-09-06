"""REST endpoints."""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from . import screener as scr
from . import strategy as strat
from .charting import build_chart
from .config import DEFAULT_SYMBOLS, FO_UNIVERSE, INDEX_SYMBOLS
from .models import (
    AnalyzeIn,
    HedgeIn,
    OrderIn,
    OrderModeIn,
    PaperOrderClose,
    PaperOrderIn,
    SaveStrategyIn,
    StopIn,
    StrategyExecuteIn,
    WatchlistAdd,
)
from .nse_client import client
from .store import store

router = APIRouter(prefix="/api")


async def _ensure_chain(symbol: str, expiry: str | None) -> dict:
    """Return a processed chain, fetching the (symbol, expiry) on demand if needed."""
    symbol = symbol.upper()
    chain = store.get_chain(symbol, expiry)
    if chain is not None:
        return chain
    try:
        if not store.expiries.get(symbol):
            store.set_expiries(symbol, await client.expiries(symbol))
        exp = store.resolve_expiry(symbol, expiry)
        if not exp:
            raise HTTPException(status_code=404, detail=f"no expiries for {symbol}")
        payload = await client.option_chain(symbol, exp)
        store.put_raw(symbol, exp, payload)
        chain = store.get_chain(symbol, exp)
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        store.put_error(symbol, str(exc))
        raise HTTPException(status_code=503, detail=str(exc))
    if chain is None:
        raise HTTPException(status_code=503, detail="snapshot not ready yet")
    return chain


@router.get("/symbols")
def symbols():
    return {
        "indices": sorted(INDEX_SYMBOLS),
        "defaults": DEFAULT_SYMBOLS,
        "fo": sorted(FO_UNIVERSE),
        "watchlist": store.watchlist,
    }


@router.get("/expiries/{symbol}")
def expiries(symbol: str):
    return {"symbol": symbol.upper(), "expiries": store.expiries.get(symbol.upper(), [])}


_HDR_NSE_NAME = {
    "NIFTY": "NIFTY 50",
    "BANKNIFTY": "NIFTY BANK",
    "FINNIFTY": "NIFTY FIN SERVICE",
    "MIDCPNIFTY": "NIFTY MID SELECT",
    "NIFTYNXT50": "NIFTY NEXT 50",
}
_HDR_AVAILABLE = list(_HDR_NSE_NAME) + ["INDIA VIX", "SENSEX", "BANKEX"]


def _resolve_header_index(sym: str) -> dict:
    su = sym.strip().upper()

    # 1. live chain / spot cache — covers every polled symbol, NSE *and* BSE
    #    (SENSEX / BANKEX come through the Upstox poller) and F&O stocks
    chain = store.get_chain(su)
    live = store.live_spot.get(su)
    spot = (live.get("ltp") if live else None) or (chain.get("spot") if chain else None)
    chg = live.get("chgPct") if live else None

    # 2. NSE index catalog (exact, then fuzzy) for anything not live-polled
    if spot is None and su in _HDR_NSE_NAME:
        idx = store.index_quotes.get(_HDR_NSE_NAME[su])
        if idx:
            spot, chg = idx.get("last"), chg or idx.get("pChange")
    if spot is None:
        needle = su.replace(" ", "")
        for name, q in store.index_quotes.items():
            if needle and needle in name.upper().replace(" ", ""):
                spot, chg = q.get("last"), q.get("pChange")
                break

    return {"symbol": su, "spot": spot, "chgPct": chg}


@router.get("/indices/header")
def indices_header(symbols: str = Query("NIFTY,BANKNIFTY,INDIA VIX")):
    """Compact always-on header ticker strip. `?symbols=` = comma-separated list,
    up to 6, from `/api/indices/header/options`."""
    syms = [s.strip() for s in symbols.split(",") if s.strip()][:6] or ["NIFTY", "BANKNIFTY", "INDIA VIX"]
    return {"indices": [_resolve_header_index(s) for s in syms]}


@router.get("/indices/header/options")
def indices_header_options():
    """Every index the header ticker can show."""
    return {"options": _HDR_AVAILABLE}


@router.get("/symbols/search")
def symbols_search(q: str = "", limit: int = Query(25, ge=1, le=60)):
    return {"results": store.search_symbols(q, limit)}


@router.get("/option-chain/{symbol}")
async def option_chain(symbol: str, expiry: str | None = Query(None)):
    return await _ensure_chain(symbol, expiry)


@router.get("/history/{symbol}")
def history(symbol: str):
    return {"symbol": symbol.upper(), "points": store.get_history(symbol)}


@router.get("/oi-change/{symbol}")
async def oi_change(
    symbol: str,
    expiry: str | None = Query(None),
    minutes: int = Query(15, ge=1, le=480),
):
    chain = await _ensure_chain(symbol, expiry)
    return {"symbol": symbol.upper(), "expiry": chain["expiry"], "minutes": minutes,
            **store.oi_change_window(symbol, chain["expiry"], minutes)}


@router.get("/scan")
def scan():
    return {"rows": store.get_scan(), "alerts": store.get_alerts(50)}


@router.get("/scan/{symbol}")
def scan_symbol(symbol: str):
    symbol = symbol.upper()
    hist = store.get_history(symbol)
    keys = ("t", "spot", "atmIV", "atmStraddle", "atmGammaOI", "netGex", "pcr", "maxPain")
    series = [{k: h.get(k) for k in keys} for h in hist[-240:]]
    return {
        "symbol": symbol,
        "row": store.scan_results.get(symbol),
        "series": series,
    }


@router.get("/alerts")
def alerts(limit: int = Query(100, ge=1, le=200)):
    return {"alerts": store.get_alerts(limit)}


@router.get("/unusual")
def unusual(limit: int = Query(100, ge=1, le=200)):
    return {"events": store.get_unusual(limit)}


@router.get("/screener")
def screener():
    return {
        "rows": store.get_universe(),
        "progress": store.universe_progress,
        "presets": scr.FILTER_PRESETS,
    }


@router.get("/screener/{symbol}")
def screener_symbol(symbol: str):
    symbol = symbol.upper()
    return {
        "symbol": symbol,
        "row": store.universe.get(symbol),
        "ivSeries": list(store.iv_history.get(symbol, [])),
    }


# Noren TPSeries supports these minute intervals; anything else is resampled client-side.
_NOREN_INTERVALS = (1, 3, 5, 10, 15, 30, 60, 120, 240)


@router.get("/chart/{symbol}")
async def chart(
    symbol: str,
    interval: int = Query(60, ge=15, le=86400),
    instrument: str | None = Query(None),
    src: str = Query("auto"),  # auto | broker | upstox
):
    symbol = symbol.upper()
    src = (src or "auto").lower()
    from .brokers import get_broker
    from .brokers.upstox import get_upstox
    from . import upstox_data

    broker = get_broker()
    mins = max(1, interval // 60)
    fetch_min = max((m for m in _NOREN_INTERVALS if m <= mins), default=1)
    lookback = min(max(2400, mins * 600), 60 * 24 * 40)

    # ---- specific option contract ----
    opt = store._parse_opt(instrument) if instrument else None
    if opt:
        sym, exp, strike, ot = opt
        candles = None
        src_label = "sampled"

        want_ux = src == "upstox" or (src == "auto" and not broker.authed)
        if want_ux and get_upstox().authed:
            try:
                c = await upstox_data.fetch_option_candles(sym, exp, strike, ot, interval)
                if c:
                    candles, src_label = c, "upstox"
            except Exception:  # noqa: BLE001
                candles = None

        if not candles and src != "upstox" and broker.authed:
            try:
                info = await broker.resolve_nfo(sym, exp, strike, ot)
                if info.get("token"):
                    candles = await broker.tpseries(
                        "NFO", info["token"], minutes_back=lookback, interval=str(fetch_min)
                    )
                    if candles:
                        src_label = "broker"
            except Exception:  # noqa: BLE001
                candles = None

        # last-ditch: Upstox even if not explicitly asked
        if not candles and get_upstox().authed:
            try:
                c = await upstox_data.fetch_option_candles(sym, exp, strike, ot, interval)
                if c:
                    candles, src_label = c, "upstox"
            except Exception:  # noqa: BLE001
                candles = None

        if not candles:
            candles = [
                {"time": int(p["t"]), "open": p["ltp"], "high": p["ltp"],
                 "low": p["ltp"], "close": p["ltp"], "volume": 0}
                for p in store.get_opt_history(instrument)
            ]
            src_label = "sampled"
        return build_chart(
            instrument, [], [], interval_s=interval, base_candles=candles, source_label=src_label
        )

    # ---- synthetic ATM straddle ----
    if instrument and instrument.upper() == "STRADDLE":
        hist = store.get_history(symbol)
        candles = [
            {"time": int(h["t"]), "open": h["atmStraddle"], "high": h["atmStraddle"],
             "low": h["atmStraddle"], "close": h["atmStraddle"], "volume": 0}
            for h in hist
            if h.get("atmStraddle")
        ]
        return build_chart(
            f"{symbol} straddle", [], [], interval_s=interval,
            base_candles=candles, source_label="sampled",
        )

    # ---- underlying (default) ----
    from .brokers.upstox import get_upstox
    from . import upstox_data

    base_candles = None
    src_label = "broker"
    prefer_ux = store.data_source() == "upstox" and get_upstox().authed

    async def _ux_candles():
        try:
            return await upstox_data.fetch_underlying_candles(symbol, interval)
        except Exception:  # noqa: BLE001
            return None

    if prefer_ux:
        base_candles = await _ux_candles()
        if base_candles:
            src_label = "upstox"

    if not base_candles and broker.authed:
        try:
            tok = await broker.feed_token(symbol)
            if tok:
                base_candles = await broker.tpseries(
                    tok[0], tok[1], minutes_back=lookback, interval=str(fetch_min)
                )
                if base_candles:
                    src_label = "broker"
        except Exception:  # noqa: BLE001
            base_candles = None

    # Upstox fallback — real history for BSE indices & long daily ranges
    if not base_candles and get_upstox().authed:
        base_candles = await _ux_candles()
        if base_candles:
            src_label = "upstox"

    return build_chart(
        symbol,
        store.get_history(symbol),
        store.get_scan_history(symbol),
        interval_s=interval,
        base_candles=base_candles,
        source_label=src_label,
    )


@router.get("/watchlist")
def get_watchlist():
    return {"watchlist": store.watchlist, "quotes": store.watch_quotes()}


@router.post("/watchlist")
def add_watchlist(body: WatchlistAdd):
    return {"watchlist": store.add_watch(body.symbol)}


@router.delete("/watchlist/{symbol}")
def del_watchlist(symbol: str):
    return {"watchlist": store.remove_watch(symbol)}


# ---- named watchlists (add / delete / rename) ---------------------
@router.get("/watchlists")
def watchlists():
    return store.get_watchlists()


@router.post("/watchlists/add")
def watchlists_add_list():
    return store.add_wl()


@router.delete("/watchlists/{index}")
def watchlists_delete_list(index: int):
    return store.delete_wl(index)


@router.post("/watchlists/active")
def watchlists_active(body: dict):
    return store.set_active_wl(int(body.get("index", 0)))


@router.post("/watchlists/{index}/rename")
def watchlists_rename(index: int, body: dict):
    return store.rename_wl(index, str(body.get("name", "")))


@router.post("/watchlists/{index}/add")
def watchlists_add(index: int, body: WatchlistAdd):
    store.add_watch(body.symbol, index)
    return store.get_watchlists()


@router.delete("/watchlists/{index}/{symbol}")
def watchlists_remove(index: int, symbol: str):
    store.remove_watch(symbol, index)
    return store.get_watchlists()


@router.post("/watchlists/{index}/clear")
def watchlists_clear(index: int, body: dict | None = None):
    return store.clear_wl(index, bool((body or {}).get("optionsOnly")))


@router.post("/watchlists/{index}/add-strikes")
async def watchlists_add_strikes(index: int, body: dict):
    symbol = str(body.get("symbol", "")).upper()
    if not symbol:
        raise HTTPException(status_code=422, detail="symbol required")
    chain = await _ensure_chain(symbol, body.get("expiry"))
    count = max(2, min(int(body.get("count", 10)), 40))
    sides = [s.upper() for s in (body.get("sides") or ["CE", "PE"]) if s.upper() in ("CE", "PE")]
    store.add_strikes(index, symbol, chain["expiry"], count, sides or ["CE", "PE"])
    return {**store.get_watchlists(), "quotes": store.watch_quotes()}


@router.get("/paper")
def paper_state():
    return store.paper_state()


@router.post("/paper/order")
def paper_order(body: PaperOrderIn):
    order = store.place_paper_order(body)
    return {"order": order, "state": store.paper_state()}


@router.post("/paper/close")
def paper_close(body: PaperOrderClose):
    return store.close_paper(body.position_id, body.price)


@router.post("/paper/stop")
def paper_set_stop(body: StopIn):
    return store.set_stop(
        body.position_id, body.mode, body.value, body.trail_value, body.target_value
    )


@router.delete("/paper/stop/{position_id}")
def paper_clear_stop(position_id: str):
    return store.clear_stop(position_id)


# ---- unified order routing (paper | live) --------------------------
@router.get("/order/mode")
def order_mode():
    from .brokers import get_broker

    return {"mode": store.order_mode(), "brokerAuthed": get_broker().authed}


@router.post("/order/mode")
def set_order_mode(body: OrderModeIn):
    from .brokers import get_broker

    if body.mode == "live" and not get_broker().authed:
        raise HTTPException(status_code=400, detail="Connect Flattrade before enabling LIVE orders")
    return {"mode": store.set_order_mode(body.mode)}


@router.get("/order/live-log")
def live_order_log():
    return {"orders": store.get_live_orders()}


async def _route_leg(
    *,
    symbol: str,
    expiry: str | None,
    strike: float,
    option_type: str,
    side: str,
    qty_lots: int,
    order_type: str,
    price: float | None,
    product: str,
    mode: str,
) -> dict:
    chain = await _ensure_chain(symbol, expiry)
    exp = chain["expiry"]

    if mode == "live":
        from .brokers import get_broker

        broker = get_broker()
        if not broker.authed:
            raise HTTPException(status_code=400, detail="Flattrade not connected")
        info = await broker.resolve_nfo(symbol, exp, strike, option_type)
        lot = info["lotSize"] or chain["lotSize"]
        qty = qty_lots * lot
        try:
            res = await broker.place_order(
                exch="NFO",
                tsym=info["tsym"],
                qty=qty,
                side=side,
                order_type=order_type,
                price=price or 0.0,
                product="I" if product == "MIS" else "M",
            )
        except Exception as exc:  # noqa: BLE001
            rec = {
                "mode": "live", "status": "REJECTED", "symbol": symbol, "expiry": exp,
                "strike": strike, "optionType": option_type, "side": side,
                "qtyLots": qty_lots, "qty": qty, "tsym": info["tsym"], "error": str(exc),
            }
            store.log_live_order(rec)
            raise HTTPException(status_code=502, detail=f"broker rejected: {exc}")
        rec = {
            "mode": "live", "status": "PLACED", "symbol": symbol, "expiry": exp,
            "strike": strike, "optionType": option_type, "side": side,
            "qtyLots": qty_lots, "qty": qty, "tsym": info["tsym"],
            "orderId": res.get("orderId"), "confirmed": info["confirmed"],
        }
        store.log_live_order(rec)
        return rec

    order = store.place_paper_order(
        PaperOrderIn(
            symbol=symbol, expiry=exp, strike=strike, option_type=option_type,
            side=side, qty_lots=qty_lots, price=price,
        )
    )
    return {"mode": "paper", "status": "FILLED", "order": order}


@router.post("/order")
async def place_order(body: OrderIn):
    mode = body.mode or store.order_mode()
    result = await _route_leg(
        symbol=body.symbol, expiry=body.expiry, strike=body.strike,
        option_type=body.option_type, side=body.side, qty_lots=body.qty_lots,
        order_type=body.order_type, price=body.price, product=body.product, mode=mode,
    )
    return {"result": result, "paper": store.paper_state(), "mode": mode}


@router.post("/strategy/execute")
async def strategy_execute(body: StrategyExecuteIn):
    mode = body.mode or store.order_mode()
    results = []
    for leg in body.legs:
        if leg.option_type == "FUT":
            continue
        results.append(
            await _route_leg(
                symbol=body.symbol, expiry=body.expiry, strike=leg.strike,
                option_type=leg.option_type, side=leg.side, qty_lots=leg.lots,
                order_type=body.order_type, price=leg.price, product=body.product, mode=mode,
            )
        )
    return {"mode": mode, "results": results, "paper": store.paper_state()}


# ---- strategy builder ------------------------------------------------
@router.post("/strategy/analyze")
async def strategy_analyze(body: AnalyzeIn):
    if not body.legs:
        raise HTTPException(status_code=422, detail="at least one leg required")
    chain = await _ensure_chain(body.symbol, body.expiry)
    return strat.analyze(
        chain,
        [leg.dump() for leg in body.legs],
        price_range=body.price_range,
        points=body.points,
    )


@router.post("/strategy/hedge")
async def strategy_hedge(body: HedgeIn):
    if not body.legs:
        raise HTTPException(status_code=422, detail="at least one leg required")
    chain = await _ensure_chain(body.symbol, body.expiry)
    return strat.find_hedge(
        chain,
        [leg.dump() for leg in body.legs],
        body.max_loss,
        body.max_lots,
        max_profit_cap=body.max_profit_cap,
        min_pop=body.min_pop,
        max_abs_delta=body.max_abs_delta,
        max_abs_theta=body.max_abs_theta,
        max_abs_vega=body.max_abs_vega,
        max_abs_gamma=body.max_abs_gamma,
        max_hedge_iv=body.max_hedge_iv,
    )


@router.get("/strategy/templates")
async def strategy_templates(symbol: str, expiry: str | None = Query(None)):
    chain = await _ensure_chain(symbol, expiry)
    return {
        "symbol": chain["symbol"],
        "expiry": chain["expiry"],
        "atmStrike": chain["atmStrike"],
        "strikeStep": chain["strikeStep"],
        "templates": strat.templates(chain),
    }


@router.post("/strategy/from-paper")
async def strategy_from_paper():
    built = strat.from_paper(store.paper_state()["positions"])
    if not built:
        raise HTTPException(status_code=404, detail="no paper positions")
    chain = await _ensure_chain(built["symbol"], built["expiry"])
    analysis = strat.analyze(chain, built["legs"])
    return {**built, "analysis": analysis}


@router.post("/strategy/from-broker")
async def strategy_from_broker():
    """Pull your live Flattrade positions into the builder so the hedge finder
    (and Execute LIVE) can cap the running loss on a real open position."""
    from .brokers import get_broker

    b = get_broker()
    if not b.authed:
        raise HTTPException(status_code=400, detail="Flattrade not connected")
    try:
        positions = await b.positions()
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    built = strat.from_broker(positions)
    if not built:
        raise HTTPException(status_code=404, detail="no open broker option positions")
    chain = await _ensure_chain(built["symbol"], built["expiry"])
    analysis = strat.analyze(chain, built["legs"])
    return {**built, "analysis": analysis}


@router.get("/strategies")
def strategies_list():
    return {"strategies": strat.list_saved()}


@router.post("/strategies")
def strategies_save(body: SaveStrategyIn):
    rec = strat.save_strategy(
        body.name, body.symbol, body.expiry, [leg.dump() for leg in body.legs]
    )
    return {"saved": rec, "strategies": strat.list_saved()}


@router.delete("/strategies/{sid}")
def strategies_delete(sid: str):
    return {"strategies": strat.delete_strategy(sid)}
