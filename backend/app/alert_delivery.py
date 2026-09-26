"""Push fired alerts out to a webhook and/or Telegram, on top of the in-app
Alerts feed everything already lands in (broker-bracket hits, leg-rule
fills, OI watches, unusual Greeks activity, schedules -- anything that
calls store.add_alert). Wired in at that single choke point, so every
alert source gets delivery for free with no change to any of them.

Config lives in the kv_store table (key "alert_delivery"), as one JSON blob:
    {
      "enabled": false,
      "webhookUrl": null,
      "telegramBotToken": null,
      "telegramChatId": null,
      "minSeverity": "warning",   # info | warning | critical -- only
                                   # alerts at or above this go out
      "autobotAlerts": "all",     # all | important | off -- the auto-trading engine's own
                                   # events (entries, exits, errors, safety stops). They are
                                   # info-level by nature, so minSeverity would silently drop
                                   # every entry and exit; this is their own switch instead.
      "symbols": [],              # MARKET alerts (gamma blast, IV / straddle / OI surge, flow
                                   # reversal, delta-gamma jumps) only for these underlyings;
                                   # [] = every symbol. Alerts about your own positions and
                                   # your own rules always go out, whatever is picked here.
      "greeksAlerts": "big",      # big | all | off -- unusual delta / gamma moves on single
                                   # strikes. "big" = only the very big ones the poller marks
                                   # critical (near the money, nearest expiry, market hours,
                                   # one per symbol per 10 min); all of them was one a minute.
    }
"""
from __future__ import annotations

import asyncio
import logging
import time

import httpx

from . import db

log = logging.getLogger("alert_delivery")
_KV_KEY = "alert_delivery"
_SEV_ORDER = {"info": 0, "warning": 1, "critical": 2}
_DEFAULT = {
    "enabled": False,
    "webhookUrl": None,
    "telegramBotToken": None,
    "telegramChatId": None,
    "minSeverity": "warning",
    "autobotAlerts": "all",
    "greeksAlerts": "big",
    "symbols": [],
}
_AUTOBOT_MODES = ("all", "important", "off")
# "important" = the events you must act on or know happened: exits, errors, safety stops
_AUTOBOT_IMPORTANT = ("autobot-exit", "autobot-error", "autobot-stop")
_GREEKS_MODES = ("big", "all", "off")
# alerts about the MARKET (not about the user's own positions or rules) -- the
# ones the symbol filter applies to
_MARKET_KINDS = ("blast-crit", "blast-warn", "blast-build", "iv-spike", "straddle-exp", "oi-surge", "flow-reversal", "volume-spike")


def _is_market(alert: dict) -> bool:
    return alert.get("kind") in _MARKET_KINDS or alert.get("category") == "greeks"


def _load() -> dict:
    return {**_DEFAULT, **(db.get_kv(_KV_KEY) or {})}


def _save(cfg: dict) -> None:
    db.set_kv(_KV_KEY, cfg)


def get_config() -> dict:
    """Never hands the raw bot token back to the client -- same spirit as
    not printing broker secrets. `*Set` flags tell the UI whether a value
    is already configured without exposing it again after save."""
    cfg = _load()
    out = {
        "enabled": cfg["enabled"],
        "minSeverity": cfg["minSeverity"],
        "autobotAlerts": cfg["autobotAlerts"],
        "greeksAlerts": cfg["greeksAlerts"],
        "symbols": list(cfg.get("symbols") or []),
        "webhookUrlSet": bool(cfg.get("webhookUrl")),
        "telegramSet": bool(cfg.get("telegramBotToken") and cfg.get("telegramChatId")),
    }
    return out


def set_config(patch: dict) -> dict:
    cfg = _load()
    for k in ("webhookUrl", "telegramBotToken", "telegramChatId"):
        if k in patch:
            v = str(patch[k] or "").strip()
            cfg[k] = v or None
    if patch.get("minSeverity") in _SEV_ORDER:
        cfg["minSeverity"] = patch["minSeverity"]
    if patch.get("autobotAlerts") in _AUTOBOT_MODES:
        cfg["autobotAlerts"] = patch["autobotAlerts"]
    if patch.get("greeksAlerts") in _GREEKS_MODES:
        cfg["greeksAlerts"] = patch["greeksAlerts"]
    if isinstance(patch.get("symbols"), list):
        cfg["symbols"] = sorted({str(x).strip().upper() for x in patch["symbols"] if str(x).strip()})
    if "enabled" in patch:
        cfg["enabled"] = bool(patch["enabled"])
    _save(cfg)
    return get_config()


