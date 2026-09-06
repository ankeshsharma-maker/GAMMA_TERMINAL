"""Background task: refresh NSE v3 snapshots for all active (symbol, expiry) pairs."""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, time as dtime
from zoneinfo import ZoneInfo

from . import scanner, screener, upstox_data
from .brokers.upstox import get_upstox
from .config import (
    FO_UNIVERSE,
    OFFHOURS_POLL_INTERVAL,
    POLL_INTERVAL,
    SCREENER_STAGGER,
)
from .hub import hub
from .nse_client import client
from .processing import build_chain
from .store import store

log = logging.getLogger("poller")
IST = ZoneInfo("Asia/Kolkata")
_MKT_OPEN, _MKT_CLOSE = dtime(9, 15), dtime(15, 30)
_EXP_TTL = 300  # re-pull the expiry list at most this often

_exp_refreshed: dict[str, float] = {}


def _in_market_hours(now: datetime | None = None) -> bool:
    now = now or datetime.now(IST)
    if now.weekday() >= 5:
        return False
    return _MKT_OPEN <= now.time() <= _MKT_CLOSE


def _use_upstox(symbol: str) -> bool:
    # Upstox's Analytics Access Token serves *frozen* intraday data on the
    # /v2/option/chain REST endpoint (OI / LTP don't tick during the session),
    # so "Change in OI" never updates on it. Use Upstox for the live option
    # chain ONLY for BSE indices (SENSEX / BANKEX) that NSE can't provide;
    # every NSE underlying (indices + F&O stocks) uses NSE's live chain.
    if store.data_source() != "upstox" or not get_upstox().authed:
        return False
    key = get_upstox().instrument_key(symbol)
    return bool(key) and key.startswith("BSE_INDEX")


async def _ensure_expiries(symbol: str) -> None:
    if store.expiries.get(symbol) and time.time() - _exp_refreshed.get(symbol, 0) < _EXP_TTL:
        return
    try:
        exps: list[str] = []
        if _use_upstox(symbol):
            exps = await upstox_data.fetch_expiries(symbol)
        if not exps:  # not an Upstox symbol, or Upstox gave nothing -> NSE
            exps = await client.expiries(symbol)
        if exps:
            store.set_expiries(symbol, exps)
            _exp_refreshed[symbol] = time.time()
    except Exception as exc:  # noqa: BLE001
        store.put_error(symbol, f"expiry list: {exc}")
        log.warning("expiry list failed for %s: %s", symbol, exc)


async def _refresh(symbol: str, expiry: str) -> None:
    try:
        payload = None
        if _use_upstox(symbol):
            payload = await upstox_data.fetch_chain_payload(symbol, expiry)
        if not payload:  # non-Upstox symbol, or a miss this cycle -> NSE
            payload = await client.option_chain(symbol, expiry)
        events = store.put_raw(symbol, expiry, payload)
        await hub.broadcast(symbol, expiry)
        if events:
            for e in events:
                log.info("UNUSUAL %s", e["message"])
            await hub.broadcast_all({"type": "unusual", "data": store.get_unusual(60)})
    except Exception as exc:  # noqa: BLE001 - keep the loop alive
        store.put_error(symbol, str(exc))
        log.warning("refresh failed for %s %s: %s", symbol, expiry, exc)


async def _backfill_spot(symbols: list[str]) -> None:
    for sym in symbols:
        try:
            pts = await client.index_intraday(sym)
            if pts:
                added = store.seed_spot_history(sym, pts)
                log.info("backfilled %d intraday spot points for %s", added, sym)
        except Exception as exc:  # noqa: BLE001
            log.debug("intraday backfill skipped for %s: %s", sym, exc)
        await asyncio.sleep(0.5)


def _nearest_live_expiry(symbol: str) -> str | None:
    """Nearest expiry that hasn't already lapsed (skips an expired front month)."""
    from .processing import days_to_expiry

    exps = store.expiries.get(symbol.upper()) or []
    for e in exps:
        try:
            if days_to_expiry(e) > 0:
                return e
        except Exception:  # noqa: BLE001
            continue
    return exps[0] if exps else None


async def _scan_universe_symbol(symbol: str) -> None:
    try:
        await _ensure_expiries(symbol)
        exp = _nearest_live_expiry(symbol)
        if not exp:
            return
        payload = await client.option_chain(symbol, exp)
        chain = build_chain(payload, symbol, exp)
        iv_series = store.push_iv(symbol, chain.get("atmIV"))
        sess_open = store.session_open(symbol, chain["spot"])
        row = screener.evaluate(symbol, chain, iv_series, sess_open)
        store.set_universe_row(symbol, row)
    except Exception as exc:  # noqa: BLE001 - keep the sweep alive
        log.debug("universe scan failed for %s: %s", symbol, exc)


