"""Where candles come from.

One place that knows which feed to ask first for an option contract or an
underlying, shared by /api/chart and the strategy chart so the two can't drift.
Provider modules are imported at call time (not module load) on purpose: the
broker/Upstox singletons are swapped in and out at runtime.
"""
from __future__ import annotations

# Noren TPSeries supports these minute intervals; anything else is resampled client-side.
NOREN_INTERVALS = (1, 3, 5, 10, 15, 30, 60, 120, 240)


def noren_params(interval: int) -> tuple[int, int]:
    """(TPSeries minute interval, minutes to look back) for a chart interval in seconds."""
    mins = max(1, interval // 60)
    fetch_min = max((m for m in NOREN_INTERVALS if m <= mins), default=1)
    lookback = min(max(2400, mins * 600), 60 * 24 * 40)
    return fetch_min, lookback


async def option_candles(
    sym: str,
    exp: str,
    strike: float,
    ot: str,
    interval: int,
    src: str = "auto",
    lookback: int | None = None,
) -> tuple[list[dict] | None, str]:
    """(candles, source label) for one option contract, or (None, "sampled")
    when no provider has it. `src` is auto | broker | upstox; `lookback`
    overrides how many minutes of history the broker is asked for."""
    from . import upstox_data
    from .brokers import get_broker
    from .brokers.upstox import get_upstox

    broker = get_broker()
    fetch_min, default_lookback = noren_params(interval)
    lookback = lookback or default_lookback
    candles = None
    label = "sampled"

    want_ux = src == "upstox" or (src == "auto" and not broker.authed)
    if want_ux and get_upstox().authed:
        try:
            c = await upstox_data.fetch_option_candles(sym, exp, strike, ot, interval)
            if c:
                candles, label = c, "upstox"
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
                    label = "broker"
        except Exception:  # noqa: BLE001
            candles = None

    # last-ditch: Upstox even if not explicitly asked
    if not candles and get_upstox().authed:
        try:
            c = await upstox_data.fetch_option_candles(sym, exp, strike, ot, interval)
            if c:
                candles, label = c, "upstox"
        except Exception:  # noqa: BLE001
            candles = None

    return (candles or None), label


async def underlying_candles(
    symbol: str, interval: int, lookback: int | None = None
) -> tuple[list[dict] | None, str]:
    """(candles, source label) for an index / stock underlying at >= 1-min
    resolution. Upstox first when it is the configured data source, then the
    broker's TPSeries, then Upstox as the fallback for BSE indices and long
    daily ranges."""
    from . import upstox_data
    from .brokers import get_broker
    from .brokers.upstox import get_upstox
    from .store import store

    broker = get_broker()
    fetch_min, default_lookback = noren_params(interval)
    lookback = lookback or default_lookback
    candles: list[dict] | None = None
    label = "broker"

    async def _ux():
        try:
            return await upstox_data.fetch_underlying_candles(symbol, interval)
        except Exception:  # noqa: BLE001
            return None

    if store.data_source() == "upstox" and get_upstox().authed:
        candles = await _ux()
        if candles:
            label = "upstox"

    if not candles and broker.authed:
        try:
            tok = await broker.feed_token(symbol)
            if tok:
                candles = await broker.tpseries(
                    tok[0], tok[1], minutes_back=lookback, interval=str(fetch_min)
                )
                if candles:
                    label = "broker"
        except Exception:  # noqa: BLE001
            candles = None

    if not candles and get_upstox().authed:
        candles = await _ux()
        if candles:
            label = "upstox"

    return (candles or None), label
