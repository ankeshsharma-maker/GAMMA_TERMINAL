"""Telegram alert when the server disk reaches 90% (run from cron every 30 min).
Sends through the app's own Telegram settings; at most once per 24 h while it stays high."""
import asyncio
import shutil
import sys
import time
from pathlib import Path

sys.path.insert(0, "/opt/gammaterminal/backend")
from app import alert_delivery as ad  # noqa: E402

LIMIT = 0.90
STAMP = Path("/tmp/disk_alert_sent")

u = shutil.disk_usage("/")
pct = u.used / u.total
if pct < LIMIT:
    STAMP.unlink(missing_ok=True)
    sys.exit(0)
if STAMP.exists() and time.time() - STAMP.stat().st_mtime < 86400:
    sys.exit(0)
cfg = ad._load()
tok, chat = cfg.get("telegramBotToken"), cfg.get("telegramChatId")
if not (tok and chat):
    print("no telegram configured")
    sys.exit(1)
text = f"⚠️ GammaTerminal server disk {pct*100:.0f}% full ({u.used/2**30:.1f} of {u.total/2**30:.0f} GB). Free space soon."
asyncio.run(ad._post_telegram(tok, chat, text))
STAMP.touch()
print("sent", text)
