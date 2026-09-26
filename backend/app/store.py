"""In-memory state + tiny JSON persistence for watchlist and paper trades.

Raw NSE snapshots are keyed by (symbol, expiry) because the v3 API is per-expiry.
"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from collections import deque
from typing import Optional

from .config import (
    DATA_DIR,
    DEFAULT_SYMBOLS,
    GREEK_BASELINE_MAX_AGE_S,
    GREEK_BIG_DELTA,
    GREEK_BIG_GAMMA_X,
    GREEK_DELTA_JUMP,
    GREEK_EVENT_TTL,
    GREEK_GAMMA_JUMP_PCT,
    GREEK_NEAR_ATM_STRIKES,
    HISTORY_MAXLEN,
    PAPER_CAPITAL,
    SHORT_OPTION_MARGIN_PCT,
    SCREENER_IV_HISTORY_MAXLEN,
)
from . import db, history_archive, oi_walls
from .users import current_user
from .processing import build_chain, lot_size

_WATCHLIST_FILE = DATA_DIR / "watchlist.json"  # legacy pre-multi-list schema; read-only upgrade path
_WL_DEFAULT = 3
_WL_MAX = 8
_HIST_DIR = DATA_DIR / "history"
_HIST_DIR.mkdir(parents=True, exist_ok=True)
_JOURNAL_MAXLEN = 5000
_lock = threading.RLock()


def _load(path, fallback):
    try:
        return json.loads(path.read_text("utf-8"))
    except (FileNotFoundError, ValueError):
        return fallback


def _save(path, obj):
    path.write_text(json.dumps(obj, indent=2, default=str), "utf-8")


def _fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


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
        self._prev_greeks_ts: dict[tuple, float] = {}  # (symbol,expiry) -> when that baseline was taken
        self.universe: dict[str, dict] = {}            # symbol -> screener row
        self.iv_history: dict[str, deque] = {}         # symbol -> deque[atmIV]
        self.session_ref: dict[str, tuple] = {}        # symbol -> (date, open spot)
        self.universe_progress: dict = {
            "scanned": 0, "total": 0, "cycleStart": None, "lastFull": None, "current": None,
        }
        self.live_spot: dict[str, dict] = {}          # symbol -> {ltp, chgPct, ts}
        self.live_futures: dict[str, dict] = {}       # "SYMBOL|EXPIRY" -> {ltp, chgPct, ts}
        self.tick_ohlc: dict[str, deque] = {}         # symbol -> deque[{t,o,h,l,c}] @ _TICK_BUCKET_S
        self.index_quotes: dict[str, dict] = {}       # NSE index name -> {last, pChange, ts}
        self.index_catalog: list[dict] = []           # [{symbol, name, category}]
        self.opt_history: dict[str, deque] = {}       # option key -> deque[{t, ltp}]
        self.oi_series: dict[tuple, deque] = {}       # (symbol,expiry) -> deque[{t, oi:{strike:(ceOi,peOi)}}]
        self._hist_writes = 0
        self._load_history()
        self._load_iv_history()
        self._iv_hist_last_save = 0.0
        self._user_wls: dict[str, dict] = {}         # view-only users' watchlists, by user id
        self.watchlists: dict = self._load_watchlists()
        self._user_papers: dict[str, dict] = {}      # view-only users' paper books, by user id
        self.paper: dict = db.get_kv("paper") or {"positions": [], "orders": [], "realized": 0.0}
        self.journal: deque = deque(
            db.load_rows("journal", order="DESC")[:_JOURNAL_MAXLEN], maxlen=_JOURNAL_MAXLEN
        )
        self.settings: dict = db.get_kv("settings") or {"orderMode": "paper"}
        self.live_orders: deque = deque(maxlen=100)  # log of routed live orders
        self.broker_positions: list[dict] = []       # last raw PositionBook snapshot
        self.broker_positions_ts: float = 0.0
        self.leg_ltp: dict[str, dict] = {}           # feed token -> {ltp, ts} for open legs

    # ---- symbol / expiry helpers ------------------------------------------
    def all_symbols(self, extra: Optional[set[str]] = None) -> list[str]:
        with _lock:
            every = set(DEFAULT_SYMBOLS)
            # the owner's lists and every viewer's that has been loaded
            for wl in [self._owner_wl, *self._user_wls.values()]:
                for l in wl["lists"]:
                    for e in l["symbols"]:
                        if e.startswith("IDX:"):
                            continue
                        every.add(e.split("|")[0].upper() if "|" in e else e)
            return sorted(every | (extra or set()))

    def set_expiries(self, symbol: str, expiries: list[str]) -> None:
        from .processing import future_expiries

        expiries = future_expiries(expiries)
        with _lock:
            if expiries:
                self.expiries[symbol.upper()] = expiries
                self.errors.pop(symbol.upper(), None)

    def nearest_expiry(self, symbol: str) -> Optional[str]:
        exps = self.expiries.get(symbol.upper())
        return exps[0] if exps else None

    def resolve_expiry(self, symbol: str, expiry: Optional[str]) -> Optional[str]:
        from .processing import is_expired

        exps = self.expiries.get(symbol.upper()) or []
        if expiry and is_expired(expiry):
            expiry = None  # requested expiry has already passed
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
                from .processing import future_expiries

                self.expiries[symbol] = future_expiries(list(rec_exps))
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
        # the day's OI walls (biggest call / put strikes) -- kept on disk too
        oi_walls.record(symbol, expiry, snap, chain.get("spot"), now)

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
                try:
                    chain = build_chain(raw, symbol, exp)
                except Exception as exc:  # noqa: BLE001
                    # a malformed / wrong-exchange payload (e.g. an NSE reply
                    # cached for SENSEX) must not propagate — it was crashing
                    # the /ws handshake via watch_quotes() and forcing the
                    # client into a reconnect loop.
                    self.errors[symbol] = f"chain build failed: {exc}"
                    return None
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

    # ---- IV history (screener's IV Rank / Percentile) -----------------
    # A single small file for every symbol at once (unlike the per-symbol
    # OHLC history above, these deques are just floats and stay tiny even
    # for the whole F&O universe). Without this, iv_history was in-memory
    # only -- every backend restart silently reset every symbol's IV Rank
    # back to "collecting history" with zero samples.
    def _load_iv_history(self) -> None:
        doc = db.get_kv("iv_history") or {}
        for sym, vals in doc.items():
            if isinstance(vals, list) and vals:
                self.iv_history[sym.upper()] = deque(
                    vals[-SCREENER_IV_HISTORY_MAXLEN:], maxlen=SCREENER_IV_HISTORY_MAXLEN
                )

    def _persist_iv_history(self, *, force: bool = False) -> None:
        now = time.time()
        if not force and now - self._iv_hist_last_save < 30:
            return
        self._iv_hist_last_save = now
        db.set_kv("iv_history", {sym: list(dq) for sym, dq in self.iv_history.items()})

    def _record_history(self, symbol: str, expiry: str, now: float, chain: dict) -> None:
        if self.nearest_expiry(symbol) not in (None, expiry):
            return  # only track the front-month series
        dq = self.history.setdefault(symbol, deque(maxlen=HISTORY_MAXLEN))
        atm_row = next(
            (r for r in chain.get("rows", []) if r["strike"] == chain.get("atmStrike")), None
        )
        atm_ce_iv = atm_pe_iv = None
        atm_ce_dl = atm_pe_dl = atm_ce_ga = atm_pe_ga = None
        atm_ce_th = atm_pe_th = atm_ce_vg = atm_pe_vg = None
        if atm_row:
            atm_ce_iv = atm_row["call"].get("ivCalc") or atm_row["call"].get("iv")
            atm_pe_iv = atm_row["put"].get("ivCalc") or atm_row["put"].get("iv")
            atm_ce_dl = atm_row["call"].get("delta")
            atm_pe_dl = atm_row["put"].get("delta")
            atm_ce_ga = atm_row["call"].get("gamma")
            atm_pe_ga = atm_row["put"].get("gamma")
            atm_ce_th = atm_row["call"].get("theta")
            atm_pe_th = atm_row["put"].get("theta")
            atm_ce_vg = atm_row["call"].get("vega")
            atm_pe_vg = atm_row["put"].get("vega")
        dq.append(
            row := {
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
                "atmCETheta": atm_ce_th,
                "atmPETheta": atm_pe_th,
                "atmCEVega": atm_ce_vg,
                "atmPEVega": atm_pe_vg,
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
        history_archive.record(symbol, row)
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
        prev_ts = self._prev_greeks_ts.get(key, 0.0)
        # no comparison against a stale baseline (overnight, a feed gap -- the
        # whole chain "jumped" at every open), or with either reading outside
        # market hours (pre-open / after-close quotes flicker): the baseline
        # is still refreshed below, nothing is flagged
        if (
            now - prev_ts > GREEK_BASELINE_MAX_AGE_S
            or not history_archive.in_session(now)
            or not history_archive.in_session(prev_ts)
        ):
            prev = {}
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
                # a genuine previous reading of exactly (0, 0) is a stale/
                # missing-data placeholder (a feed gap), not a real quote --
                # treating "gap recovers to a real value" as a jump was the
                # single biggest source of false positives
                if pd == 0.0 and pg == 0.0:
                    continue
                dd = d - pd
                dg = g - pg
                rel_g = abs(dg) / max(abs(pg), 1e-6)
                kind = None
                # deep ITM/OTM strikes sit near delta 0 or 1 with naturally
                # near-zero gamma -- both the delta-jump and gamma-spike/
                # collapse floors below require *meaningful* gamma on both
                # sides of the move, not just "not literally zero", so a
                # strike oscillating between two negligible gamma values
                # (e.g. 0.0002 -> 0.0000, a real move but an irrelevant one)
                # no longer qualifies as "unusual"
                if abs(dd) >= GREEK_DELTA_JUMP and abs(g) > 3e-4 and abs(pg) > 3e-4:
                    # (the previous side too: delta exactly 1.00 with gamma
                    # 0.0000 is the pricer's no-quote fallback, and its next
                    # real reading looked like a big jump)
                    kind = "DELTA_JUMP"
                elif rel_g >= GREEK_GAMMA_JUMP_PCT and abs(pg) > 3e-4 and abs(g) > 3e-4:
                    kind = "GAMMA_SPIKE" if dg > 0 else "GAMMA_COLLAPSE"
                # 150s meant the same strike could re-fire every ~2.5 min if
                # it kept drifting past the threshold; 900s (15 min) keeps
                # the feed to one alert per strike per genuine move instead
                # of a running commentary on it
                if not kind or self._recent_unusual(symbol, r["strike"], ot, 900):
                    continue
                # "very big": near the money and a quarter-delta / 2.5x gamma move
                ratio = max(abs(g), abs(pg)) / max(min(abs(g), abs(pg)), 1e-9)
                near = any(0.2 <= abs(x) <= 0.8 for x in (d, pd))
                big = near and (abs(dd) >= GREEK_BIG_DELTA or ratio >= GREEK_BIG_GAMMA_X)
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
                    "severity": "critical" if big else "warning",
                    "big": big,
                    "size": round(max(abs(dd) / GREEK_BIG_DELTA, ratio / GREEK_BIG_GAMMA_X), 2),
                    "message": (
                        f"{symbol} {r['strike']:.0f}{ot} {label}: "
                        f"Δ {pd:+.2f}→{d:+.2f} ({dd:+.2f}), Γ {pg:.4f}→{g:.4f}"
                    ),
                }
                events.append(ev)
                self.unusual.appendleft(ev)

        self._prev_greeks[key] = cur
        self._prev_greeks_ts[key] = now
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
            db.set_kv("settings", self.settings)
        return self.settings["orderMode"]

    # ---- market-data source ----------------------------------------
    def data_source(self) -> str:
        # app-set value wins; falls back to the DATA_SOURCE env default
        from .config import DATA_SOURCE

        return self.settings.get("dataSource", DATA_SOURCE)

    def set_data_source(self, src: str) -> str:
        with _lock:
            self.settings["dataSource"] = "upstox" if src == "upstox" else "nse"
            db.set_kv("settings", self.settings)
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

    # "23400 CE", "23400ce", "NIFTY 23400 PE", "nifty 29sep 23400 ce", "23400"
    _OPT_Q = re.compile(
        r"^(?:([A-Z][A-Z&-]*?)\s*)?(?:(\d{1,2})\s*([A-Z]{3})\s+)?(\d{2,6}(?:\.\d+)?)\s*(CE|PE|CALL|PUT|C|P)?$"
    )

    def search_options(self, q: str, hint: str | None = None, limit: int = 12) -> list[dict]:
        """Option contracts for a strike-looking query, from the chains the app
        already has: every underlying whose chain carries that strike, the next
        three expiries, CE and/or PE. `hint` (the symbol on screen) comes first.
        The `add` key is the same "SYM|DD-Mon-YYYY|STRIKE|OT" the strike tools
        build, so the row prices like any other."""
        ql = re.sub(r"\s+", " ", (q or "").strip().upper())
        m = self._OPT_Q.match(ql)
        if not m:
            return []
        sym, day, mon, strike_s, ot = m.groups()
        strike = float(strike_s)
        if strike <= 0:
            return []
        ots = ["CE", "PE"] if not ot else (["CE"] if ot in ("CE", "CALL", "C") else ["PE"])
        with _lock:
            exp_map = {s: list(v) for s, v in self.expiries.items()}
        if sym:
            cands = [s for s in exp_map if s == sym] or [s for s in exp_map if s.startswith(sym)]
        else:
            h = (hint or "").upper()
            cands = ([h] if h in exp_map else []) + sorted(s for s in exp_map if s != h)
        out: list[dict] = []
        for s in cands:
            exps = exp_map.get(s) or []
            if day and mon:
                exps = [e for e in exps if e.upper().startswith(f"{int(day):02d}-{mon}")]
            # an expiry whose chain isn't loaded yet (the poller picks it up once
            # the contract is in a list) is trusted to share the nearest one's strikes
            base = self.get_chain(s, exp_map[s][0]) if exp_map.get(s) else None
            base_has = bool(base) and any(r["strike"] == strike for r in base["rows"])
            for e in exps[:3]:
                chain = self.get_chain(s, e)
                has = any(r["strike"] == strike for r in chain["rows"]) if chain else base_has
                if not has:
                    continue
                k = int(strike) if strike.is_integer() else strike
                for o in ots:
                    out.append({
                        "label": f"{s} {e[:2]} {e[3:6].upper()} {k} {o}",
                        "add": f"{s}|{e}|{k}|{o}",
                        "kind": "option",
                        "optionable": False,
                    })
            if len(out) >= limit:
                break
        return out[:limit]

    def search_symbols(self, q: str, limit: int = 25, hint: str | None = None) -> list[dict]:
        from .config import FO_UNIVERSE, INDEX_SYMBOLS

        ql = (q or "").strip().upper()
        # a strike-looking query ("23400 CE") lists option contracts first
        opts = self.search_options(q, hint)
        out: list[dict] = list(opts)
        seen: set[str] = {r["add"] for r in opts}

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

        # option contracts first (in the order found -- the on-screen symbol
        # leads), then optionable symbols, then shortest label
        out.sort(key=lambda r: (r.get("kind") != "option", 0 if r.get("kind") == "option" else (not r["optionable"], len(r["label"]))))
        return out[:limit]

    # ---- live broker feed ---------------------------------------
    _TICK_BUCKET_S = 5                       # base OHLC bucket for tick candles
    _TICK_OHLC_MAXLEN = 2600                 # ~3.6h of 5s bars

    def set_live_spot(self, symbol: str, ltp: float, chg_pct: float | None = None) -> None:
        now = time.time()
        with _lock:
            self.live_spot[symbol.upper()] = {
                "ltp": round(ltp, 2),
                "chgPct": round(chg_pct, 2) if chg_pct is not None else None,
                "ts": now,
            }
            self._record_tick(symbol.upper(), float(ltp), now)

    def _record_tick(self, sym: str, price: float, ts: float) -> None:
        """Fold a live tick into a 5s OHLC bar (in-memory, session only)."""
        b = int(ts // self._TICK_BUCKET_S) * self._TICK_BUCKET_S
        dq = self.tick_ohlc.get(sym)
        if dq is None:
            dq = deque(maxlen=self._TICK_OHLC_MAXLEN)
            self.tick_ohlc[sym] = dq
        if dq and dq[-1]["t"] == b:
            bar = dq[-1]
            if price > bar["h"]:
                bar["h"] = price
            if price < bar["l"]:
                bar["l"] = price
            bar["c"] = price
        elif dq and dq[-1]["t"] > b:
            return  # stale out-of-order tick
        else:
            dq.append({"t": b, "o": price, "h": price, "l": price, "c": price})

    def tick_candles(self, symbol: str, interval_s: int, lookback_s: int = 4 * 3600) -> list[dict]:
        """5s tick bars re-bucketed to `interval_s`, lightweight-charts shape.
        Empty until enough ticks have arrived this session."""
        with _lock:
            base = [b for b in self.tick_ohlc.get(symbol.upper(), ()) if b["t"] >= time.time() - lookback_s]
        out: list[dict] = []
        for bar in base:
            b = int(bar["t"] // interval_s) * interval_s
            if out and out[-1]["time"] == b:
                k = out[-1]
                k["high"] = max(k["high"], bar["h"])
                k["low"] = min(k["low"], bar["l"])
                k["close"] = bar["c"]
            else:
                out.append({"time": b, "open": bar["o"], "high": bar["h"],
                            "low": bar["l"], "close": bar["c"], "volume": 0})
        return out

    def get_live_spot(self, symbol: str) -> dict | None:
        with _lock:
            return self.live_spot.get(symbol.upper())

    def set_live_future(self, symbol: str, expiry: str, ltp: float, chg_pct: float | None = None) -> None:
        now = time.time()
        key = f"{symbol.upper()}|{expiry}"
        with _lock:
            self.live_futures[key] = {
                "ltp": round(ltp, 2),
                "chgPct": round(chg_pct, 2) if chg_pct is not None else None,
                "ts": now,
            }
            self._record_tick(f"FUT:{key}", float(ltp), now)

    def get_live_future(self, symbol: str, expiry: str) -> dict | None:
        with _lock:
            return self.live_futures.get(f"{symbol.upper()}|{expiry}")

    # ---- live position MTM (tick-by-tick) -----------------------
    def set_broker_positions(self, rows: list[dict]) -> None:
        """Store a fresh raw PositionBook snapshot; it anchors the live MTM."""
        with _lock:
            self.broker_positions = list(rows or [])
            self.broker_positions_ts = time.time()
            live = {str(r.get("token")) for r in self.broker_positions}
            for tok in list(self.leg_ltp):
                if tok not in live:
                    self.leg_ltp.pop(tok, None)

    def position_tokens(self) -> set[str]:
        with _lock:
            return {
                str(r.get("token"))
                for r in self.broker_positions
                if r.get("token") and (_fnum(r.get("netqty")) or 0.0) != 0.0
            }

    def set_leg_ltp(self, token: str, ltp: float, ts: float | None = None) -> None:
        with _lock:
            self.leg_ltp[str(token)] = {"ltp": float(ltp), "ts": ts or time.time()}

    def live_positions(self) -> dict:
        """PositionBook rows with ``urmtom`` re-marked from live leg ticks.

        Noren's unrealised MTM moves linearly with the last traded price at a
        rate of ``netqty * prcftr * mult``, so we anchor to the broker's own
        ``urmtom`` (and the ``lp`` in the same snapshot) and add only the
        tick-by-tick delta since then. When the next snapshot lands we re-anchor.
        """
        now = time.time()
        with _lock:
            rows = [dict(r) for r in self.broker_positions]
            legs = dict(self.leg_ltp)
            snap_ts = self.broker_positions_ts
        total = 0.0
        realized = 0.0
        day_total = 0.0
        for r in rows:
            rpnl = _fnum(r.get("rpnl")) or 0.0
            realized += rpnl
            anchor_mtm = _fnum(r.get("urmtom"))
            if anchor_mtm is None:
                anchor_mtm = _fnum(r.get("mtm"))
            netqty = _fnum(r.get("netqty")) or 0.0
            anchor_lp = _fnum(r.get("lp"))
            # day P&L (Flattrade "P&L" — measured from prev close for CF legs);
            # falls back to total-vs-entry when the broker didn't tag it
            base_day = _fnum(r.get("_dayPnl"))
            if base_day is None:
                base_day = rpnl + (anchor_mtm or 0.0)
            live = legs.get(str(r.get("token")))
            if live and netqty and anchor_mtm is not None and anchor_lp and now - live["ts"] < 30:
                pf = _fnum(r.get("prcftr")) or 1.0
                mult = _fnum(r.get("mult")) or 1.0
                new_ur = round(anchor_mtm + netqty * (live["ltp"] - anchor_lp) * pf * mult, 2)
                r["_dayPnl"] = round(base_day + (new_ur - anchor_mtm), 2)  # moves 1:1 with urmtom
                r["urmtom"] = new_ur
                r["lp"] = live["ltp"]
                r["_liveMtm"] = True
            else:
                r["_dayPnl"] = round(base_day, 2)
            total += _fnum(r.get("urmtom")) or 0.0
            day_total += _fnum(r.get("_dayPnl")) or 0.0
        return {
            "rows": rows,
            "total": round(total, 2),
            "realized": round(realized, 2),
            "dayPnl": round(day_total, 2),
            "ts": snap_ts,
            "feedTs": now,
        }

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
                self._persist_iv_history()
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
        try:
            from .alert_delivery import deliver

            deliver(alert)
        except Exception:  # noqa: BLE001
            pass

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

    # ---- chart drawings (trendline / fib, keyed per chart) ----------
    def get_chart_drawings(self, key: str) -> list[dict]:
        with _lock:
            data = db.get_kv("chart_drawings")
            return list((data or {}).get(key) or [])

    def save_chart_drawings(self, key: str, drawings: list[dict]) -> list[dict]:
        with _lock:
            data = db.get_kv("chart_drawings")
            data = dict(data) if isinstance(data, dict) else {}
            if drawings:
                data[key] = drawings
            else:
                data.pop(key, None)
            db.set_kv("chart_drawings", data)
            return drawings

    # ---- chart layouts (named, TradingView-style), one set per user ----
    # {"active": id | None, "layouts": [{id, name, saved, layout: {...}}]} under the
    # request's user (users.current_user, None = the owner) in one kv blob.
    def get_chart_layouts(self) -> dict:
        uid = current_user.get()
        with _lock:
            data = db.get_kv("chart_layouts")
            mine = (data or {}).get(str(uid) if uid is not None else "owner")
            return mine if isinstance(mine, dict) else {"active": None, "layouts": []}

    def save_chart_layouts(self, value: dict) -> dict:
        uid = current_user.get()
        layouts = [x for x in (value.get("layouts") or []) if isinstance(x, dict) and x.get("id")][:20]
        active = value.get("active")
        clean = {"active": active if any(x["id"] == active for x in layouts) else None, "layouts": layouts}
        with _lock:
            data = db.get_kv("chart_layouts")
            data = dict(data) if isinstance(data, dict) else {}
            data[str(uid) if uid is not None else "owner"] = clean
            db.set_kv("chart_layouts", data)
            return clean

    # ---- watchlists (5 named lists) --------------------------------
    # The owner's lists, plus one set per view-only user (users.py). Which set
    # `self.watchlists` means is decided by the request / socket's user
    # (users.current_user, None = the owner), so every watchlist method below
    # works on the right user's lists without knowing about users at all.
    # ---- paper book: the owner's, plus one per view-only user ----------
    # Same pattern as the watchlists: `self.paper` is the book of the request's
    # user (users.current_user, None = the owner). Background jobs (stop checks,
    # AutoBot, short guard) run without a user, so they only ever see the owner's.
    @property
    def paper(self) -> dict:
        uid = current_user.get()
        if uid is None:
            return self._owner_paper
        book = self._user_papers.get(uid)
        if book is None:
            book = db.get_kv(f"paper:{uid}") or {"positions": [], "orders": [], "realized": 0.0}
            self._user_papers[uid] = book
        return book

    @paper.setter
    def paper(self, v: dict) -> None:
        self._owner_paper = v

    def _save_paper(self) -> None:
        uid = current_user.get()
        db.set_kv("paper" if uid is None else f"paper:{uid}", self.paper)

    @property
    def watchlists(self) -> dict:
        uid = current_user.get()
        if uid is None:
            return self._owner_wl
        wl = self._user_wls.get(uid)
        if wl is None:
            wl = self._user_wls[uid] = self._load_watchlists(f"watchlists:{uid}")
        return wl

    @watchlists.setter
    def watchlists(self, v: dict) -> None:
        self._owner_wl = v

    def _load_watchlists(self, key: str = "watchlists") -> dict:
        data = db.get_kv(key)
        if key != "watchlists" and not (isinstance(data, dict) and data.get("lists")):
            data = {"lists": [], "active": 0}
        if isinstance(data, dict) and isinstance(data.get("lists"), list) and data["lists"]:
            lists = [
                {"name": str(l.get("name") or f"List {i + 1}"), "symbols": list(l.get("symbols") or [])}
                for i, l in enumerate(data["lists"][:_WL_MAX])
            ]
        elif key == "watchlists":
            legacy = _load(_WATCHLIST_FILE, list(DEFAULT_SYMBOLS))
            lists = [{"name": "List 1", "symbols": list(legacy)}]
        else:  # a new viewer: empty lists (the default indices still show)
            lists = [{"name": "List 1", "symbols": []}]
        # trim trailing empty lists beyond the default count
        while len(lists) > _WL_DEFAULT and not lists[-1]["symbols"]:
            lists.pop()
        while len(lists) < _WL_DEFAULT:
            lists.append({"name": f"List {len(lists) + 1}", "symbols": []})
        active = min(max(int((data or {}).get("active", 0)), 0), len(lists) - 1)
        hidden = [s for s in (data or {}).get("hiddenDefaults", []) if s in DEFAULT_SYMBOLS]
        return {"lists": lists, "active": active, "hiddenDefaults": hidden}

    def _save_watchlists(self) -> None:
        uid = current_user.get()
        db.set_kv("watchlists" if uid is None else f"watchlists:{uid}", self.watchlists)

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

    def watched_option_pairs(self) -> set[tuple[str, str]]:
        """(symbol, expiry) of every option contract in the active watchlist --
        the owner's and each loaded viewer's -- the poller keeps those chains
        fresh, so a later-expiry row (e.g. added from search) prices instead of
        sitting on "loading"."""
        out: set[tuple[str, str]] = set()
        for book in self._user_papers.values():  # viewers' paper positions stay priced
            for pos in book.get("positions", []):
                if pos.get("symbol") and pos.get("expiry"):
                    out.add((str(pos["symbol"]).upper(), pos["expiry"]))
        for wl in [self._owner_wl, *self._user_wls.values()]:
            for e in wl["lists"][wl["active"]]["symbols"]:
                p = self._parse_opt(e)
                if p:
                    out.add((p[0], p[1]))
        return out

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
        # an option key ("NIFTY|29-Sep-2026|23400|CE", from search) keeps the
        # chain's mixed-case expiry -- uppercasing it broke every later match
        symbol = symbol.strip() if "|" in symbol else symbol.upper().strip()
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
        symbol = symbol.strip()
        # composite keys (options "SYM|EXP|STRIKE|OT", futures "FUT:SYM|EXP")
        # are built by the app itself with a canonical, mixed-case NSE expiry
        # ("08-Sep-2026") and must match exactly -- uppercasing here silently
        # broke removing them (confirmed: stored key survives an uppercased
        # comparison). Plain typed-in symbols/"IDX:" entries stay
        # case-insensitive, since those really do come from free-text input.
        if "|" not in symbol:
            symbol = symbol.upper()
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

    @staticmethod
    def _parse_fut(entry: str):
        """'FUT:NIFTY|29-Sep-2026' -> (symbol, expiry) or None."""
        if not entry.startswith("FUT:"):
            return None
        parts = entry[4:].split("|")
        if len(parts) != 2 or not parts[0] or not parts[1]:
            return None
        return parts[0].upper(), parts[1]

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
            fut = self._parse_fut(entry)
            if fut:
                sym, exp = fut
                live = self.live_futures.get(f"{sym}|{exp}")
                out.append(
                    {
                        "key": entry,
                        "kind": "future",
                        "symbol": sym,
                        "expiry": exp,
                        "ltp": live["ltp"] if live else None,
                        "chgPct": live["chgPct"] if live else None,
                        "lotSize": lot_size(sym),
                        "error": None if live else "loading",
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
            live = self.live_spot.get(sym.upper())

            # NSE index catalog carries the index names *and* INDIA VIX with a
            # day change (pChange + variation) — the only source for a row with
            # no option chain (INDIA VIX) or no broker/Upstox feed.
            idxq = None
            needle = sym.upper().replace(" ", "")
            for nm, q in list(self.index_quotes.items()):
                if nm.upper().replace(" ", "") == needle:
                    idxq = q
                    break

            spot = (
                (live["ltp"] if live else None)
                or (chain["spot"] if chain else None)
                or (idxq.get("last") if idxq else None)
            )
            chg_pct = live["chgPct"] if live else None
            variation = None
            if idxq:
                if chg_pct is None:
                    chg_pct = idxq.get("pChange")
                if idxq.get("variation") is not None:
                    variation = idxq.get("variation")
            if variation is None and spot is not None and chg_pct is not None:
                try:
                    prev = float(spot) / (1 + float(chg_pct) / 100)
                    variation = round(float(spot) - prev, 2)
                except (TypeError, ValueError, ZeroDivisionError):
                    variation = None
            # last resort — move from the first spot seen today, so a plain stock
            # with no live feed still shows an arrow + points + % like the rest
            if spot is not None and chg_pct is None and variation is None:
                try:
                    op = self.session_open(sym, float(spot))
                    if op:
                        variation = round(float(spot) - op, 2)
                        chg_pct = round((float(spot) - op) / op * 100, 2)
                except Exception:  # noqa: BLE001
                    pass

            if chain or spot is not None:
                row = {
                    "key": sym,
                    "kind": "symbol",
                    "symbol": sym,
                    "spot": chain["spot"] if chain else spot,
                    "liveSpot": (live["ltp"] if live else None) or spot,
                    "liveChgPct": chg_pct,
                    "variation": variation,
                }
                if chain:
                    row.update(
                        {
                            "atmIV": chain["atmIV"],
                            "atmStrike": chain["atmStrike"],
                            "pcr": chain["pcr"],
                            "dte": chain["dte"],
                            "expiry": chain["expiry"],
                            "lotSize": chain["lotSize"],
                            "fetchedAt": chain.get("fetchedAt"),
                        }
                    )
                out.append(row)
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

    def add_future(self, index: int, symbol: str, expiry: str) -> list[str]:
        """Add one futures-contract key. Builds the key directly (like
        add_strikes does for options) rather than going through add_watch,
        which uppercases the whole string -- that would mangle the NSE-style
        mixed-case expiry ("29-Sep-2026" -> "29-SEP-2026") and break every
        later exact-string match against it."""
        key = f"FUT:{symbol.upper()}|{expiry}"
        with _lock:
            i = self._wli(index)
            syms = self.watchlists["lists"][i]["symbols"]
            if key not in syms:
                syms.append(key)
            self._save_watchlists()
            return list(syms)

    # ---- paper trading -----------------------------------------------
    def _mark_price(self, symbol: str, expiry: str, strike: float, ot: str) -> Optional[float]:
        if ot == "FUT":
            live = self.live_futures.get(f"{symbol.upper()}|{expiry}")
            return live["ltp"] if live else None
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
            self._save_paper()
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
                    pnl = direction * (order["price"] - pos["avgPrice"]) * closed
                    self.paper["realized"] += pnl
                    self._record_trade_close(pos, order, closed, pnl)
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

    def _record_trade_close(self, pos: dict, order: dict, closed: float, pnl: float) -> None:
        """Append a closed-trade record to the journal. Called from inside
        `_apply_fill` for every fill that reduces/closes/flips a position --
        the single choke point every paper close (manual, "Close" button, or
        auto SL/target via check_stops) already funnels through."""
        if current_user.get() is not None:
            return  # a view-only user's paper trade: the journal is the owner's
        entry = {
            "id": uuid.uuid4().hex[:10],
            "mode": "paper",
            "symbol": pos["symbol"],
            "expiry": pos["expiry"],
            "strike": pos["strike"],
            "optionType": pos["optionType"],
            "side": "BUY" if pos["qty"] > 0 else "SELL",
            "qty": closed,
            "lotSize": pos["lotSize"],
            "entryPrice": round(pos["avgPrice"], 2),
            "exitPrice": round(order["price"], 2),
            "pnl": round(pnl, 2),
            "openedTs": pos.get("openedTs"),
            "closedTs": order["ts"],
            "note": order.get("note", ""),
        }
        self.journal.appendleft(entry)
        db.save_row("journal", entry["id"], entry, ts=entry["closedTs"])

    def get_journal(self, limit: int = 200, symbol: str | None = None, extra: list[dict] | None = None) -> list[dict]:
        """Paper trades, plus `extra` (live Flattrade round trips) merged newest-first."""
        with _lock:
            rows = list(self.journal)
        if extra:
            rows = sorted(rows + extra, key=lambda r: -r["closedTs"])
        if symbol:
            rows = [r for r in rows if r["symbol"] == symbol.upper()]
        return rows[: max(1, min(limit, _JOURNAL_MAXLEN))]

    def journal_stats(self, extra: list[dict] | None = None) -> dict:
        from datetime import datetime

        from .processing import IST

        with _lock:
            rows_chrono = sorted(list(self.journal) + (extra or []), key=lambda r: r["closedTs"])

        n = len(rows_chrono)
        wins = [r for r in rows_chrono if r["pnl"] > 0]
        losses = [r for r in rows_chrono if r["pnl"] < 0]
        gross_win = sum(r["pnl"] for r in wins)
        gross_loss = sum(r["pnl"] for r in losses)

        equity_curve: list[dict] = []
        day_map: dict[str, dict] = {}
        sym_map: dict[str, dict] = {}
        cum = 0.0
        for r in rows_chrono:
            cum += r["pnl"]
            equity_curve.append({"ts": r["closedTs"], "cum": round(cum, 2)})
            day = datetime.fromtimestamp(r["closedTs"], IST).strftime("%Y-%m-%d")
            d = day_map.setdefault(day, {"date": day, "pnl": 0.0, "trades": 0})
            d["pnl"] += r["pnl"]
            d["trades"] += 1
            s = sym_map.setdefault(
                r["symbol"], {"symbol": r["symbol"], "pnl": 0.0, "trades": 0, "wins": 0}
            )
            s["pnl"] += r["pnl"]
            s["trades"] += 1
            if r["pnl"] > 0:
                s["wins"] += 1

        by_day = sorted(day_map.values(), key=lambda d: d["date"])
        for d in by_day:
            d["pnl"] = round(d["pnl"], 2)
        by_symbol = sorted(sym_map.values(), key=lambda s: -abs(s["pnl"]))
        for s in by_symbol:
            s["pnl"] = round(s["pnl"], 2)
            s["winRate"] = round(100 * s["wins"] / s["trades"], 1) if s["trades"] else 0.0

        hold_secs = [r["closedTs"] - r["openedTs"] for r in rows_chrono if r.get("openedTs")]

        return {
            "totalTrades": n,
            "wins": len(wins),
            "losses": len(losses),
            "winRate": round(100 * len(wins) / n, 1) if n else 0.0,
            "totalPnl": round(gross_win + gross_loss, 2),
            "avgWin": round(gross_win / len(wins), 2) if wins else 0.0,
            "avgLoss": round(gross_loss / len(losses), 2) if losses else 0.0,
            "bestTrade": round(max((r["pnl"] for r in rows_chrono), default=0.0), 2),
            "worstTrade": round(min((r["pnl"] for r in rows_chrono), default=0.0), 2),
            "profitFactor": round(gross_win / abs(gross_loss), 2) if gross_loss < 0 else None,
            "avgHoldMin": round(sum(hold_secs) / len(hold_secs) / 60, 1) if hold_secs else 0.0,
            "equityCurve": equity_curve,
            "byDay": by_day,
            "bySymbol": by_symbol,
        }

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
                # blocked margin: long = premium paid, short = ~SPAN+exposure on strike
                # notional -- a future has no strike, so fall back to the same
                # price-based figure longs use (still a heuristic, not real SPAN,
                # same honesty the rest of this margin model already has)
                if pos["qty"] >= 0 or pos["optionType"] == "FUT":
                    margin_used += pos["avgPrice"] * abs(pos["qty"])
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
                self._save_paper()
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
            self._save_paper()
            return self.paper_state()

    def clear_stop(self, position_id: str) -> dict:
        with _lock:
            for p in self.paper["positions"]:
                if p["id"] == position_id:
                    p.pop("sl", None)
            self._save_paper()
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
