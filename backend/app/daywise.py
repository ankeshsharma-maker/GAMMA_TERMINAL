"""Day-wise P&L with and without charges, from Flattrade's own "Expense / TO" report.

The report (Reports -> Expense / TO, xlsx) has one row per trading day: the day's trading result before charges
(NetTurnOver) and the bill after charges (BillAmount), plus every charge line. Importing it fills this table; the
Journal's Day-wise view reads it. Re-importing a newer file just overwrites those days."""
from __future__ import annotations

import base64
import re
import sqlite3
import threading
import time
import zipfile
import xml.etree.ElementTree as ET
from datetime import date, datetime
from io import BytesIO

from .config import DATA_DIR

_DB = DATA_DIR / "daywise.db"
_lock = threading.Lock()
_NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}


def _conn() -> sqlite3.Connection:
    c = sqlite3.connect(str(_DB), check_same_thread=False)
    c.execute(
        "CREATE TABLE IF NOT EXISTS days (d TEXT PRIMARY KEY, turnover REAL, gross REAL, stt REAL, stamp REAL, exch REAL, "
        "sebi REAL, gst REAL, brokerage REAL, charges REAL, net REAL, src TEXT, ts REAL)"
    )
    return c


def _col(ref: str) -> int:
    n = 0
    for ch in re.match(r"[A-Z]+", ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


def _sheet_rows(data: bytes) -> list[list]:
    z = zipfile.ZipFile(BytesIO(data))
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", _NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % _NS["m"])))
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rmap = {r.get("Id"): r.get("Target") for r in rels}
    sh = wb.find("m:sheets", _NS)[0]
    target = rmap[sh.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")]
    target = target if target.startswith("xl/") else "xl/" + target.lstrip("/")
    root = ET.fromstring(z.read(target))
    rows: list[list] = []
    for r in root.iter("{%s}row" % _NS["m"]):
        cells: dict[int, object] = {}
        for c in r.findall("m:c", _NS):
            t = c.get("t")
            v = c.find("m:v", _NS)
            if t == "s" and v is not None:
                val: object = shared[int(v.text)]
            elif t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter("{%s}t" % _NS["m"]))
            elif v is not None:
                try:
                    val = float(v.text)
                except Exception:  # noqa: BLE001
                    val = v.text
            else:
                continue
            cells[_col(c.get("r"))] = val
        if cells:
            rows.append([cells.get(i) for i in range(max(cells) + 1)])
    return rows


def parse(data: bytes) -> list[dict]:
    rows = _sheet_rows(data)
    hi = next((i for i, r in enumerate(rows) if any(str(x).strip() == "TradeDate" for x in r if x is not None)), None)
    if hi is None:
        raise ValueError("this does not look like the Flattrade Expense / TO report (no TradeDate column)")
    hdr = {str(x).strip(): i for i, x in enumerate(rows[hi]) if x not in (None, "")}

    def g(r: list, name: str) -> float:
        i = hdr.get(name)
        if i is None or i >= len(r) or r[i] in (None, ""):
            return 0.0
        try:
            return float(r[i])
        except Exception:  # noqa: BLE001
            return 0.0

    out = []
    for r in rows[hi + 1:]:
        raw = r[hdr["TradeDate"]] if hdr["TradeDate"] < len(r) else None
        if not isinstance(raw, str) or not re.match(r"\d\d/\d\d/\d{4}$", raw.strip()):
            continue  # the totals row
        d = datetime.strptime(raw.strip(), "%d/%m/%Y").date().isoformat()
        gross = g(r, "NetTurnOver")
        net = g(r, "BillAmount")
        out.append({
            "d": d,
            "turnover": g(r, "Turnover"),
            "gross": round(gross, 2),
            "net": round(net, 2),
            "charges": round(gross - net, 2),
            "stt": g(r, "STT/CTT"),
            "stamp": g(r, "Stamp Duty"),
            "exch": round(g(r, "OT DEF4BSE") + g(r, "OT DEF4NSE") + g(r, "Transaction"), 2),
            "sebi": round(g(r, "OT SEBITOC") + g(r, "SEBI"), 2),
            "gst": round(g(r, "IGST") + g(r, "CGST") + g(r, "SGST") + g(r, "ServiceTax"), 2),
            "brokerage": g(r, "Brokerage"),
        })
    if not out:
        raise ValueError("no trading days found in that file")
    return out


def import_bytes(data: bytes, name: str = "") -> dict:
    days = parse(data)
    with _lock:
        c = _conn()
        c.executemany(
            "INSERT OR REPLACE INTO days (d, turnover, gross, stt, stamp, exch, sebi, gst, brokerage, charges, net, src, ts) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [(x["d"], x["turnover"], x["gross"], x["stt"], x["stamp"], x["exch"], x["sebi"], x["gst"], x["brokerage"],
              x["charges"], x["net"], name[:80], time.time()) for x in days],
        )
        c.commit()
        c.close()
    ds = sorted(x["d"] for x in days)
    return {"ok": True, "days": len(days), "from": ds[0], "to": ds[-1]}


def import_b64(b64: str, name: str = "") -> dict:
    return import_bytes(base64.b64decode(b64), name)


def list_days() -> dict:
    with _lock:
        c = _conn()
        rows = c.execute(
            "SELECT d, turnover, gross, stt, stamp, exch, sebi, gst, brokerage, charges, net FROM days ORDER BY d"
        ).fetchall()
        c.close()
    keys = ["d", "turnover", "gross", "stt", "stamp", "exch", "sebi", "gst", "brokerage", "charges", "net"]
    days = [dict(zip(keys, r)) for r in rows]
    for x in days:
        x["dow"] = date.fromisoformat(x["d"]).strftime("%a")
    # from the app's own order records: the day-wise result on the day each position was CLOSED (FIFO), so a position
    # carried overnight books its whole result on the day it is closed (or expires), not its buy on one day and its sale on another
    real: dict[str, float] = {}
    carried: dict[str, int] = {}
    start = None
    try:
        from . import live_journal
        from datetime import datetime as _dt

        ds = live_journal.days()
        start = ds[-1] if ds else None
        for t in live_journal.trades():
            k = live_journal._day(t["closedTs"])
            real[k] = real.get(k, 0.0) + t["pnl"]
        carried = live_journal.carried_by_day()
    except Exception:  # noqa: BLE001
        pass
    for x in days:
        covered = start is not None and x["d"] >= start
        x["real"] = round(real.get(x["d"], 0.0), 2) if covered else None
        x["carried"] = carried.get(x["d"], 0) if covered else None
    return {"days": days, "from": days[0]["d"] if days else None, "to": days[-1]["d"] if days else None, "realFrom": start}
