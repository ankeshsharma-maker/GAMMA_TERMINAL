"""Web Push delivery for fired alerts -- a third channel alongside the
webhook/Telegram delivery in alert_delivery.py, wired in at the same
choke point (alert_delivery.deliver, called from store.add_alert).

Subscriptions (one per browser/device that tapped "Enable" in Settings)
live in kv_store key "push_subscriptions" as a JSON list of
{endpoint, keys: {p256dh, auth}}. VAPID keys are server config, not user
data -- read from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT),
generated once with the __main__ block below and pasted into .env.

pywebpush's `webpush()` is a blocking call (uses `requests`), so every send
goes through asyncio.to_thread -- this process also runs the live broker
feed and AutoBot's poller loop on the same event loop, and those can't
stall waiting on a push service's TLS round-trip.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os

from pywebpush import WebPushException, webpush

from . import db

log = logging.getLogger("push")
_KV_KEY = "push_subscriptions"

VAPID_PUBLIC_KEY = os.environ.get("VAPID_PUBLIC_KEY", "")
VAPID_PRIVATE_KEY = os.environ.get("VAPID_PRIVATE_KEY", "")
VAPID_SUBJECT = os.environ.get("VAPID_SUBJECT", "mailto:ankeshsharma@gmail.com")


def configured() -> bool:
    return bool(VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY)


def public_key() -> str:
    return VAPID_PUBLIC_KEY


def _load() -> list[dict]:
    return db.get_kv(_KV_KEY) or []


def _save(subs: list[dict]) -> None:
    db.set_kv(_KV_KEY, subs)


def list_subscriptions() -> list[dict]:
    return _load()


def add_subscription(sub: dict) -> dict:
    endpoint = sub.get("endpoint")
    keys = sub.get("keys") or {}
    if not endpoint or not keys.get("p256dh") or not keys.get("auth"):
        raise ValueError("invalid subscription")
    subs = [s for s in _load() if s.get("endpoint") != endpoint]
    subs.append({"endpoint": endpoint, "keys": {"p256dh": keys["p256dh"], "auth": keys["auth"]}})
    _save(subs)
    return {"ok": True, "count": len(subs)}


def remove_subscription(endpoint: str) -> dict:
    subs = [s for s in _load() if s.get("endpoint") != endpoint]
    _save(subs)
    return {"ok": True, "count": len(subs)}


def has_subscription(endpoint: str) -> bool:
    return any(s.get("endpoint") == endpoint for s in _load())


def _send_one(sub: dict, payload: dict) -> bool:
    try:
        webpush(
            subscription_info=sub,
            data=json.dumps(payload),
            vapid_private_key=VAPID_PRIVATE_KEY,
            vapid_claims={"sub": VAPID_SUBJECT},
            ttl=60,
        )
        return True
    except WebPushException as exc:
        status = getattr(exc.response, "status_code", None)
        if status in (404, 410):
            # push service says this subscription is gone for good -- stop
            # trying it forever rather than erroring on every future alert
            remove_subscription(sub.get("endpoint", ""))
        else:
            log.debug("push delivery failed (%s): %s", status, exc)
        return False
    except Exception as exc:  # noqa: BLE001
        log.debug("push delivery failed: %s", exc)
        return False


def _payload_for(alert: dict) -> dict:
    sym = alert.get("symbol") or ""
    return {
        "title": "GammaTerminal" + (f" · {sym}" if sym else ""),
        "body": alert.get("message") or "",
        "tag": alert.get("kind") or "gt-alert",
        "url": "/",
    }


def deliver(alert: dict) -> None:
    """Fire-and-forget: schedules a send per subscription, same shape as
    alert_delivery._post_webhook's loop.create_task calls."""
    if not configured():
        return
    subs = _load()
    if not subs:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    payload = _payload_for(alert)
    for sub in subs:
        loop.create_task(asyncio.to_thread(_send_one, sub, payload))


async def send_test() -> dict:
    if not configured():
        return {"ok": False, "error": "VAPID keys not configured on the server"}
    subs = _load()
    if not subs:
        return {"ok": False, "error": "no subscriptions yet -- tap Enable in Settings first"}
    payload = {
        "title": "GammaTerminal",
        "body": "Test push from Settings -- delivery is working.",
        "tag": "gt-test",
        "url": "/",
    }
    results = await asyncio.gather(*[asyncio.to_thread(_send_one, s, payload) for s in subs])
    ok = sum(1 for r in results if r)
    return {"ok": ok > 0, "sent": ok, "total": len(subs)}


if __name__ == "__main__":
    # one-off: `python -m app.push` prints a fresh VAPID keypair to paste
    # into .env as VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY. Never committed,
    # never stored in the DB -- same treatment as FLATTRADE_API_SECRET.
    import base64

    from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
    from py_vapid import Vapid02

    v = Vapid02()
    v.generate_keys()
    priv = v.private_key.private_numbers().private_value.to_bytes(32, "big")
    pub = v.public_key.public_bytes(Encoding.X962, PublicFormat.UncompressedPoint)
    print("VAPID_PRIVATE_KEY=" + base64.urlsafe_b64encode(priv).rstrip(b"=").decode())
    print("VAPID_PUBLIC_KEY=" + base64.urlsafe_b64encode(pub).rstrip(b"=").decode())
