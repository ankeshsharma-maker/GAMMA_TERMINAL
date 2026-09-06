"""In-memory state + tiny JSON persistence for watchlist and paper trades.

Raw NSE snapshots are keyed by (symbol, expiry) because the v3 API is per-expiry.
"""
from __future__ import annotations

import json
import threading
import time
import uuid
from collections import deque
from typing import Optional

from .config import (
    DATA_DIR,
    DEFAULT_SYMBOLS,
    GREEK_DELTA_JUMP,
    GREEK_EVENT_TTL,
    GREEK_GAMMA_JUMP_PCT,
    GREEK_NEAR_ATM_STRIKES,
    HISTORY_MAXLEN,
    PAPER_CAPITAL,
    SHORT_OPTION_MARGIN_PCT,
    SCREENER_IV_HISTORY_MAXLEN,
)
from .processing import build_chain, lot_size

_WATCHLIST_FILE = DATA_DIR / "watchlist.json"
_WATCHLISTS_FILE = DATA_DIR / "watchlists.json"
_WL_DEFAULT = 3
_WL_MAX = 8
_PAPER_FILE = DATA_DIR / "paper.json"
_SETTINGS_FILE = DATA_DIR / "settings.json"
_HIST_DIR = DATA_DIR / "history"
_HIST_DIR.mkdir(parents=True, exist_ok=True)
_lock = threading.RLock()


