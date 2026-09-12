"""Shared SQLite persistence, replacing the flat-JSON-file-per-module
pattern used across store.py / leg_rules.py / oi_alerts.py / etc.

Design: every "collection" (a list of dict rows a module used to keep in
one JSON array) becomes a table of (id, ts, data) where `data` is the row
as JSON -- the module's own dict shape is untouched, callers still get
back the exact same list[dict] / dict they always did. This is a storage
swap, not a schema redesign: nothing here changes what a route or the
poller receives. Every "singleton config" (a single JSON object a module
used to keep in one file) becomes one row in a generic key/value table.

Why not fully normalize into typed columns per field? Nothing in this
app ever queries these collections with SQL -- every call site loads the
whole list into Python and filters/maps it there. Normalizing would mean
touching every field access across ~6 modules for no real capability
gain. The win we actually want is atomic, crash-safe writes and not
rewriting an entire (growing) file on every single change -- a
JSON-blob-per-row table gives us that with a minimal, low-risk diff.

Single connection, single lock: this process is effectively single-
threaded (FastAPI's event loop + the poller's asyncio tasks all run on
it), so one connection reused everywhere is safe; the lock only guards
against the rare case of a genuinely separate thread.
"""
from __future__ import annotations

import json
import sqlite3
import threading
import time
from typing import Any

from .config import DATA_DIR

DB_PATH = DATA_DIR / "gammaterminal.db"
_lock = threading.RLock()

_conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
_conn.execute("PRAGMA journal_mode=WAL")
_conn.execute("PRAGMA synchronous=NORMAL")
_conn.execute(
    "CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT NOT NULL)"
)
_conn.commit()

_known_tables: set[str] = set()


def ensure_table(table: str) -> None:
    """Create a (id, ts, data) row-collection table if it doesn't exist yet."""
    if table in _known_tables:
        return
    with _lock:
        _conn.execute(
            f'CREATE TABLE IF NOT EXISTS "{table}" '
            "(id TEXT PRIMARY KEY, ts REAL NOT NULL, data TEXT NOT NULL)"
        )
        _conn.execute(f'CREATE INDEX IF NOT EXISTS "idx_{table}_ts" ON "{table}" (ts)')
        _conn.commit()
    _known_tables.add(table)


def load_rows(table: str, *, order: str = "ASC") -> list[dict]:
    """All rows in a collection, decoded, ordered by ts (insertion/event order)."""
    ensure_table(table)
    direction = "DESC" if order.upper() == "DESC" else "ASC"
    with _lock:
        cur = _conn.execute(f'SELECT data FROM "{table}" ORDER BY ts {direction}')
        rows = cur.fetchall()
    out = []
    for (raw,) in rows:
        try:
            out.append(json.loads(raw))
        except (TypeError, ValueError):
            continue
    return out


def save_row(table: str, row_id: str, data: dict, *, ts: float | None = None) -> None:
    """Insert or fully replace one row -- the atomic, single-row write that
    replaces "load whole list, append/mutate in Python, rewrite whole file"."""
    ensure_table(table)
    with _lock:
        _conn.execute(
            f'INSERT OR REPLACE INTO "{table}" (id, ts, data) VALUES (?, ?, ?)',
            (row_id, ts if ts is not None else time.time(), json.dumps(data, default=str)),
        )
        _conn.commit()


def delete_row(table: str, row_id: str) -> None:
    ensure_table(table)
    with _lock:
        _conn.execute(f'DELETE FROM "{table}" WHERE id = ?', (row_id,))
        _conn.commit()


def replace_all(table: str, rows: list[dict], *, id_key: str = "id", ts_key: str | None = None) -> None:
    """Atomically swap a whole collection for a new list -- the direct
    translation of the old "load list, mutate several rows in Python, save
    list back once" call sites (e.g. a tick() that updates many rules)."""
    ensure_table(table)
    now = time.time()
    with _lock:
        _conn.execute(f'DELETE FROM "{table}"')
        _conn.executemany(
            f'INSERT INTO "{table}" (id, ts, data) VALUES (?, ?, ?)',
            [
                (
                    str(r.get(id_key) or i),
                    float(r[ts_key]) if ts_key and r.get(ts_key) is not None else now,
                    json.dumps(r, default=str),
                )
                for i, r in enumerate(rows)
            ],
        )
        _conn.commit()


def get_kv(key: str) -> Any:
    with _lock:
        cur = _conn.execute("SELECT value FROM kv_store WHERE key = ?", (key,))
        row = cur.fetchone()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except (TypeError, ValueError):
        return None


def set_kv(key: str, value: Any) -> None:
    with _lock:
        _conn.execute(
            "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?, ?)",
            (key, json.dumps(value, default=str)),
        )
        _conn.commit()


def raw_connection() -> sqlite3.Connection:
    """Escape hatch for the one-off JSON->SQLite migration script only."""
    return _conn
