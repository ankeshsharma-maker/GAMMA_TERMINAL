"""REST endpoints."""
from __future__ import annotations

import time
from collections import OrderedDict

from fastapi import APIRouter, HTTPException, Query, Request

from . import candle_sources, flow, pcr_series, portfolio_scenario, volatility
from . import screener as scr
from . import strategy as strat
from . import strategy_chart
from .charting import build_chart
from .config import DEFAULT_SYMBOLS, FO_UNIVERSE, INDEX_SYMBOLS, SHORT_OPTION_MARGIN_PCT
from .models import (
    AnalyzeIn,
    FromBrokerIn,
    FutureOrderIn,
    HedgeIn,
    OrderIn,
    OrderModeIn,
    PaperOrderClose,
    PaperOrderIn,
    SaveStrategyIn,
    ScenarioIn,
    ScheduleIn,
    StopIn,
    StrategyChartIn,
    StrategyExecuteIn,
    WatchlistAdd,
)
from .nse_client import client
from .processing import lot_size
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
    chg_pts = None

    # 2. NSE index catalog — always consulted for the day change (points + %),
    #    even when spot already came from the chain/live cache, since those
    #    don't always carry a change figure (e.g. broker feed down).
    idx = None
    if su in _HDR_NSE_NAME:
        idx = store.index_quotes.get(_HDR_NSE_NAME[su])
    if idx is None:
        needle = su.replace(" ", "")
        for name, q in store.index_quotes.items():
            if needle and needle in name.upper().replace(" ", ""):
                idx = q
                break
    if idx:
        if spot is None:
            spot = idx.get("last")
        if chg is None:
            chg = idx.get("pChange")
        chg_pts = idx.get("variation")

    # 3. derive points from spot + % (prevClose = spot / (1 + %/100))
    if chg_pts is None and spot is not None and chg is not None:
        try:
            prev = float(spot) / (1 + float(chg) / 100)
            chg_pts = round(float(spot) - prev, 2)
        except (TypeError, ValueError, ZeroDivisionError):
            chg_pts = None

    # 4. no change at all (SENSEX / BANKEX and F&O stocks the NSE index
    #    catalog doesn't carry) — fall back to move-from-session-open so the
    #    ticker still shows an arrow + points + % like every other row.
    if spot is not None and chg is None and chg_pts is None:
        try:
            op = store.session_open(su, float(spot))
            if op:
                chg_pts = round(float(spot) - op, 2)
                chg = round((float(spot) - op) / op * 100, 2)
        except Exception:  # noqa: BLE001
            pass

    return {"symbol": su, "spot": spot, "chgPct": chg, "chgPts": chg_pts}


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
async def symbols_search(q: str = "", limit: int = Query(25, ge=1, le=60), sym: str | None = Query(None)):
    """Indices / stocks by name, and option contracts for a strike query ("23400 CE");
    `sym` = the symbol on screen, listed first among the option matches. Cash-market
    (non-F&O) stocks come last, from the Upstox instrument master."""
    try:
        from .brokers.upstox import get_upstox

        ux = get_upstox()
        if ux.configured:
            await ux.load_instruments()  # once a day; a no-op after that
    except Exception:  # noqa: BLE001
        pass
    return {"results": store.search_symbols(q, limit, hint=sym)}


@router.get("/option-chain/{symbol}")
async def option_chain(symbol: str, expiry: str | None = Query(None)):
    return await _ensure_chain(symbol, expiry)


@router.get("/volatility/{symbol}")
async def volatility_view(
    symbol: str,
    expiry: str | None = Query(None),
    expiries: int = Query(volatility.MAX_EXPIRIES, ge=2, le=8),
):
    """IV smile + skew per expiry, ATM term structure, and implied vs realized vol."""
    chain = await _ensure_chain(symbol, expiry)
    return await volatility.build(chain["symbol"], chain, max_expiries=expiries)


@router.post("/portfolio/scenario")
async def portfolio_scenario_grid(body: ScenarioIn):
    """P&L of everything open under spot x IV x time shocks (paper, broker, or both)."""
    from .brokers import get_broker

    positions: list[dict] = []
    skipped: list[str] = []
    if body.source in ("paper", "all"):
        positions += portfolio_scenario.from_paper(store.paper_state()["positions"])
    if body.source in ("broker", "all"):
        b = get_broker()
        if b.authed:
            try:
                rows = await b.positions()
            except Exception as exc:  # noqa: BLE001
                raise HTTPException(status_code=502, detail=f"broker positions failed: {exc}")
            legs, skipped = portfolio_scenario.from_broker(rows)
            positions += legs
        elif body.source == "broker":
            raise HTTPException(status_code=409, detail="Flattrade isn't connected - connect it to see live positions")
    return await portfolio_scenario.build(positions, _ensure_chain, body.days_forward, skipped)