def _load(path, fallback):
    try:
        return json.loads(path.read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return fallback


def _save(path, obj):
    path.write_text(json.dumps(obj, indent=2, default=str), "utf-8")


class Store:
    def __init__(self) -> None:
        self.raw: dict[tuple[str, str], dict] = {}     # (symbol, expiry) -> raw v3 payload
        self.fetched_at: dict[tuple[str, str], float] = {}
        self.expiries: dict[str, list[str]] = {}       # symbol -> expiry list
        self.errors: dict[str, str] = {}               # symbol -> last error
        self._processed: dict[tuple, dict] = {}        # (symbol, expiry, fetched_at) -> chain
        self.history: dict[str, deque] = {}            # symbol -> deque[metrics]
        self.scan_history: dict[str, deque] = {}       # symbol -> deque[{t,score,bias}]
        self.scan_results: dict[str, dict] = {}        # symbol -> scanner row
        self.alerts: deque = deque(maxlen=200)         # newest first
        self.unusual: deque = deque(maxlen=200)        # unusual Greeks events, newest first
        self._prev_greeks: dict[tuple, dict] = {}      # (symbol,expiry) -> {(strike,ot): (delta,gamma)}
        self.universe: dict[str, dict] = {}            # symbol -> screener row
        self.iv_history: dict[str, deque] = {}         # symbol -> deque[atmIV]
        self.session_ref: dict[str, tuple] = {}        # symbol -> (date, open spot)
        self.universe_progress: dict = {
            "scanned": 0, "total": 0, "cycleStart": None, "lastFull": None, "current": None,
        }
        self.live_spot: dict[str, dict] = {}          # symbol -> {ltp, chgPct, ts}
        self.index_quotes: dict[str, dict] = {}       # NSE index name -> {last, pChange, ts}
        self.index_catalog: list[dict] = []           # [{symbol, name, category}]
        self.opt_history: dict[str, deque] = {}       # option key -> deque[{t, ltp}]
        self.oi_series: dict[tuple, deque] = {}       # (symbol,expiry) -> deque[{t, oi:{strike:(ceOi,peOi)}}]
        self._hist_writes = 0
        self._load_history()
        self.watchlists: dict = self._load_watchlists()
        self.paper: dict = _load(
            _PAPER_FILE, {"positions": [], "orders": [], "realized": 0.0}
        )
        self.settings: dict = _load(_SETTINGS_FILE, {"orderMode": "paper"})
        self.live_orders: deque = deque(maxlen=100)  # log of routed live orders

    # ---- symbol / expiry helpers ------------------------------------------
    def all_symbols(self, extra: Optional[set[str]] = None) -> list[str]:
        with _lock:
            every = set(DEFAULT_SYMBOLS)
            for l in self.watchlists["lists"]:
                for e in l["symbols"]:
                    if e.startswith("IDX:"):
                        continue
                    every.add(e.split("|")[0].upper() if "|" in e else e)
            return sorted(every | (extra or set()))

    def set_expiries(self, symbol: str, expiries: list[str]) -> None:
        with _lock:
            if expiries:
                self.expiries[symbol.upper()] = expiries
                self.errors.pop(symbol.upper(), None)

    def nearest_expiry(self, symbol: str) -> Optional[str]:
        exps = self.expiries.get(symbol.upper())
        return exps[0] if exps else None

    def resolve_expiry(self, symbol: str, expiry: Optional[str]) -> Optional[str]:
        exps = self.expiries.get(symbol.upper()) or []
        if expiry and expiry in exps:
            return expiry
        if expiry and not exps:
            return expiry  # trust caller until we learn the list
        return exps[0] if exps else expiry

    # ---- raw snapshots --------------------------------------------------
    def put_raw(self, symbol: str, expiry: str, payload: dict) -> list[dict]:
        """Store a snapshot; returns any new "unusual Greeks" events."""
        symbol = symbol.upper()
        now = time.time()
        with _lock:
            self.raw[(symbol, expiry)] = payload
            self.fetched_at[(symbol, expiry)] = now
            self.errors.pop(symbol, None)
            rec_exps = payload.get("records", {}).get("expiryDates")
            if rec_exps:
                self.expiries[symbol] = list(rec_exps)
            self._processed = {
                k: v for k, v in self._processed.items() if not (k[0] == symbol and k[1] == expiry)
            }
            try:
                chain = build_chain(payload, symbol, expiry)
            except Exception:
                return []
            self._record_history(symbol, expiry, now, chain)
            self._record_opt_history(symbol, expiry, chain, now)
            self._record_oi_series(symbol, expiry, chain, now)
            return self._detect_greek_moves(symbol, expiry, chain, now)

    _OI_SERIES_MAXLEN = 600  # ~10h at 60s polls

    def _record_oi_series(self, symbol: str, expiry: str, chain: dict, now: float) -> None:
        snap = {
            int(r["strike"]): (r["call"]["oi"] or 0, r["put"]["oi"] or 0)
            for r in chain.get("rows", [])
        }
        if not snap:
            return
        dq = self.oi_series.setdefault((symbol.upper(), expiry), deque(maxlen=self._OI_SERIES_MAXLEN))
        dq.append({"t": now, "oi": snap})

    def oi_change_window(self, symbol: str, expiry: str, minutes: int) -> dict:
        """Per-strike OI change over a rolling window (vs the snapshot ~`minutes` ago)."""
        dq = self.oi_series.get((symbol.upper(), expiry))
        if not dq:
            return {"strikes": {}, "baseTs": None, "curTs": None, "coverageMin": 0}
        now = time.time()
        cutoff = now - minutes * 60
        base = dq[0]
        for s in dq:
            if s["t"] <= cutoff:
                base = s
            else:
                break
        cur = dq[-1]
        out: dict[str, dict] = {}
        for strike, (ce, pe) in cur["oi"].items():
            b = base["oi"].get(strike)
            if b is None:
                continue
            out[str(strike)] = {
                "ceOi": ce,
                "peOi": pe,
                "ceOiChg": ce - b[0],
                "peOiChg": pe - b[1],
            }
        return {
            "strikes": out,
            "baseTs": base["t"],
            "curTs": cur["t"],
            "coverageMin": round((cur["t"] - dq[0]["t"]) / 60, 1),
        }

    def put_error(self, symbol: str, msg: str) -> None:
        with _lock:
            self.errors[symbol.upper()] = msg

    def get_chain(self, symbol: str, expiry: str | None = None) -> Optional[dict]:
        symbol = symbol.upper()
        with _lock:
            exp = self.resolve_expiry(symbol, expiry)
            if exp is None:
                return None
            raw = self.raw.get((symbol, exp))
            fa = self.fetched_at.get((symbol, exp))
            if raw is None:
                return None
            key = (symbol, exp, fa)
            chain = self._processed.get(key)
            if chain is None:
                chain = build_chain(raw, symbol, exp)
                chain["fetchedAt"] = fa
                # merge the full expiry list we know about (v3 payload carries it too)
                if self.expiries.get(symbol):
                    chain["expiries"] = self.expiries[symbol]
                self._processed[key] = chain
            chain["liveSpot"] = self.live_spot.get(symbol)
            chain["hotGreeks"] = self.hot_greeks(symbol, exp)
            return chain

    # ---- history (gamma-blast groundwork + charts) -------------------
    def _load_history(self) -> None:
        for f in _HIST_DIR.glob("*.json"):
            pts = _load(f, [])
            if isinstance(pts, list) and pts:
                self.history[f.stem.upper()] = deque(pts[-HISTORY_MAXLEN:], maxlen=HISTORY_MAXLEN)

    def _persist_history(self, symbol: str) -> None:
        dq = self.history.get(symbol)
        if dq:
            _save(_HIST_DIR / f"{symbol}.json", list(dq))

    def _record_history(self, symbol: str, expiry: str, now: float, chain: dict) -> None:
        if self.nearest_expiry(symbol) not in (None, expiry):
            return  # only track the front-month series
        dq = self.history.setdefault(symbol, deque(maxlen=HISTORY_MAXLEN))
        atm_row = next(
            (r for r in chain.get("rows", []) if r["strike"] == chain.get("atmStrike")), None
        )
        atm_ce_iv = atm_pe_iv = None
        atm_ce_dl = atm_pe_dl = atm_ce_ga = atm_pe_ga = None
        if atm_row:
            atm_ce_iv = atm_row["call"].get("ivCalc") or atm_row["call"].get("iv")
            atm_pe_iv = atm_row["put"].get("ivCalc") or atm_row["put"].get("iv")
            atm_ce_dl = atm_row["call"].get("delta")
            atm_pe_dl = atm_row["put"].get("delta")
            atm_ce_ga = atm_row["call"].get("gamma")
            atm_pe_ga = atm_row["put"].get("gamma")
        dq.append(
            {
                "t": now,
                "expiry": expiry,
                "spot": chain["spot"],
                "atmIV": chain["atmIV"],
                "atmCEIV": atm_ce_iv,
                "atmPEIV": atm_pe_iv,
                "atmCEDelta": atm_ce_dl,
                "atmPEDelta": atm_pe_dl,
                "atmCEGamma": atm_ce_ga,
                "atmPEGamma": atm_pe_ga,
                "atmStraddle": chain.get("atmStraddle"),
                "atmGammaOI": chain.get("atmGammaOI"),
                "pcr": chain["pcr"],
                "netGex": chain["netGex"],
                "gammaFlip": chain.get("gammaFlip"),
                "maxPain": chain["maxPain"],
                "dte": chain["dte"],
                "ceOI": chain["totals"].get("ceOI"),
                "peOI": chain["totals"].get("peOI"),
                "ceOIChg": chain["totals"]["ceOIChg"],
                "peOIChg": chain["totals"]["peOIChg"],
                "ceVol": chain["totals"].get("ceVol"),
                "peVol": chain["totals"].get("peVol"),
            }
        )
        self._hist_writes += 1
        if self._hist_writes % 20 == 0:
            self._persist_history(symbol)

    # ---- unusual Greeks activity --------------------------------------
    def _recent_unusual(self, symbol: str, strike: float, ot: str, within: float) -> bool:
        now = time.time()
        return any(
            e["symbol"] == symbol
            and e["strike"] == strike
            and e["optionType"] == ot
            and now - e["ts"] < within
            for e in self.unusual
        )

    def _detect_greek_moves(self, symbol: str, expiry: str, chain: dict, now: float) -> list[dict]:
        key = (symbol, expiry)
        prev = self._prev_greeks.get(key, {})
        cur: dict = {}
        events: list[dict] = []
        atm = chain.get("atmStrike") or 0
        step = chain.get("strikeStep") or 50.0
        band = GREEK_NEAR_ATM_STRIKES * step

        for r in chain.get("rows", []):
            if abs(r["strike"] - atm) > band:
                continue
            for ot, leg in (("CE", r["call"]), ("PE", r["put"])):
                d, g = leg["delta"], leg["gamma"]
                cur[(r["strike"], ot)] = (d, g)
                p = prev.get((r["strike"], ot))
                if not p:
                    continue
                pd, pg = p
                dd = d - pd
                dg = g - pg
                rel_g = abs(dg) / max(abs(pg), 1e-6)
                kind = None
                if abs(dd) >= GREEK_DELTA_JUMP and abs(g) > 1e-5:
                    kind = "DELTA_JUMP"
                elif rel_g >= GREEK_GAMMA_JUMP_PCT and abs(pg) > 5e-5:
                    kind = "GAMMA_SPIKE" if dg > 0 else "GAMMA_COLLAPSE"
                if not kind or self._recent_unusual(symbol, r["strike"], ot, 150):
                    continue
                label = {
                    "DELTA_JUMP": "delta jump",
                    "GAMMA_SPIKE": "gamma spike",
                    "GAMMA_COLLAPSE": "gamma collapse",
                }[kind]
                ev = {
                    "ts": now,
                    "symbol": symbol,
                    "expiry": expiry,
                    "strike": r["strike"],
                    "optionType": ot,
                    "kind": kind,
                    "dDelta": round(dd, 4),
                    "dGamma": round(dg, 6),
                    "delta": d,
                    "gamma": g,
                    "prevDelta": pd,
                    "prevGamma": pg,
                    "severity": "warning",
                    "message": (
                        f"{symbol} {r['strike']:.0f}{ot} {label}: "
                        f"Δ {pd:+.2f}→{d:+.2f} ({dd:+.2f}), Γ {pg:.4f}→{g:.4f}"
                    ),
                }
                events.append(ev)
                self.unusual.appendleft(ev)

        self._prev_greeks[key] = cur
        return events

    def get_unusual(self, limit: int = 100) -> list[dict]:
        with _lock:
            return list(self.unusual)[:limit]

    def hot_greeks(self, symbol: str, expiry: str) -> list[dict]:
        now = time.time()
        with _lock:
            return [
                {
                    "strike": e["strike"],
                    "optionType": e["optionType"],
                    "kind": e["kind"],
                    "ts": e["ts"],
                }
                for e in self.unusual
                if e["symbol"] == symbol
                and e["expiry"] == expiry
                and now - e["ts"] < GREEK_EVENT_TTL
            ]

    def seed_spot_history(self, symbol: str, pairs: list) -> int:
        """Merge spot-only [ms, value] points (e.g. NSE intraday backfill) into history.

        Adds a point only where no sample already exists within 20s, keeps the
        deque time-sorted. Returns how many points were added.
        """
        symbol = symbol.upper()
        with _lock:
            dq = self.history.setdefault(symbol, deque(maxlen=HISTORY_MAXLEN))
            existing = sorted(h["t"] for h in dq)
            added = 0
            merged = list(dq)
            for p in pairs:
                try:
                    t = float(p[0]) / 1000.0
                    v = float(p[1])
                except (TypeError, ValueError, IndexError):
                    continue
                if any(abs(t - e) < 20 for e in existing):
                    continue
                merged.append(
                    {
                        "t": t, "spot": v, "atmIV": None, "atmStraddle": None,
                        "atmGammaOI": None, "pcr": None, "netGex": None,
                        "maxPain": None, "dte": None, "ceOIChg": 0, "peOIChg": 0,
                    }
                )
                existing.append(t)
                added += 1
            merged.sort(key=lambda h: h["t"])
            self.history[symbol] = deque(merged[-HISTORY_MAXLEN:], maxlen=HISTORY_MAXLEN)
            if added:
                self._persist_history(symbol)
            return added

    def get_history(self, symbol: str) -> list[dict]:
        with _lock:
            return list(self.history.get(symbol.upper(), []))

    def get_scan_history(self, symbol: str) -> list[dict]:
        with _lock:
            return list(self.scan_history.get(symbol.upper(), []))

    def _record_opt_history(self, symbol: str, expiry: str, chain: dict, now: float) -> None:
        """Sample LTP for any watchlisted option contract on this (symbol, expiry)."""
        wanted: set[tuple] = set()
        for lst in self.watchlists["lists"]:
            for e in lst["symbols"]:
                opt = self._parse_opt(e)
                if opt and opt[0] == symbol and opt[1] == expiry:
                    wanted.add((opt[2], opt[3], e))
        if not wanted:
            return
        by_strike = {r["strike"]: r for r in chain["rows"]}
        for strike, ot, key in wanted:
            row = by_strike.get(strike)
            if not row:
                continue
            leg = row["call"] if ot == "CE" else row["put"]
            dq = self.opt_history.setdefault(key, deque(maxlen=HISTORY_MAXLEN))
            dq.append({"t": now, "ltp": leg["ltp"] or 0.0})

    def get_opt_history(self, key: str) -> list[dict]:
        with _lock:
            return list(self.opt_history.get(key, []))

    # ---- order mode --------------------------------------------
    def order_mode(self) -> str:
        return self.settings.get("orderMode", "paper")

    def set_order_mode(self, mode: str) -> str:
        with _lock:
            self.settings["orderMode"] = "live" if mode == "live" else "paper"
            _save(_SETTINGS_FILE, self.settings)
        return self.settings["orderMode"]

    # ---- market-data source ----------------------------------------
    def data_source(self) -> str:
        # app-set value wins; falls back to the DATA_SOURCE env default
        from .config import DATA_SOURCE

        return self.settings.get("dataSource", DATA_SOURCE)

    def set_data_source(self, src: str) -> str:
        with _lock:
            self.settings["dataSource"] = "upstox" if src == "upstox" else "nse"
            _save(_SETTINGS_FILE, self.settings)
        return self.settings["dataSource"]

    def log_live_order(self, rec: dict) -> None:
        with _lock:
            self.live_orders.appendleft({**rec, "ts": time.time()})

    def get_live_orders(self) -> list[dict]:
        with _lock:
            return list(self.live_orders)

    # ---- index quotes + symbol catalog --------------------------
    def set_indices(self, rows: list[dict]) -> None:
        now = time.time()
        with _lock:
            cat = []
            for r in rows:
                name = r.get("indexSymbol") or r.get("index")
                if not name:
                    continue
                self.index_quotes[name] = {
                    "last": r.get("last"),
                    "pChange": r.get("percentChange"),
                    "variation": r.get("variation"),
                    "ts": now,
                }
                cat.append(
                    {"symbol": name, "name": r.get("index") or name, "category": r.get("key") or ""}
                )
            if cat:
                self.index_catalog = cat

    def index_quote(self, name: str) -> dict | None:
        with _lock:
            return self.index_quotes.get(name)

    def search_symbols(self, q: str, limit: int = 25) -> list[dict]:
        from .config import FO_UNIVERSE, INDEX_SYMBOLS

        ql = (q or "").strip().upper()
        out: list[dict] = []
        seen: set[str] = set()

        # F&O optionable symbols (indices + stocks)
        for sym in FO_UNIVERSE:
            if ql in sym and sym not in seen:
                seen.add(sym)
                out.append(
                    {"label": sym, "add": sym, "kind": "index" if sym in INDEX_SYMBOLS else "stock",
                     "optionable": True}
                )

        # every NSE index (spot only) — incl. INDIA VIX
        with _lock:
            cat = list(self.index_catalog)
        for c in cat:
            name = c["symbol"]
            key = f"IDX:{name}"
            if key in seen:
                continue
            if ql in name.upper() or ql in (c["name"] or "").upper():
                seen.add(key)
                out.append(
                    {"label": name, "add": key, "kind": "vix" if "VIX" in name.upper() else "index",
                     "optionable": False, "category": c["category"]}
                )
            if len(out) >= limit * 2:
                break

        # optionable first, then shortest label
        out.sort(key=lambda r: (not r["optionable"], len(r["label"])))
        return out[:limit]

    # ---- live broker feed ---------------------------------------
    def set_live_spot(self, symbol: str, ltp: float, chg_pct: float | None = None) -> None:
        with _lock:
            self.live_spot[symbol.upper()] = {
                "ltp": round(ltp, 2),
                "chgPct": round(chg_pct, 2) if chg_pct is not None else None,
                "ts": time.time(),
            }

    def get_live_spot(self, symbol: str) -> dict | None:
        with _lock:
            return self.live_spot.get(symbol.upper())

    # ---- cross-symbol screener ------------------------------------
    def session_open(self, symbol: str, spot: float) -> float:
        from datetime import datetime
        from zoneinfo import ZoneInfo

        today = datetime.now(ZoneInfo("Asia/Kolkata")).strftime("%Y-%m-%d")
        with _lock:
            ref = self.session_ref.get(symbol.upper())
            if not ref or ref[0] != today:
                self.session_ref[symbol.upper()] = (today, spot)
                return spot
            return ref[1]

    def push_iv(self, symbol: str, atm_iv: float | None) -> list[float]:
        symbol = symbol.upper()
        with _lock:
            dq = self.iv_history.setdefault(
                symbol, deque(maxlen=SCREENER_IV_HISTORY_MAXLEN)
            )
            if atm_iv:
                dq.append(atm_iv)
            return list(dq)

    def set_universe_row(self, symbol: str, row: dict) -> None:
        with _lock:
            self.universe[symbol.upper()] = row

    def get_universe(self) -> list[dict]:
        with _lock:
            return list(self.universe.values())

    def set_universe_progress(self, **kw) -> None:
        with _lock:
            self.universe_progress.update(kw)

    # ---- scanner + alerts -------------------------------------------
    def set_scan(self, symbol: str, row: dict) -> None:
        symbol = symbol.upper()
        with _lock:
            self.scan_results[symbol] = row
            dq = self.scan_history.setdefault(symbol, deque(maxlen=HISTORY_MAXLEN))
            if not dq or row["ts"] - dq[-1]["t"] >= 5:
                dq.append({"t": row["ts"], "score": row["score"], "bias": row["bias"]})

    def get_scan(self) -> list[dict]:
        with _lock:
            return sorted(
                self.scan_results.values(),
                key=lambda r: r.get("score", 0),
                reverse=True,
            )

    def add_alert(self, alert: dict) -> None:
        with _lock:
            self.alerts.appendleft(alert)

    def get_alerts(self, limit: int = 100) -> list[dict]:
        with _lock:
            return list(self.alerts)[:limit]

    def recent_alert(self, symbol: str, kind: str, within: float) -> bool:
        now = time.time()
        with _lock:
            return any(
                a["symbol"] == symbol and a["kind"] == kind and now - a["ts"] < within
                for a in self.alerts
            )

    # ---- watchlists (5 named lists) --------------------------------
    def _load_watchlists(self) -> dict:
        data = _load(_WATCHLISTS_FILE, None)
        if isinstance(data, dict) and isinstance(data.get("lists"), list) and data["lists"]:
            lists = [
                {"name": str(l.get("name") or f"List {i + 1}"), "symbols": list(l.get("symbols") or [])}
                for i, l in enumerate(data["lists"][:_WL_MAX])
            ]
        else:
            legacy = _load(_WATCHLIST_FILE, list(DEFAULT_SYMBOLS))
            lists = [{"name": "List 1", "symbols": list(legacy)}]
        # trim trailing empty lists beyond the default count
        while len(lists) > _WL_DEFAULT and not lists[-1]["symbols"]:
            lists.pop()
        while len(lists) < _WL_DEFAULT:
            lists.append({"name": f"List {len(lists) + 1}", "symbols": []})
        active = min(max(int((data or {}).get("active", 0)), 0), len(lists) - 1)
        hidden = [s for s in (data or {}).get("hiddenDefaults", []) if s in DEFAULT_SYMBOLS]
        return {"lists": lists, "active": active, "hiddenDefaults": hidden}

    def _save_watchlists(self) -> None:
        _save(_WATCHLISTS_FILE, self.watchlists)

    def _wli(self, index) -> int:
        return min(max(int(index), 0), len(self.watchlists["lists"]) - 1)

    def add_wl(self) -> dict:
        with _lock:
            if len(self.watchlists["lists"]) < _WL_MAX:
                n = len(self.watchlists["lists"]) + 1
                self.watchlists["lists"].append({"name": f"List {n}", "symbols": []})
                self.watchlists["active"] = len(self.watchlists["lists"]) - 1
                self._save_watchlists()
            return self.get_watchlists()

    def delete_wl(self, index: int) -> dict:
        with _lock:
            if len(self.watchlists["lists"]) <= 1:
                return self.get_watchlists()
            i = self._wli(index)
            self.watchlists["lists"].pop(i)
            self.watchlists["active"] = min(self.watchlists["active"], len(self.watchlists["lists"]) - 1)
            self._save_watchlists()
            return self.get_watchlists()

    @property
    def watchlist(self) -> list[str]:
        return list(self.watchlists["lists"][self.watchlists["active"]]["symbols"])

    def get_watchlists(self) -> dict:
        with _lock:
            return {
                "active": self.watchlists["active"],
                "lists": [dict(l) for l in self.watchlists["lists"]],
                "hiddenDefaults": list(self.watchlists.get("hiddenDefaults", [])),
            }

    def set_active_wl(self, index: int) -> dict:
        with _lock:
            self.watchlists["active"] = self._wli(index)
            self._save_watchlists()
            return self.get_watchlists()

    def clear_wl(self, index: int, options_only: bool = False) -> dict:
        with _lock:
            i = self._wli(index)
            if options_only:
                self.watchlists["lists"][i]["symbols"] = [
                    s for s in self.watchlists["lists"][i]["symbols"] if "|" not in s
                ]
            else:
                self.watchlists["lists"][i]["symbols"] = []
            self._save_watchlists()
            return self.get_watchlists()

    def rename_wl(self, index: int, name: str) -> dict:
        with _lock:
            i = self._wli(index)
            self.watchlists["lists"][i]["name"] = (name or f"List {i + 1}")[:24]
            self._save_watchlists()
            return self.get_watchlists()

    def add_watch(self, symbol: str, index: int | None = None) -> list[str]:
        symbol = symbol.upper().strip()
        with _lock:
            i = self.watchlists["active"] if index is None else self._wli(index)
            syms = self.watchlists["lists"][i]["symbols"]
            hidden = self.watchlists.setdefault("hiddenDefaults", [])
            # re-adding a hidden default just un-hides it (it re-appears from DEFAULT_SYMBOLS)
            if symbol in hidden:
                hidden.remove(symbol)
                self._save_watchlists()
                return list(syms)
            if symbol and symbol not in syms:
                syms.append(symbol)
                self._save_watchlists()
            return list(syms)

    def remove_watch(self, symbol: str, index: int | None = None) -> list[str]:
        symbol = symbol.upper().strip()
        with _lock:
            i = self.watchlists["active"] if index is None else self._wli(index)
            lst = self.watchlists["lists"][i]
            lst["symbols"] = [s for s in lst["symbols"] if s != symbol]
            # a default index row lives in DEFAULT_SYMBOLS, not in any list — hide it so it stays gone
            hidden = self.watchlists.setdefault("hiddenDefaults", [])
            if symbol in DEFAULT_SYMBOLS and symbol not in hidden:
                hidden.append(symbol)
            self._save_watchlists()
            return list(lst["symbols"])

    @staticmethod
    def _parse_opt(entry: str):
        """'NIFTY|08-Sep-2026|23900|CE' -> (symbol, expiry, strike, ot) or None."""
        if "|" not in entry:
            return None
        parts = entry.split("|")
        if len(parts) != 4:
            return None
        sym, exp, strike, ot = parts
        try:
            return sym.upper(), exp, float(strike), ot.upper()
        except ValueError:
            return None

    def watch_quotes(self) -> list[dict]:
        with _lock:
            hidden = set(self.watchlists.get("hiddenDefaults", []))
            defaults = [s for s in DEFAULT_SYMBOLS if s not in hidden]
            entries = list(dict.fromkeys(defaults + self.watchlist))
        out = []
        for entry in entries:
            if entry.startswith("IDX:"):
                name = entry[4:]
                q = self.index_quotes.get(name)
                out.append(
                    {
                        "key": entry,
                        "kind": "index",
                        "symbol": name,
                        "spot": q.get("last") if q else None,
                        "liveChgPct": q.get("pChange") if q else None,
                        "variation": q.get("variation") if q else None,
                        "optionable": False,
                        "error": None if q else "no quote",
                    }
                )
                continue
            opt = self._parse_opt(entry)
            if opt:
                sym, exp, strike, ot = opt
                chain = self.get_chain(sym, exp)
                leg = None
                if chain:
                    for r in chain["rows"]:
                        if r["strike"] == strike:
                            leg = r["call"] if ot == "CE" else r["put"]
                            break
                if leg:
                    out.append(
                        {
                            "key": entry,
                            "kind": "option",
                            "symbol": sym,
                            "expiry": chain["expiry"],
                            "strike": strike,
                            "optionType": ot,
                            "ltp": leg["ltp"],
                            "chg": leg["chg"],
                            "chgPct": leg["chgPct"],
                            "iv": leg["ivCalc"] or leg["iv"],
                            "oi": leg["oi"],
                            "oiChg": leg["oiChg"],
                            "delta": leg["delta"],
                            "gamma": leg["gamma"],
                            "underlyingSpot": chain["spot"],
                            "atmStrike": chain["atmStrike"],
                            "lotSize": chain["lotSize"],
                            "fetchedAt": chain.get("fetchedAt"),
                        }
                    )
                else:
                    out.append(
                        {"key": entry, "kind": "option", "symbol": sym, "strike": strike,
                         "optionType": ot, "error": "loading"}
                    )
                continue

            sym = entry
            chain = self.get_chain(sym)
            if chain:
                live = self.live_spot.get(sym)
                out.append(
                    {
                        "key": sym,
                        "kind": "symbol",
                        "symbol": sym,
                        "spot": chain["spot"],
                        "liveSpot": live["ltp"] if live else None,
                        "liveChgPct": live["chgPct"] if live else None,
                        "atmIV": chain["atmIV"],
                        "atmStrike": chain["atmStrike"],
                        "pcr": chain["pcr"],
                        "dte": chain["dte"],
                        "expiry": chain["expiry"],
                        "lotSize": chain["lotSize"],
                        "fetchedAt": chain.get("fetchedAt"),
                    }
                )
            else:
                out.append(
                    {"key": sym, "kind": "symbol", "symbol": sym, "spot": None,
                     "error": self.errors.get(sym, "loading")}
                )
        return out

    def add_strikes(self, index: int, symbol: str, expiry: str, count: int, sides: list[str]) -> list[str]:
        """Add option-contract keys for `count` strikes centred on ATM."""
        chain = self.get_chain(symbol, expiry)
        if not chain:
            return []
        rows = chain["rows"]
        atm_i = next((i for i, r in enumerate(rows) if r["strike"] == chain["atmStrike"]), len(rows) // 2)
        lo = max(0, atm_i - count // 2)
        picked = rows[lo : lo + count]
        keys = [
            f"{symbol.upper()}|{chain['expiry']}|{int(r['strike'])}|{s}"
            for r in picked
            for s in sides
        ]
        with _lock:
            i = self._wli(index)
            syms = self.watchlists["lists"][i]["symbols"]
            for k in keys:
                if k not in syms:
                    syms.append(k)
            self._save_watchlists()
            return list(syms)

    # ---- paper trading -----------------------------------------------
    def _mark_price(self, symbol: str, expiry: str, strike: float, ot: str) -> Optional[float]:
        chain = self.get_chain(symbol, expiry)
        if not chain:
            return None
        for r in chain["rows"]:
            if r["strike"] == strike:
                leg = r["call"] if ot == "CE" else r["put"]
                return leg["ltp"] or None
        return None

    def place_paper_order(self, o) -> dict:
        with _lock:
            price = o.price
            if price is None:
                price = self._mark_price(o.symbol, o.expiry, o.strike, o.option_type)
            price = float(price or 0.0)
            ls = lot_size(o.symbol)
            qty = o.qty_lots * ls
            order = {
                "id": uuid.uuid4().hex[:10],
                "ts": time.time(),
                "symbol": o.symbol.upper(),
                "expiry": o.expiry,
                "strike": o.strike,
                "optionType": o.option_type,
                "side": o.side,
                "qtyLots": o.qty_lots,
                "lotSize": ls,
                "qty": qty,
                "price": price,
                "note": o.note,
            }
            self.paper["orders"].insert(0, order)
            self._apply_fill(order)
            _save(_PAPER_FILE, self.paper)
            return order

    def _apply_fill(self, order: dict) -> None:
        signed = order["qty"] if order["side"] == "BUY" else -order["qty"]
        for pos in self.paper["positions"]:
            if (
                pos["symbol"] == order["symbol"]
                and pos["expiry"] == order["expiry"]
                and pos["strike"] == order["strike"]
                and pos["optionType"] == order["optionType"]
            ):
                new_qty = pos["qty"] + signed
                if pos["qty"] * signed >= 0:
                    total_cost = pos["avgPrice"] * abs(pos["qty"]) + order["price"] * order["qty"]
                    pos["avgPrice"] = total_cost / max(abs(new_qty), 1)
                else:
                    closed = min(abs(pos["qty"]), order["qty"])
                    direction = 1 if pos["qty"] > 0 else -1
                    self.paper["realized"] += direction * (order["price"] - pos["avgPrice"]) * closed
                    if new_qty * direction < 0:
                        pos["avgPrice"] = order["price"]
                pos["qty"] = new_qty
                if pos["qty"] == 0:
                    self.paper["positions"].remove(pos)
                return
        self.paper["positions"].append(
            {
                "id": uuid.uuid4().hex[:10],
                "symbol": order["symbol"],
                "expiry": order["expiry"],
                "strike": order["strike"],
                "optionType": order["optionType"],
                "qty": signed,
                "lotSize": order["lotSize"],
                "avgPrice": order["price"],
                "openedTs": order["ts"],
            }
        )

    def paper_state(self) -> dict:
        with _lock:
            positions = []
            unrealized = 0.0
            margin_used = 0.0
            for pos in self.paper["positions"]:
                ltp = self._mark_price(
                    pos["symbol"], pos["expiry"], pos["strike"], pos["optionType"]
                )
                ltp = ltp if ltp is not None else pos["avgPrice"]
                pnl = (ltp - pos["avgPrice"]) * pos["qty"]
                unrealized += pnl
                # blocked margin: long = premium paid, short = ~SPAN+exposure on strike notional
                if pos["qty"] >= 0:
                    margin_used += pos["avgPrice"] * pos["qty"]
                else:
                    margin_used += SHORT_OPTION_MARGIN_PCT * pos["strike"] * abs(pos["qty"])
                positions.append({**pos, "ltp": round(ltp, 2), "pnl": round(pnl, 2)})
            realized = self.paper["realized"]
            available = PAPER_CAPITAL + realized - margin_used

            # realized P&L booked so far *today* (IST) -- anchored once per calendar
            # day against the cumulative realized figure, so today's P&L = today's
            # closes + whatever is still open, separate from the all-time total.
            from datetime import datetime as _dt
            from zoneinfo import ZoneInfo as _ZI

            today = _dt.now(_ZI("Asia/Kolkata")).strftime("%Y-%m-%d")
            anchor = self.paper.get("dayAnchor")
            if not anchor or anchor.get("date") != today:
                anchor = {"date": today, "realized": realized}
                self.paper["dayAnchor"] = anchor
                _save(_PAPER_FILE, self.paper)
            today_realized = realized - anchor["realized"]
            today_pnl = today_realized + unrealized

            return {
                "positions": positions,
                "orders": self.paper["orders"][:100],
                "realized": round(realized, 2),
                "unrealized": round(unrealized, 2),
                "total": round(realized + unrealized, 2),
                "todayRealized": round(today_realized, 2),
                "todayPnl": round(today_pnl, 2),
                "capital": round(PAPER_CAPITAL, 2),
                "marginUsed": round(margin_used, 2),
                "marginAvailable": round(available, 2),
                "equity": round(PAPER_CAPITAL + realized + unrealized, 2),
            }

    def close_paper(self, position_id: str, price: float | None = None) -> dict:
        with _lock:
            pos = next(
                (p for p in self.paper["positions"] if p["id"] == position_id), None
            )
        if not pos:
            return self.paper_state()
        from .models import PaperOrderIn

        self.place_paper_order(
            PaperOrderIn(
                symbol=pos["symbol"],
                expiry=pos["expiry"],
                strike=pos["strike"],
                option_type=pos["optionType"],
                side="SELL" if pos["qty"] > 0 else "BUY",
                qty_lots=max(abs(pos["qty"]) // pos["lotSize"], 1),
                price=price,
                note="close",
            )
        )
        return self.paper_state()

    # ---- stop-loss / trailing stop --------------------------------
    @staticmethod
    def _stop_from(pos: dict, mode: str, value: float) -> float:
        """Stop LTP for a position given mode ('points' | 'amount') and value."""
        qty = abs(pos["qty"]) or 1
        offset = value if mode == "points" else value / qty
        return pos["avgPrice"] - offset if pos["qty"] > 0 else pos["avgPrice"] + offset

    @staticmethod
    def _target_from(pos: dict, mode: str, value: float) -> float:
        """Take-profit LTP — the mirror of _stop_from."""
        qty = abs(pos["qty"]) or 1
        offset = value if mode == "points" else value / qty
        return pos["avgPrice"] + offset if pos["qty"] > 0 else pos["avgPrice"] - offset

    def set_stop(
        self,
        position_id: str,
        mode: str,
        value: float,
        trail_value: float,
        target_value: float = 0.0,
    ) -> dict:
        with _lock:
            pos = next(
                (p for p in self.paper["positions"] if p["id"] == position_id), None
            )
            if not pos:
                return self.paper_state()
            ltp = self._mark_price(
                pos["symbol"], pos["expiry"], pos["strike"], pos["optionType"]
            ) or pos["avgPrice"]
            mode = "amount" if mode == "amount" else "points"
            value = float(value or 0.0)
            target_value = max(0.0, float(target_value or 0.0))
            pos["sl"] = {
                "mode": mode,
                "value": value,
                "trailValue": max(0.0, float(trail_value or 0.0)),
                "targetValue": target_value,
                "stopPrice": round(self._stop_from(pos, mode, value), 2) if value > 0 else None,
                "targetPrice": (
                    round(self._target_from(pos, mode, target_value), 2)
                    if target_value > 0
                    else None
                ),
                "peak": ltp,
                "createdTs": time.time(),
            }
            _save(_PAPER_FILE, self.paper)
            return self.paper_state()

    def clear_stop(self, position_id: str) -> dict:
        with _lock:
            for p in self.paper["positions"]:
                if p["id"] == position_id:
                    p.pop("sl", None)
            _save(_PAPER_FILE, self.paper)
            return self.paper_state()

    def check_stops(self) -> list[dict]:
        """Ratchet trailing stops and auto-close positions whose stop is hit."""
        hits: list[dict] = []
        with _lock:
            for pos in list(self.paper["positions"]):
                sl = pos.get("sl")
                if not sl:
                    continue
                ltp = self._mark_price(
                    pos["symbol"], pos["expiry"], pos["strike"], pos["optionType"]
                )
                if ltp is None:
                    continue
                long = pos["qty"] > 0
                qty = abs(pos["qty"]) or 1
                has_sl = sl.get("stopPrice") is not None
                tgt_px = sl.get("targetPrice")

                if has_sl and sl["trailValue"] > 0:
                    step = sl["trailValue"] if sl["mode"] == "points" else sl["trailValue"] / qty
                    if long and ltp > sl["peak"]:
                        sl["peak"] = ltp
                        sl["stopPrice"] = max(sl["stopPrice"], round(ltp - step, 2))
                    elif not long and ltp < sl["peak"]:
                        sl["peak"] = ltp
                        sl["stopPrice"] = min(sl["stopPrice"], round(ltp + step, 2))

                stop_hit = has_sl and (
                    (long and ltp <= sl["stopPrice"]) or (not long and ltp >= sl["stopPrice"])
                )
                tgt_hit = tgt_px is not None and (
                    (long and ltp >= tgt_px) or (not long and ltp <= tgt_px)
                )
                if not (stop_hit or tgt_hit):
                    continue
                pnl = round((ltp - pos["avgPrice"]) * pos["qty"], 0)
                trailed = has_sl and sl["trailValue"] > 0
                stop_px = tgt_px if tgt_hit else sl.get("stopPrice")
                self.close_paper(pos["id"], price=ltp)
                hits.append(
                    {
                        "ts": time.time(),
                        "symbol": pos["symbol"],
                        "strike": pos["strike"],
                        "optionType": pos["optionType"],
                        "kind": "TARGET_HIT" if tgt_hit else "SL_HIT",
                        "trailed": trailed,
                        "stopPrice": stop_px,
                        "ltp": round(ltp, 2),
                        "pnl": pnl,
                        "message": (
                            f"{pos['symbol']} {pos['strike']:.0f}{pos['optionType']} "
                            + (
                                f"target hit @ {ltp:.2f} (target {stop_px:.2f}, P&L ₹{pnl:.0f})"
                                if tgt_hit
                                else f"{'trailing ' if trailed else ''}stop hit @ {ltp:.2f} "
                                f"(stop {stop_px:.2f}, P&L ₹{pnl:.0f})"
                            )
                        ),
                    }
                )
        return hits


store = Store()