def clear_field(field: str) -> dict:
    if field not in ("webhookUrl", "telegramBotToken", "telegramChatId"):
        raise ValueError("unknown field")
    cfg = _load()
    cfg[field] = None
    if field in ("telegramBotToken", "telegramChatId"):
        cfg["telegramBotToken"] = None
        cfg["telegramChatId"] = None
    _save(cfg)
    return get_config()


async def _post_webhook(url: str, alert: dict) -> None:
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            await c.post(url, json=alert)
    except Exception as exc:  # noqa: BLE001
        log.debug("webhook delivery failed: %s", exc)


async def _post_telegram(token: str, chat_id: str, text: str) -> None:
    try:
        async with httpx.AsyncClient(timeout=8.0) as c:
            await c.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json={"chat_id": chat_id, "text": text},
            )
    except Exception as exc:  # noqa: BLE001
        log.debug("telegram delivery failed: %s", exc)


def _format_telegram(alert: dict) -> str:
    sym = alert.get("symbol") or ""
    msg = alert.get("message") or ""
    head = f"\U0001f514 GammaTerminal" + (f" · {sym}" if sym else "")
    return f"{head}\n{msg}".strip()


def deliver(alert: dict) -> None:
    """Fire-and-forget: schedules delivery without making add_alert (or any
    of its ~10 call sites across the codebase) async."""
    cfg = _load()
    if not cfg.get("enabled"):
        return
    # market alerts only for the chosen symbols (none chosen = all of them)
    picked = cfg.get("symbols") or []
    if picked and _is_market(alert) and str(alert.get("symbol") or "").upper() not in picked:
        return
    if alert.get("category") == "autobot":
        mode = cfg.get("autobotAlerts", "all")
        if mode == "off" or (mode == "important" and alert.get("kind") not in _AUTOBOT_IMPORTANT):
            return
    elif alert.get("category") == "greeks":
        mode = cfg.get("greeksAlerts", "big")
        if mode == "off" or (mode == "big" and alert.get("severity") != "critical"):
            return
    elif alert.get("category") == "volume":
        pass  # its own level (Settings / Volume tab: off / 2x / 3x / 5x) decided it already
    else:
        sev = alert.get("severity") or "info"
        if _SEV_ORDER.get(sev, 0) < _SEV_ORDER.get(cfg.get("minSeverity", "warning"), 1):
            return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return  # no running loop (e.g. a sync script/test) -- nothing to schedule onto
    if cfg.get("webhookUrl"):
        loop.create_task(_post_webhook(cfg["webhookUrl"], alert))
    if cfg.get("telegramBotToken") and cfg.get("telegramChatId"):
        loop.create_task(
            _post_telegram(cfg["telegramBotToken"], cfg["telegramChatId"], _format_telegram(alert))
        )
    from . import push

    push.deliver(alert)


async def send_test() -> dict:
    cfg = _load()
    has_webhook = bool(cfg.get("webhookUrl"))
    has_telegram = bool(cfg.get("telegramBotToken") and cfg.get("telegramChatId"))
    if not has_webhook and not has_telegram:
        return {"ok": False, "error": "nothing configured yet"}
    test_alert = {
        "ts": time.time(), "symbol": "TEST", "kind": "TEST", "severity": "critical",
        "message": "Test alert from GammaTerminal Settings — delivery is working.",
        "score": 0,
    }
    if has_webhook:
        await _post_webhook(cfg["webhookUrl"], test_alert)
    if has_telegram:
        await _post_telegram(cfg["telegramBotToken"], cfg["telegramChatId"], _format_telegram(test_alert))
    return {"ok": True, "webhook": has_webhook, "telegram": has_telegram}