@router.get("/history/{symbol}")
def history(symbol: str):
    return {"symbol": symbol.upper(), "points": store.get_history(symbol)}


@router.get("/volume-screener")
def volume_screener_view(universe: str = Query("fo")):
    """Stocks by traded volume: relative volume vs usual, value traded, volume-backed
    breakouts. universe = fo (F&O stocks) | all (every NSE cash stock, on demand)."""
    from . import volume_screener

    volume_screener.viewed()
    if universe == "all":
        volume_screener.want_all()
    return volume_screener.snapshot(universe)


@router.get("/volume-screener/config")
def volume_screener_config_get():
    from . import volume_screener

    return volume_screener.cfg()


@router.post("/volume-screener/config")
def volume_screener_config(body: dict):
    """{alertLevel: 0 (off) | 2 | 3 | 5, minValueCr}: when a volume spike alerts."""
    from . import volume_screener

    return volume_screener.set_cfg(body)


@router.get("/gex-intraday/{symbol}")
def gex_intraday_view(symbol: str, day: str | None = Query(None)):
    """Net GEX / gamma flip / spot through one trading session, for the OI tab's intraday GEX view."""
    return pcr_series.gex_intraday(symbol, day, store.get_history(symbol))


@router.get("/pcr/{symbol}")
def pcr_view(symbol: str, day: str | None = Query(None), bucket: int = Query(5, ge=1, le=30)):
    """PCR + spot for one trading day, for the OI tab's PCR chart. Indices carry whole days (and earlier days) from the
    history archive; every other symbol carries what the live ring holds (roughly the last 2-3 hours)."""
    return pcr_series.build(symbol, day, bucket, store.get_history(symbol))


@router.get("/oi-change/{symbol}")
async def oi_change(
    symbol: str,
    expiry: str | None = Query(None),
    minutes: int = Query(15, ge=1, le=480),
):
    chain = await _ensure_chain(symbol, expiry)
    return {"symbol": symbol.upper(), "expiry": chain["expiry"], "minutes": minutes,
            **store.oi_change_window(symbol, chain["expiry"], minutes)}


@router.get("/oi-walls/{symbol}")
async def oi_walls_route(symbol: str, expiry: str | None = Query(None)):
    """Where the call / put OI walls (biggest-OI strikes) sat through today --
    the OI tab's Walls view. Recorded live from the polls (oi_walls.py)."""
    from . import oi_walls

    chain = await _ensure_chain(symbol, expiry)
    return {"symbol": symbol.upper(), "expiry": chain["expiry"], "points": oi_walls.series(symbol, chain["expiry"])}


@router.get("/flow/{symbol}")
async def option_flow(
    symbol: str,
    expiry: str | None = Query(None),
    window: str = Query(flow.DEFAULT_WINDOW),
):
    """Put / call writing and buying near the money, the direction they add up to and the reversals, for the Flow tab.
    window: "5" | "15" | "30" (rolling minutes) or "day" (since the previous close)."""
    chain = await _ensure_chain(symbol, expiry)
    ex = chain["expiry"]
    out = flow.view(symbol, ex, window, spot=chain.get("spot"))
    if out["trackingSince"] is None:            # first look at this symbol: seed the tracker so the DAY window reads at once
        flow.record(symbol, ex, chain)
        out = flow.view(symbol, ex, window, spot=chain.get("spot"))
    return out


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
def alerts(request: Request, limit: int = Query(100, ge=1, le=200)):
    from .users import market_alert

    rows = store.get_alerts(limit)
    if getattr(request.state, "viewer", None):  # a view-only user: market alerts only
        rows = [a for a in rows if market_alert(a)]
    return {"alerts": rows}


# ---- view-only users (the owner only: none of these are on the viewer allowlist) ----
@router.get("/users")
def users_list():
    from . import users

    return {"users": users.list_users(), "max": users.MAX_VIEWERS}


@router.post("/users")
def users_create(body: dict):
    from . import users

    try:
        users.create(body.get("name") or "", body.get("password") or "")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"users": users.list_users(), "max": users.MAX_VIEWERS}


@router.post("/users/{uid}/password")
async def users_password(uid: str, body: dict):
    from . import users
    from .hub import hub

    try:
        users.set_password(uid, body.get("password") or "")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except KeyError:
        raise HTTPException(status_code=404, detail="no such user")
    await hub.kick_viewer(uid)
    return {"users": users.list_users(), "max": users.MAX_VIEWERS}


