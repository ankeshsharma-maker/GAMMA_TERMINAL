"""Cross-symbol option screener.

A slow background task (see poller.run_universe_scan) walks `FO_UNIVERSE`, pulling
the nearest-expiry chain per symbol and turning it into a screener row. Rows are
kept in `store.universe`; IV history (for the session IV-rank) in `store.iv_history`.

IV rank / percentile are computed over whatever IV history we have collected this
session -- meaningful after a few hours, not a true 1-year rank.
"""
from __future__ import annotations

import time


def classify_oi_buildup(price_move_pct: float, oi_chg: float, oi_base: float) -> str:
    rel = oi_chg / oi_base if oi_base else 0.0
    if abs(price_move_pct) < 0.0015 or abs(rel) < 0.01:
        return "NEUTRAL"
    up = price_move_pct > 0
    oi_up = oi_chg > 0
    if up and oi_up:
        return "LONG_BUILDUP"
    if not up and oi_up:
        return "SHORT_BUILDUP"
    if up and not oi_up:
        return "SHORT_COVERING"
    return "LONG_UNWINDING"


def iv_rank(series: list[float], current: float | None) -> tuple[float | None, float | None]:
    vals = [v for v in series if v is not None and v > 0]
    if current is None or len(vals) < 5:
        return None, None
    lo, hi = min(vals), max(vals)
    rank = 100.0 * (current - lo) / (hi - lo) if hi > lo else 50.0
    pct = 100.0 * sum(1 for v in vals if v <= current) / len(vals)
    return round(max(0.0, min(100.0, rank)), 1), round(pct, 1)


def evaluate(symbol: str, chain: dict, iv_series: list[float], session_open: float | None) -> dict:
    spot = chain["spot"]
    atm_iv = chain.get("atmIV")
    straddle = chain.get("atmStraddle")
    tot = chain["totals"]
    ce_chg, pe_chg = tot["ceOIChg"], tot["peOIChg"]
    oi_base = (abs(tot["ceOI"]) + abs(tot["peOI"])) or 1.0
    net_oi_chg = ce_chg + pe_chg

    ref = session_open or (iv_series and spot) or spot
    move_pct = ((spot - session_open) / session_open) if session_open else 0.0

    rank, pct = iv_rank(iv_series, atm_iv)
    max_pain = chain.get("maxPain") or spot
    mp_dist = ((spot - max_pain) / spot * 100.0) if spot else 0.0

    return {
        "symbol": symbol,
        "spot": round(spot, 2),
        "sessionMovePct": round(move_pct * 100.0, 2),
        "expiry": chain["expiry"],
        "dte": chain["dte"],
        "pcr": chain.get("pcr"),
        "atmIV": atm_iv,
        "ivRank": rank,
        "ivPct": pct,
        "straddle": straddle,
        "straddlePctOfSpot": round(straddle / spot * 100.0, 2) if (straddle and spot) else None,
        "maxPain": max_pain,
        "maxPainDistPct": round(mp_dist, 2),
        "netGex": chain.get("netGex"),
        "ceOIChg": ce_chg,
        "peOIChg": pe_chg,
        "oiBuildup": classify_oi_buildup(move_pct, net_oi_chg, oi_base),
        "ts": time.time(),
    }


# --------------------------------------------------------------------------
FILTER_PRESETS = {
    "High IV": {"ivRankMin": 70},
    "Low IV": {"ivRankMax": 30},
    "Long Buildup": {"oiBuildup": ["LONG_BUILDUP"]},
    "Short Buildup": {"oiBuildup": ["SHORT_BUILDUP"]},
    "Short Covering": {"oiBuildup": ["SHORT_COVERING"]},
    "Near expiry": {"dteMax": 2},
    "Bullish PCR": {"pcrMin": 1.2},
    "Bearish PCR": {"pcrMax": 0.7},
}

_SORTABLE = {
    "ivRank", "atmIV", "pcr", "sessionMovePct", "straddlePctOfSpot",
    "maxPainDistPct", "dte", "netGex", "symbol",
}


def apply_filters(rows: list[dict], spec: dict) -> list[dict]:
    def keep(r: dict) -> bool:
        def num(key):
            return r.get(key)

        checks = [
            (spec.get("ivRankMin") is None or (num("ivRank") is not None and num("ivRank") >= spec["ivRankMin"])),
            (spec.get("ivRankMax") is None or (num("ivRank") is not None and num("ivRank") <= spec["ivRankMax"])),
            (spec.get("atmIVMin") is None or (num("atmIV") is not None and num("atmIV") >= spec["atmIVMin"])),
            (spec.get("atmIVMax") is None or (num("atmIV") is not None and num("atmIV") <= spec["atmIVMax"])),
            (spec.get("pcrMin") is None or (num("pcr") is not None and num("pcr") >= spec["pcrMin"])),
            (spec.get("pcrMax") is None or (num("pcr") is not None and num("pcr") <= spec["pcrMax"])),
            (spec.get("dteMax") is None or (num("dte") is not None and num("dte") <= spec["dteMax"])),
            (spec.get("sessionMoveMin") is None or (num("sessionMovePct") is not None and num("sessionMovePct") >= spec["sessionMoveMin"])),
            (spec.get("sessionMoveMax") is None or (num("sessionMovePct") is not None and num("sessionMovePct") <= spec["sessionMoveMax"])),
            (spec.get("straddlePctMin") is None or (num("straddlePctOfSpot") is not None and num("straddlePctOfSpot") >= spec["straddlePctMin"])),
            (not spec.get("oiBuildup") or r.get("oiBuildup") in spec["oiBuildup"]),
        ]
        return all(checks)

    out = [r for r in rows if keep(r)]
    sort_by = spec.get("sortBy") if spec.get("sortBy") in _SORTABLE else "ivRank"
    reverse = spec.get("sortDir", "desc") != "asc"
    out.sort(key=lambda r: (r.get(sort_by) is None, r.get(sort_by) if r.get(sort_by) is not None else 0), reverse=reverse)
    limit = spec.get("limit")
    return out[:limit] if isinstance(limit, int) and limit > 0 else out