async def run_universe_scan(stop: asyncio.Event) -> None:
    log.info("universe scan started (%d symbols)", len(FO_UNIVERSE))
    while not stop.is_set():
        store.set_universe_progress(
            total=len(FO_UNIVERSE), scanned=0, cycleStart=time.time()
        )
        for i, sym in enumerate(FO_UNIVERSE):
            if stop.is_set():
                break
            store.set_universe_progress(current=sym)
            await _scan_universe_symbol(sym)
            store.set_universe_progress(scanned=i + 1)
            await hub.broadcast_all(
                {"type": "screener", "data": store.get_universe(), "progress": store.universe_progress}
            )
            stagger = SCREENER_STAGGER if _in_market_hours() else SCREENER_STAGGER * 4
            try:
                await asyncio.wait_for(stop.wait(), timeout=stagger)
            except asyncio.TimeoutError:
                pass
        store.set_universe_progress(lastFull=time.time(), current=None)
        if not _in_market_hours():
            try:
                await asyncio.wait_for(stop.wait(), timeout=600)
            except asyncio.TimeoutError:
                pass
    log.info("universe scan stopped")


_indices_at = 0.0


async def _refresh_indices() -> None:
    global _indices_at
    if time.time() - _indices_at < 45:
        return
    try:
        rows = await client.all_indices()
        if rows:
            store.set_indices(rows)
            _indices_at = time.time()
    except Exception as exc:  # noqa: BLE001
        log.debug("allIndices refresh failed: %s", exc)


async def run_poller(stop: asyncio.Event) -> None:
    log.info("poller started")
    await _refresh_indices()
    await _backfill_spot(store.all_symbols())
    while not stop.is_set():
        symbols = sorted({s for s, _ in hub.subscriptions()} | set(store.all_symbols()))
        for sym in symbols:
            await _ensure_expiries(sym)

        # (symbol, expiry) set: front-month for everything + whatever clients watch
        pairs: set[tuple[str, str]] = set()
        for sym in symbols:
            near = store.nearest_expiry(sym)
            if near:
                pairs.add((sym, near))
        for sym, exp in hub.subscriptions():
            resolved = store.resolve_expiry(sym, exp)
            if resolved:
                pairs.add((sym.upper(), resolved))

        ordered = sorted(pairs)
        for i, (sym, exp) in enumerate(ordered):
            if stop.is_set():
                break
            await _refresh(sym, exp)
            if i < len(ordered) - 1:
                await asyncio.sleep(0.8)  # be gentle with NSE

        await _refresh_indices()
        await hub.broadcast_watchlist()

        try:
            result = scanner.run(store)
            await hub.broadcast_all({"type": "scan", "data": result["scan"]})
            if result["newAlerts"]:
                await hub.broadcast_all({"type": "alerts", "data": store.get_alerts(50)})
                for a in result["newAlerts"]:
                    log.info("ALERT %s", a["message"])
        except Exception as exc:  # noqa: BLE001
            log.warning("scanner failed: %s", exc)

        try:
            from .autobot import autobot

            if await autobot.tick():
                await hub.broadcast_all({"type": "autobot", "data": autobot.snapshot()})
        except Exception as exc:  # noqa: BLE001
            log.warning("autobot tick failed: %s", exc)

        try:
            hits = store.check_stops()
            for h in hits:
                sev = "warning" if (h.get("pnl") or 0) < 0 else "info"
                store.add_alert(
                    {
                        "ts": h["ts"], "symbol": h["symbol"], "kind": "sl-hit",
                        "severity": sev, "message": h["message"], "score": 0,
                    }
                )
                log.info("STOP %s", h["message"])
            if hits:
                await hub.broadcast_all({"type": "alerts", "data": store.get_alerts(50)})
        except Exception as exc:  # noqa: BLE001
            log.warning("stop check failed: %s", exc)

        try:
            from . import schedules

            ev = await schedules.tick()
            for e in ev:
                store.add_alert(
                    {
                        "ts": time.time(), "symbol": e.get("symbol", ""),
                        "kind": e["kind"], "severity": "info",
                        "message": e["message"], "score": 0,
                    }
                )
                log.info("SCHEDULE %s", e["message"])
            if ev:
                await hub.broadcast_all({"type": "alerts", "data": store.get_alerts(50)})
                await hub.broadcast_all(
                    {"type": "schedules", "data": schedules.list_schedules()}
                )
        except Exception as exc:  # noqa: BLE001
            log.warning("schedule tick failed: %s", exc)

        interval = POLL_INTERVAL if _in_market_hours() else OFFHOURS_POLL_INTERVAL
        try:
            await asyncio.wait_for(stop.wait(), timeout=interval)
        except asyncio.TimeoutError:
            pass
    log.info("poller stopped")