@router.delete("/users/{uid}")
async def users_delete(uid: str):
    from . import users
    from .hub import hub

    try:
        users.delete(uid)
    except KeyError:
        raise HTTPException(status_code=404, detail="no such user")
    await hub.kick_viewer(uid)
    store._user_wls.pop(uid, None)
    store._user_papers.pop(uid, None)
    return {"users": users.list_users(), "max": users.MAX_VIEWERS}


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


@router.get("/chart/layouts")
def get_chart_layouts():
    return store.get_chart_layouts()


@router.post("/chart/layouts")
def save_chart_layouts(body: dict):
    if len(str(body)) > 200_000:
        raise HTTPException(status_code=413, detail="layouts too large")
    return store.save_chart_layouts(body)


@router.get("/chart/drawings")
def get_chart_drawings(key: str):
    return {"drawings": store.get_chart_drawings(key)}


@router.post("/chart/drawings")
def save_chart_drawings(body: dict):
    key = str(body.get("key") or "")
    if not key:
        raise HTTPException(status_code=400, detail="key required")
    drawings = body.get("drawings") or []
    return {"drawings": store.save_chart_drawings(key, drawings)}


# The last GOOD chart per (instrument, interval, source). When the feed hiccups (Upstox 429, the broker
# dropping, a restart) the answer can suddenly hold a tiny fraction of the candles, or only the "sampled"
# fallback; drawn as-is, the chart collapses and then "replays" its history when the feed recovers.
# So a degraded answer is replaced by the last good one while that is recent (and flagged `stale`).
_CHART_GOOD: "OrderedDict[tuple, tuple[float, dict]]" = OrderedDict()
_CHART_GOOD_MAX = 16          # entries kept (a payload is ~250 KB; this bounds memory on a small box)
_CHART_GOOD_MIN_CANDLES = 25  # fewer than this is never treated as a "good" reference
_CHART_STALE_MAX_S = 1800.0   # ...and is only served this long after it was good
_CHART_DEGRADED_RATIO = 0.5   # an answer with under this share of the good one's candles is degraded


def _guard_chart(key: tuple, payload: dict) -> dict:
    now = time.time()
    n = len(payload.get("candles") or [])
    if payload.get("candleSource") != "sampled" and n >= _CHART_GOOD_MIN_CANDLES:
        _CHART_GOOD[key] = (now, payload)
        _CHART_GOOD.move_to_end(key)
        while len(_CHART_GOOD) > _CHART_GOOD_MAX:
            _CHART_GOOD.popitem(last=False)
        return payload
    good = _CHART_GOOD.get(key)
    if good and now - good[0] < _CHART_STALE_MAX_S:
        gn = len(good[1].get("candles") or [])
        if payload.get("candleSource") == "sampled" or n < gn * _CHART_DEGRADED_RATIO:
            return {**good[1], "stale": True}
    return payload


