"""One-time migration: import the old flat-JSON data files into the
SQLite database app/db.py now reads from.

Safe by default: if a destination (a kv_store key or a table) already
has data, that piece is SKIPPED rather than overwritten -- so running
this twice, or running it after the backend has already been live on
SQLite for a while, can't clobber real trades/journal entries with
stale JSON. Pass --force to override that and re-import anyway.

Nothing here deletes the original .json files -- they're left in place
as a manual backup/rollback until you're confident and remove them
yourself.

Run from the backend/ directory, ideally with the service stopped so
nothing is writing to the old files or the new DB mid-migration:

    sudo systemctl stop gammaterminal-backend
    ./.venv/bin/python migrate_to_sqlite.py
    sudo systemctl start gammaterminal-backend
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from app.config import DATA_DIR  # noqa: E402
from app import db  # noqa: E402

FORCE = "--force" in sys.argv


def _read_json(name: str):
    p = DATA_DIR / name
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text("utf-8"))
    except Exception as exc:  # noqa: BLE001
        print(f"  ! failed to read {name}: {exc}")
        return None


def migrate_kv(json_name: str, kv_key: str) -> None:
    if not FORCE and db.get_kv(kv_key) is not None:
        print(f'  = kv_store["{kv_key}"] already has data -- skipping {json_name}')
        return
    doc = _read_json(json_name)
    if doc is None:
        print(f"  - {json_name}: not found, skipping")
        return
    db.set_kv(kv_key, doc)
    print(f'  + {json_name} -> kv_store["{kv_key}"]')


def migrate_rows(json_name: str, table: str, *, ts_key: str | None = None) -> None:
    db.ensure_table(table)
    if not FORCE:
        existing = db.load_rows(table)
        if existing:
            print(f'  = table "{table}" already has {len(existing)} rows -- skipping {json_name}')
            return
    doc = _read_json(json_name)
    if not isinstance(doc, list) or not doc:
        print(f"  - {json_name}: not found or empty, skipping")
        return
    db.replace_all(table, doc, ts_key=ts_key)
    print(f'  + {json_name} -> table "{table}" ({len(doc)} rows)')


def main() -> None:
    print(f"Data dir:    {DATA_DIR}")
    print(f"SQLite file: {db.DB_PATH}")
    if FORCE:
        print("--force: will overwrite any already-migrated data")
    print()

    print("Singleton configs:")
    migrate_kv("settings.json", "settings")
    migrate_kv("paper.json", "paper")
    migrate_kv("iv_history.json", "iv_history")
    migrate_kv("alert_delivery.json", "alert_delivery")
    migrate_kv("broker_bracket.json", "broker_bracket")
    migrate_kv("autobot.json", "autobot")
    migrate_kv("autobot_state.json", "autobot_state")
    migrate_kv("autobot_log.json", "autobot_log")

    # watchlists: only migrate the new-format file here. If only the older
    # single-list watchlist.json exists, leave it -- store.py's existing
    # legacy-upgrade path already handles that automatically on first boot
    # (it always did, JSON or not; nothing about that path changed).
    if not FORCE and db.get_kv("watchlists") is not None:
        print('  = kv_store["watchlists"] already has data -- skipping watchlists.json')
    else:
        wl = _read_json("watchlists.json")
        if isinstance(wl, dict) and wl.get("lists"):
            db.set_kv("watchlists", wl)
            print('  + watchlists.json -> kv_store["watchlists"]')
        else:
            print("  - watchlists.json: not found (legacy watchlist.json, if any, "
                  "upgrades automatically on next backend start)")

    print("\nRow collections:")
    migrate_rows("journal.json", "journal", ts_key="closedTs")
    migrate_rows("oi_alerts.json", "oi_alerts", ts_key="createdAt")
    migrate_rows("leg_rules.json", "leg_rules", ts_key="createdAt")
    migrate_rows("schedules.json", "schedules", ts_key="createdAt")

    print("\nSaved strategies (dict-of-records -> row collection):")
    if not FORCE and db.load_rows("saved_strategies"):
        print('  = table "saved_strategies" already has data -- skipping strategies.json')
    else:
        doc = _read_json("strategies.json")
        if isinstance(doc, dict) and doc:
            db.replace_all("saved_strategies", list(doc.values()), ts_key="savedAt")
            print(f'  + strategies.json -> table "saved_strategies" ({len(doc)} rows)')
        else:
            print("  - strategies.json: not found or empty, skipping")

    print("\nDone. Original .json files were left in place, untouched, as a backup.")
    print("Restart the backend for it to read from SQLite.")


if __name__ == "__main__":
    main()
