"""Background task: when a broker session exists, stream real-time underlying
ticks over the broker WebSocket and fan them out as `tick` messages.

If the broker WebSocket is down (token expired overnight, or Flattrade's
one-socket-per-login limit) the loop falls back to polling GetQuotes over REST
so charts keep moving, and periodically calls ``broker.refresh()`` to try to
heal the session without the user hitting the header refresh button.
"""
from __future__ import annotations

import asyncio
import logging
import time

from .brokers import get_broker
from .config import DEFAULT_SYMBOLS
from .hub import hub
from .store import store

log = logging.getLogger("broker_feed")

_tok2sym: dict[str, str] = {}
_token_cache: dict[str, tuple[str, str]] = {}
_last_emit: dict[str, float] = {}

# min seconds between fan-outs per symbol. The frontend coalesces incoming ticks
# at ~5 Hz and charts only need ~1/s, so there is no point broadcasting faster.
_EMIT_MIN_GAP = 1.0


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


async def _on_tick(token: str, msg: dict) -> None:
    sym = _tok2sym.get(token)
    if not sym:
        return
    ltp = _num(msg.get("lp"))
    if ltp is None:
        return
    chg = _num(msg.get("pc"))
    store.set_live_spot(sym, ltp, chg)

    now = time.time()
    if now - _last_emit.get(sym, 0) < _EMIT_MIN_GAP:
        return
    _last_emit[sym] = now
    await hub.broadcast_all(
        {"type": "tick", "data": {"symbol": sym, "ltp": ltp, "chgPct": chg, "ts": now}}
    )


async def _desired_symbols() -> set[str]:
    subs = {s for s, _ in hub.subscriptions()}
    wl = {e.split("|")[0].upper() for e in store.watchlist}
    return {s.upper() for s in (set(DEFAULT_SYMBOLS) | wl | subs)}


_bad_tokens: set[str] = set()  # tokens that keep returning junk — stop polling them


async def _rest_poll(broker) -> None:
    """One round of GetQuotes for every cached feed token, pushed through the
    same `_on_tick` path the WS uses. Only runs while the WS feed is down."""
    for sym, (exch, token) in list(_token_cache.items()):
        if token in _bad_tokens:
            continue
        try:
            q = await broker.quotes(exch, token)
        except Exception as exc:  # noqa: BLE001
            log.debug("rest quote failed for %s: %s", sym, exc)
            continue
        if q and q.get("stat") == "Not_Ok":
            # a bad token (e.g. SENSEX / BANKEX have no NSE scrip) — quit
            # hammering GetQuotes with it every 3s
            _bad_tokens.add(token)
            _token_cache.pop(sym, None)
            log.info("dropping bad feed token for %s (%s)", sym, q.get("emsg"))
            continue
        if q and q.get("lp") is not None:
            _tok2sym[token] = sym
            await _on_tick(token, {"lp": q.get("lp"), "pc": q.get("pc")})


async def run_broker_feed(stop: asyncio.Event) -> None:
    broker = get_broker()
    if not broker.configured:
        log.info("broker not configured; live feed disabled")
        return

    # wait for a session (user completes the login flow). While waiting, retry
    # refresh() once a minute so a token saved earlier today, or one that was
    # transiently rejected, recovers on its own.
    last_refresh = 0.0
    while not stop.is_set() and not broker.authed:
        if time.time() - last_refresh > 60:
            last_refresh = time.time()
            try:
                await broker.refresh()
            except Exception as exc:  # noqa: BLE001
                log.debug("startup refresh failed: %s", exc)
        try:
            await asyncio.wait_for(stop.wait(), timeout=5)
        except asyncio.TimeoutError:
            pass
    if stop.is_set():
        return

    log.info("broker feed starting for %s", broker.status().get("clientId"))
    await broker.start_ws(_on_tick)

    down_since: float | None = None
    warned = False
    last_reauth = 0.0
    while not stop.is_set():
        st = broker.status()
        ws_down = broker.authed and not st.get("wsConnected")

        if ws_down:
            down_since = down_since or time.time()
            outage = time.time() - down_since
            # surface a prolonged live-feed outage once (charts fall back to the
            # REST poll below meanwhile, which lags and isn't tick-by-tick)
            if not warned and outage > 30:
                store.add_alert(
                    {
                        "ts": time.time(),
                        "kind": "BROKER_FEED",
                        "symbol": "—",
                        "severity": "warning",
                        "message": "Live broker feed: "
                        + (st.get("wsError") or "disconnected")
                        + ". Charts are on delayed REST data until it reconnects.",
                        "score": 0,
                    }
                )
                try:
                    await hub.broadcast_all({"type": "alerts", "data": store.get_alerts(50)})
                except Exception:  # noqa: BLE001
                    pass
                warned = True
            # try to heal a stuck socket: re-validate the token + bounce the WS
            if outage > 45 and time.time() - last_reauth > 120:
                last_reauth = time.time()
                try:
                    log.info("live feed down %.0fs — attempting broker.refresh()", outage)
                    await broker.refresh()
                except Exception as exc:  # noqa: BLE001
                    log.debug("auto-refresh failed: %s", exc)
        else:
            down_since = None
            warned = False

        if broker.authed:
            want = await _desired_symbols()
            keys: set[str] = set()
            for sym in want:
                cached = _token_cache.get(sym)
                if not cached:
                    try:
                        cached = await broker.feed_token(sym)
                    except Exception as exc:  # noqa: BLE001
                        log.debug("feed token lookup failed for %s: %s", sym, exc)
                        cached = None
                    if cached:
                        _token_cache[sym] = cached
                        _tok2sym[cached[1]] = sym
                if cached:
                    keys.add(f"{cached[0]}|{cached[1]}")
            if keys:
                try:
                    await broker.subscribe(keys)
                except Exception as exc:  # noqa: BLE001
                    log.debug("subscribe failed: %s", exc)

        if ws_down and broker.authed:
            # keep charts moving on ~3s REST quotes until the socket is back
            await _rest_poll(broker)
            timeout = 3
        else:
            timeout = 20
        try:
            await asyncio.wait_for(stop.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            pass

    await broker.stop_ws()
    log.info("broker feed stopped")