@router.get("/chart/{symbol}")
async def chart(
    symbol: str,
    interval: int = Query(60, ge=15, le=2592000),  # up to 1M (2592000); 1W = 604800
    instrument: str | None = Query(None),
    src: str = Query("auto"),  # auto | broker | upstox
    lite: bool = Query(False),  # candles only (the trend strip): no option-data lines
):
    symbol = symbol.upper()
    src = (src or "auto").lower()
    # weekly / monthly are built from the daily candles (build_chart groups them), so they
    # share the daily fetch and its cache instead of asking the data source again
    fetch_iv = min(interval, 86400)

    # ---- specific option contract ----
    opt = store._parse_opt(instrument) if instrument else None
    if opt:
        sym, exp, strike, ot = opt
        candles, src_label = await candle_sources.option_candles(
            sym, exp, strike, ot, fetch_iv, src
        )

        if not candles:
            candles = [
                {"time": int(p["t"]), "open": p["ltp"], "high": p["ltp"],
                 "low": p["ltp"], "close": p["ltp"], "volume": 0}
                for p in store.get_opt_history(instrument)
            ]
            src_label = "sampled"
        return _guard_chart(
            (instrument, interval, src),
            build_chart(instrument, [], [], interval_s=interval, base_candles=candles, source_label=src_label),
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
    # sub-minute: build candles from this session's live tick stream. There is no
    # historical source finer than 1-min, so these only exist from subscribe time.
    if interval < 60:
        tc = store.tick_candles(symbol, interval)
        if tc:
            return build_chart(
                symbol,
                store.get_history(symbol),
                store.get_scan_history(symbol),
                interval_s=interval,
                base_candles=tc,
                source_label="ticks",
            )
        # no ticks yet — fall through and show 1-min until they accumulate

    base_candles, src_label = await candle_sources.underlying_candles(symbol, fetch_iv)

    return _guard_chart(
        (symbol, interval, src, lite),
        build_chart(
            symbol,
            [] if lite else store.get_history(symbol),
            [] if lite else store.get_scan_history(symbol),
            interval_s=interval,
            base_candles=base_candles,
            source_label=src_label,
        ),
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


@router.post("/watchlists/{index}/add-future")
def watchlists_add_future(index: int, body: dict):
    symbol = str(body.get("symbol", "")).upper()
    expiry = str(body.get("expiry", ""))
    if not symbol or not expiry:
        raise HTTPException(status_code=422, detail="symbol and expiry required")
    store.add_future(index, symbol, expiry)
    return {**store.get_watchlists(), "quotes": store.watch_quotes()}


@router.get("/paper")
def paper_state():
    return store.paper_state()


@router.post("/paper/order")
async def paper_order(body: PaperOrderIn):
    if body.price is None and body.option_type != "FUT":
        # load the chain first so the fill prices off the live LTP (it was 0
        # for a symbol / expiry the poller wasn't already keeping)
        try:
            await _ensure_chain(body.symbol, body.expiry)
        except Exception:  # noqa: BLE001
            pass
    order = store.place_paper_order(body)
    return {"order": order, "state": store.paper_state()}


@router.post("/paper/strategy")
async def paper_strategy(body: dict):
    """A strategy's legs as PAPER fills only -- the Builder's Execute for
    view-only users (/strategy/execute can go live, so it stays owner-only)."""
    legs = body.get("legs") or []
    if not legs:
        raise HTTPException(status_code=422, detail="at least one leg required")
    try:
        await _ensure_chain(body.get("symbol") or "", body.get("expiry") or None)
    except Exception:  # noqa: BLE001
        pass
    for leg in legs:
        ot = leg.get("optionType") or leg.get("option_type")
        if ot not in ("CE", "PE"):
            continue
        store.place_paper_order(
            PaperOrderIn(
                symbol=body.get("symbol") or "", expiry=body.get("expiry") or "", strike=float(leg.get("strike") or 0),
                option_type=ot, side=leg.get("side") or "BUY", qty_lots=int(leg.get("lots") or 1),
                price=leg.get("price"),
            )
        )
    return {"mode": "paper", "paper": store.paper_state()}


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


@router.get("/journal")
def journal_list(limit: int = 200, symbol: str | None = None):
    from . import live_journal

    return store.get_journal(limit=limit, symbol=symbol, extra=live_journal.trades())


@router.get("/journal/stats")
def journal_stats():
    from . import live_journal

    return store.journal_stats(extra=live_journal.trades())


@router.post("/journal/sync-live")
async def journal_sync_live():
    """Pull today's Flattrade OrderBook + brokerage into the journal now."""
    from . import live_journal

    return await live_journal.sync()


@router.get("/journal/review")
def journal_review(day: str | None = None):
    """One day's live trading: result, charges, and the patterns that cost money."""
    from . import live_journal

    return live_journal.review(day)


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
        # NFO for NSE names; BFO (SearchScrip-matched) for SENSEX / BANKEX
        info = await broker.resolve_option(symbol, exp, strike, option_type)
        exch = info["exch"]
        if not info["tsym"] or (exch == "BFO" and not info["confirmed"]):
            # a BFO tsym can't be built blind -- never guess one for a real-money order
            err = f"{symbol} {exp} {strike:g} {option_type} not found on {exch} ({info.get('error')}); order not sent"
            store.log_live_order({
                "mode": "live", "status": "REJECTED", "symbol": symbol, "expiry": exp,
                "strike": strike, "optionType": option_type, "side": side,
                "qtyLots": qty_lots, "exch": exch, "error": err,
            })
            raise HTTPException(status_code=400, detail=err)
        lot = info["lotSize"] or chain["lotSize"]
        qty = qty_lots * lot
        try:
            res = await broker.place_order(
                exch=exch,
                tsym=info["tsym"],
                qty=qty,
                side=side,
                order_type=order_type,
                price=price or 0.0,
                product="I" if product == "MIS" else "M",
                token=info.get("token"),
            )
        except Exception as exc:  # noqa: BLE001
            rec = {
                "mode": "live", "status": "REJECTED", "symbol": symbol, "expiry": exp,
                "strike": strike, "optionType": option_type, "side": side,
                "qtyLots": qty_lots, "qty": qty, "exch": exch, "tsym": info["tsym"], "error": str(exc),
            }
            store.log_live_order(rec)
            raise HTTPException(status_code=502, detail=f"broker rejected: {exc}")
        rec = {
            "mode": "live", "status": "PLACED", "symbol": symbol, "expiry": exp,
            "strike": strike, "optionType": option_type, "side": side,
            "qtyLots": qty_lots, "qty": qty, "exch": exch, "tsym": info["tsym"],
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


async def _route_future(
    *,
    symbol: str,
    expiry: str,
    side: str,
    qty_lots: int,
    order_type: str,
    price: float | None,
    product: str,
    mode: str,
) -> dict:
    """Futures sibling of _route_leg -- no strike/option_type to resolve, so
    no _ensure_chain call. Paper fills reuse the exact same paper-position
    machinery as options (place_paper_order/_apply_fill/_mark_price all
    already key generically on symbol+expiry+strike+optionType and now
    treat optionType=="FUT" as a strike-less instrument -- see _mark_price)."""
    if mode == "live":
        from .brokers import get_broker

        from .brokers.flattrade import is_bse_index

        broker = get_broker()
        if not broker.authed:
            raise HTTPException(status_code=400, detail="Flattrade not connected")
        if is_bse_index(symbol):
            # resolve_nfo_future only builds NFO symbols; a BFO future would go out wrong
            err = f"live {symbol.upper()} futures (BFO) aren't supported yet; order not sent"
            store.log_live_order({
                "mode": "live", "status": "REJECTED", "symbol": symbol, "expiry": expiry,
                "strike": 0.0, "optionType": "FUT", "side": side, "qtyLots": qty_lots,
                "exch": "BFO", "error": err,
            })
            raise HTTPException(status_code=400, detail=err)
        info = await broker.resolve_nfo_future(symbol, expiry)
        lot = info["lotSize"] or lot_size(symbol)
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
                token=info.get("token"),
            )
        except Exception as exc:  # noqa: BLE001
            rec = {
                "mode": "live", "status": "REJECTED", "symbol": symbol, "expiry": expiry,
                "strike": 0.0, "optionType": "FUT", "side": side,
                "qtyLots": qty_lots, "qty": qty, "tsym": info["tsym"], "error": str(exc),
            }
            store.log_live_order(rec)
            raise HTTPException(status_code=502, detail=f"broker rejected: {exc}")
        rec = {
            "mode": "live", "status": "PLACED", "symbol": symbol, "expiry": expiry,
            "strike": 0.0, "optionType": "FUT", "side": side,
            "qtyLots": qty_lots, "qty": qty, "tsym": info["tsym"],
            "orderId": res.get("orderId"), "confirmed": info["confirmed"],
        }
        store.log_live_order(rec)
        return rec

    order = store.place_paper_order(
        PaperOrderIn(
            symbol=symbol, expiry=expiry, strike=0.0, option_type="FUT",
            side=side, qty_lots=qty_lots, price=price,
        )
    )
    return {"mode": "paper", "status": "FILLED", "order": order}


@router.post("/order/future")
async def place_future_order(body: FutureOrderIn):
    mode = body.mode or store.order_mode()
    result = await _route_future(
        symbol=body.symbol, expiry=body.expiry, side=body.side, qty_lots=body.qty_lots,
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


@router.post("/strategy/chart")
async def strategy_chart_series(body: StrategyChartIn):
    """Intraday combined-premium candles + per-bar Greeks for a set of legs."""
    if not body.legs:
        raise HTTPException(status_code=422, detail="at least one leg required")
    chain = await _ensure_chain(body.symbol, body.expiry)
    try:
        return await strategy_chart.build(
            chain["symbol"],
            chain["expiry"],
            chain["lotSize"],
            [leg.dump() for leg in body.legs],
            interval_s=body.interval,
            days=body.days,
            src=body.src,
        )
    except strategy_chart.StrategyChartError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


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
async def strategy_from_broker(body: FromBrokerIn):
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
    built = strat.from_broker(positions, preferred_symbol=body.symbol)
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


# ---- scheduled runs (time-based entry / exit) -----------------------
@router.get("/strategy/schedules")
def strategy_schedules_list():
    from . import schedules

    return {"schedules": schedules.list_schedules()}


@router.post("/strategy/schedule")
def strategy_schedule_add(body: ScheduleIn):
    from . import schedules

    if not body.legs:
        raise HTTPException(status_code=422, detail="at least one leg required")
    if not (body.entry_time or body.exit_time):
        raise HTTPException(status_code=422, detail="set an entry and/or exit time")
    row = schedules.add_schedule(
        {
            "symbol": body.symbol,
            "expiry": body.expiry,
            "legs": [leg.dump() for leg in body.legs],
            "entryTime": body.entry_time,
            "exitTime": body.exit_time,
            "repeat": body.repeat,
            "mode": body.mode,
            "note": body.note,
        }
    )
    return {"schedule": row, "schedules": schedules.list_schedules()}


@router.delete("/strategy/schedule/{sid}")
def strategy_schedule_del(sid: str):
    from . import schedules

    return {"schedules": schedules.cancel(sid)}


@router.post("/strategy/schedules/clear")
def strategy_schedules_clear():
    from . import schedules

    return {"schedules": schedules.clear_finished()}


# ---- price-triggered leg rules (entry @ price + SL / trail / target) ----
@router.get("/leg-rules")
def leg_rules_list():
    from . import leg_rules

    return {"rules": leg_rules.list_rules()}


@router.post("/leg-rules")
def leg_rules_add(body: dict):
    from . import leg_rules

    for k in ("symbol", "expiry", "strike", "optionType", "triggerPx"):
        if body.get(k) in (None, ""):
            raise HTTPException(status_code=422, detail=f"{k} is required")
    if not any(body.get(k) for k in ("sl", "target", "trail")):
        raise HTTPException(status_code=422, detail="set a stop-loss, target or trail")
    row = leg_rules.add_rule(body)
    return {"rule": row, "rules": leg_rules.list_rules()}


@router.post("/leg-rules/attach")
def leg_rules_attach(body: dict):
    """Bracket an already-open broker position (manual 1-click / scalp /
    anything not opened by AutoBot or a leg rule) with SL / trail / target.
    Takes the position's own tsym + PositionBook fields, same shape the
    Positions panel already has on hand -- no separate lookup needed."""
    from .brokers.flattrade import parse_noren_tsym
    from . import leg_rules

    tsym = body.get("tsym")
    parsed = parse_noren_tsym(tsym) if tsym else None
    if not parsed:
        raise HTTPException(status_code=422, detail="tsym missing or not a recognised option symbol")
    if body.get("entryPx") in (None, ""):
        raise HTTPException(status_code=422, detail="entryPx is required")
    if not any(body.get(k) not in (None, "") for k in ("sl", "target", "trail")):
        raise HTTPException(status_code=422, detail="set a stop-loss, target or trail")
    try:
        net_qty = float(body.get("netqty") or 0)
    except (TypeError, ValueError):
        net_qty = 0.0
    if not net_qty:
        raise HTTPException(status_code=422, detail="netqty is required (position must be open)")
    # lot size comes from our own authoritative lookup, never the client --
    # get this wrong and the eventual auto square-off order is sized wrong.
    from .leg_rules import _lot_size as _authoritative_lot_size

    lot_sz = _authoritative_lot_size(store, parsed["symbol"])
    lots = max(1, round(abs(net_qty) / lot_sz))
    if abs(lots * lot_sz - abs(net_qty)) > 0.01:
        raise HTTPException(
            status_code=422,
            detail=f"position qty {net_qty:.0f} isn't a whole multiple of the "
                   f"{parsed['symbol']} lot size ({lot_sz}) -- refusing to guess the lot count",
        )
    payload = {
        **parsed,
        "side": "BUY" if net_qty > 0 else "SELL",
        "lots": lots,
        "mode": "live",
        "product": body.get("prd") or "NRML",
        "entryPx": body.get("entryPx"),
        "sl": body.get("sl"),
        "target": body.get("target"),
        "trail": body.get("trail"),
        "unit": body.get("unit") or "pts",
        "note": "position bracket",
    }
    try:
        row = leg_rules.attach_to_position(payload)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"rule": row, "rules": leg_rules.list_rules()}


# ---- strike-level OI threshold alerts ----
@router.get("/oi-alerts")
def oi_alerts_list():
    from . import oi_alerts

    return {"rules": oi_alerts.list_rules()}


@router.post("/oi-alerts")
def oi_alerts_add(body: dict):
    from . import oi_alerts

    for k in ("symbol", "expiry", "strike", "optionType", "value"):
        if body.get(k) in (None, ""):
            raise HTTPException(status_code=422, detail=f"{k} is required")
    try:
        row = oi_alerts.add_rule(body)
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"rule": row, "rules": oi_alerts.list_rules()}


@router.delete("/oi-alerts/{rid}")
def oi_alerts_del(rid: str):
    from . import oi_alerts

    return {"rules": oi_alerts.cancel(rid)}


# ---- portfolio-level Greeks (net across every open position) ----
def _fnum(v) -> float:
    try:
        x = float(v)
        return x if x == x else 0.0  # drop NaN
    except (TypeError, ValueError):
        return 0.0


@router.get("/portfolio-greeks")
async def portfolio_greeks():
    from .oi_alerts import _leg as _chain_leg

    def _empty() -> dict:
        return {"delta": 0.0, "gamma": 0.0, "theta": 0.0, "vega": 0.0, "positions": 0}

    def _add(bucket: dict, leg: dict, qty: float) -> None:
        bucket["positions"] += 1
        for k in ("delta", "gamma", "theta", "vega"):
            bucket[k] += _fnum(leg.get(k)) * qty

    paper = _empty()
    paper_by_symbol: dict[str, dict] = {}
    for p in store.paper["positions"]:
        qty = _fnum(p.get("qty"))
        if not qty:
            continue
        leg = _chain_leg(store, p["symbol"], p["expiry"], p["strike"], p["optionType"])
        if not leg:
            continue
        # one chain lookup feeds both the portfolio total and that symbol's
        # own subtotal, same as the live loop below
        _add(paper, leg, qty)
        _add(paper_by_symbol.setdefault(p["symbol"], _empty()), leg, qty)

    live = _empty()
    live_by_symbol: dict[str, dict] = {}
    from .brokers import get_broker
    from .brokers.flattrade import parse_noren_tsym

    broker = get_broker()
    if broker.configured and broker.authed:
        try:
            rows = await broker.positions()
        except Exception:  # noqa: BLE001
            rows = []
        for r in rows or []:
            netqty = _fnum(r.get("netqty"))
            parsed = parse_noren_tsym(r.get("tsym") or "", r.get("dname")) if netqty else None
            if not parsed:
                continue
            leg = _chain_leg(store, parsed["symbol"], parsed["expiry"], parsed["strike"], parsed["optionType"])
            if not leg:
                continue
            # one chain lookup feeds both the portfolio total and that
            # symbol's own subtotal -- a blended total can hide two
            # opposite bets (e.g. +80 NIFTY delta offset by -30 SENSEX)
            # behind one calmer-looking number
            _add(live, leg, netqty)
            _add(live_by_symbol.setdefault(parsed["symbol"], _empty()), leg, netqty)

    for bucket in (paper, live, *paper_by_symbol.values(), *live_by_symbol.values()):
        for k in ("delta", "gamma", "theta", "vega"):
            bucket[k] = round(bucket[k], 4)
    by_symbol = lambda d: [  # noqa: E731
        {"symbol": sym, **bucket} for sym, bucket in sorted(d.items(), key=lambda kv: -abs(kv[1]["delta"]))
    ]
    return {
        "paper": paper,
        "paperBySymbol": by_symbol(paper_by_symbol),
        "live": live,
        "liveBySymbol": by_symbol(live_by_symbol),
    }


@router.post("/margin-estimate")
def margin_estimate(body: dict):
    """Rough pre-trade margin check for a prospective LIVE order, using the
    same heuristic store.paper_state() already uses for blocked margin on
    paper positions: SHORT_OPTION_MARGIN_PCT of strike notional per lot for
    a short leg, full premium for a long one. Not real SPAN+exposure -- a
    same-order-of-magnitude warning before submitting, not a broker-accurate
    figure; OrderConfirm.tsx compares this against the account's actual
    available margin so a shortfall is caught before the order is sent,
    instead of discovering it from a broker rejection after the fact."""
    legs = (body or {}).get("legs") or []
    lot_size = _fnum((body or {}).get("lotSize")) or 1
    total = 0.0
    for leg in legs:
        qty = _fnum(leg.get("lots")) * lot_size
        if not qty:
            continue
        if str(leg.get("side") or "").upper() == "SELL":
            total += SHORT_OPTION_MARGIN_PCT * _fnum(leg.get("strike")) * qty
        else:
            total += _fnum(leg.get("price")) * qty
    return {"estimated": round(total, 2)}


# ---- alert delivery (webhook / Telegram) ----
@router.get("/alert-delivery")
def alert_delivery_get():
    from . import alert_delivery

    return alert_delivery.get_config()


@router.post("/alert-delivery")
def alert_delivery_set(body: dict):
    from . import alert_delivery

    return alert_delivery.set_config(body or {})


@router.delete("/alert-delivery/{field}")
def alert_delivery_clear(field: str):
    from . import alert_delivery

    try:
        return alert_delivery.clear_field(field)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/alert-delivery/test")
async def alert_delivery_test():
    from . import alert_delivery

    res = await alert_delivery.send_test()
    if not res.get("ok"):
        raise HTTPException(status_code=422, detail=res.get("error") or "nothing configured")
    return res


# ---- web push (per-device, alongside webhook / Telegram) ----
@router.get("/push/vapid-key")
def push_vapid_key():
    from . import push

    return {"configured": push.configured(), "key": push.public_key()}


@router.post("/push/subscribe")
def push_subscribe(body: dict):
    from . import push

    try:
        return push.add_subscription(body or {})
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))


@router.post("/push/unsubscribe")
def push_unsubscribe(body: dict):
    from . import push

    return push.remove_subscription((body or {}).get("endpoint") or "")


@router.get("/push/status")
def push_status(endpoint: str = ""):
    from . import push

    return {"configured": push.configured(), "subscribed": bool(endpoint) and push.has_subscription(endpoint)}


@router.post("/push/test")
async def push_test():
    from . import push

    res = await push.send_test()
    if not res.get("ok"):
        raise HTTPException(status_code=422, detail=res.get("error") or "send failed")
    return res


@router.delete("/leg-rules/{rid}")
def leg_rules_del(rid: str):
    from . import leg_rules

    return {"rules": leg_rules.cancel(rid)}


@router.post("/leg-rules/clear")
def leg_rules_clear():
    from . import leg_rules

    return {"rules": leg_rules.clear_finished()}


# ---- price-level alerts (fire once when spot reaches a level) ----
@router.get("/price-alerts")
def price_alerts_list():
    from . import price_alerts

    return {"alerts": price_alerts.list_alerts()}


@router.post("/price-alerts")
def price_alerts_add(body: dict):
    from . import price_alerts

    for k in ("symbol", "level"):
        if body.get(k) in (None, ""):
            raise HTTPException(status_code=422, detail=f"{k} is required")
    try:
        row = price_alerts.add_alert(body)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"alert": row, "alerts": price_alerts.list_alerts()}


@router.delete("/price-alerts/{aid}")
def price_alerts_del(aid: str):
    from . import price_alerts

    return {"alerts": price_alerts.cancel(aid)}


@router.post("/price-alerts/clear")
def price_alerts_clear():
    from . import price_alerts

    return {"alerts": price_alerts.clear_finished()}


# ---- short-strike guard: live delta of every open short option + the roll back to ~0.20 ----
@router.get("/short-guard")
def short_guard_view():
    from . import short_guard

    return {"legs": short_guard.snapshot(), "levels": list(short_guard.LEVELS), "target": short_guard.TARGET}


# ---- indicator alerts (fire once when EMA proximity / RSI level hits, on a chosen timeframe) ----
@router.get("/indicator-alerts")
def indicator_alerts_list():
    from . import indicator_alerts

    return {"alerts": indicator_alerts.list_alerts()}


@router.post("/indicator-alerts")
def indicator_alerts_add(body: dict):
    from . import indicator_alerts

    for k in ("symbol", "kind"):
        if body.get(k) in (None, ""):
            raise HTTPException(status_code=422, detail=f"{k} is required")
    try:
        row = indicator_alerts.add_alert(body)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"alert": row, "alerts": indicator_alerts.list_alerts()}


@router.delete("/indicator-alerts/{aid}")
def indicator_alerts_del(aid: str):
    from . import indicator_alerts

    return {"alerts": indicator_alerts.cancel(aid)}


@router.post("/indicator-alerts/clear")
def indicator_alerts_clear():
    from . import indicator_alerts

    return {"alerts": indicator_alerts.clear_finished()}


@router.get("/mtm-alerts")
def mtm_alerts_list():
    from . import mtm_alerts

    return {"alerts": mtm_alerts.list_alerts()}


@router.post("/mtm-alerts")
def mtm_alerts_add(body: dict):
    from . import mtm_alerts

    if body.get("level") in (None, ""):
        raise HTTPException(status_code=422, detail="level is required")
    try:
        row = mtm_alerts.add_alert(body)
    except (ValueError, KeyError) as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return {"alert": row, "alerts": mtm_alerts.list_alerts()}


@router.delete("/mtm-alerts/{aid}")
def mtm_alerts_del(aid: str):
    from . import mtm_alerts

    return {"alerts": mtm_alerts.cancel(aid)}


@router.post("/mtm-alerts/clear")
def mtm_alerts_clear():
    from . import mtm_alerts

    return {"alerts": mtm_alerts.clear_finished()}
