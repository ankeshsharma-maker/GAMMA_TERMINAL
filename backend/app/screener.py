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


def _clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))


def smart_money(
    chain: dict,
    spot: float,
    move_pct: float,
    oi_buildup: str,
    straddle_pct: float | None,
    iv_rank: float | None,
) -> dict:
    """Smart-money / early-signal read from a single chain snapshot.

    Looks at *where* today's OI is being added (walls, ATM writer bias, the
    single biggest call/put OI adds), how one-sided the flow is, the put/call
    IV skew and the dealer gamma regime, then rolls them into a signed
    -100..100 score + a BULLISH / BEARISH / NEUTRAL label.
    """
    rows = chain.get("rows") or []
    tot = chain["totals"]
    atm = chain.get("atmStrike") or spot
    step = chain.get("strikeStep") or 50.0
    gamma_flip = chain.get("gammaFlip") or atm

    # OI walls (largest standing OI = where writers are parked)
    call_wall = max(rows, key=lambda r: r["call"]["oi"], default=None)
    put_wall = max(rows, key=lambda r: r["put"]["oi"], default=None)
    call_wall_k = call_wall["strike"] if call_wall else None
    put_wall_k = put_wall["strike"] if put_wall else None

    wall_break = ""
    if call_wall_k and spot > call_wall_k:
        wall_break = "ABOVE_CALL_WALL"
    elif put_wall_k and spot < put_wall_k:
        wall_break = "BELOW_PUT_WALL"

    # single biggest OI additions today
    ce_add = max(rows, key=lambda r: r["call"]["oiChg"], default=None)
    pe_add = max(rows, key=lambda r: r["put"]["oiChg"], default=None)
    max_ce_add = ce_add["call"]["oiChg"] if ce_add else 0.0
    max_pe_add = pe_add["put"]["oiChg"] if pe_add else 0.0

    # ATM +/- 2 strikes: who is writing right at the money
    band = 2 * step
    ce_atm = sum(r["call"]["oiChg"] for r in rows if abs(r["strike"] - atm) <= band)
    pe_atm = sum(r["put"]["oiChg"] for r in rows if abs(r["strike"] - atm) <= band)
    if pe_atm > abs(ce_atm) * 1.4 and pe_atm > 0:
        atm_bias = "PUT_WRITING"        # bullish - writers selling puts at the money
    elif ce_atm > abs(pe_atm) * 1.4 and ce_atm > 0:
        atm_bias = "CALL_WRITING"       # bearish
    else:
        atm_bias = "MIXED"

    # directional flow bias: puts building faster than calls => bullish
    oi_base = (abs(tot["ceOI"]) + abs(tot["peOI"])) or 1.0
    flow_bias = round(_clamp((tot["peOIChg"] - tot["ceOIChg"]) / oi_base * 400.0, -100.0, 100.0), 1)

    vol_oi_ratio = round((tot.get("ceVol", 0) + tot.get("peVol", 0)) / oi_base, 3)

    # put vs call ATM IV skew (points): positive = downside being bid
    atm_row = next((r for r in rows if r["strike"] == atm), None)
    iv_skew = None
    if atm_row:
        cv = atm_row["call"].get("ivCalc") or atm_row["call"].get("iv")
        pv = atm_row["put"].get("ivCalc") or atm_row["put"].get("iv")
        if cv and pv:
            iv_skew = round(pv - cv, 2)

    gamma_regime = "SHORT_GAMMA" if spot < gamma_flip else "LONG_GAMMA"
    gamma_flip_dist = round((spot - gamma_flip) / spot * 100.0, 2) if spot else 0.0

    compression = bool(iv_rank is not None and iv_rank <= 20 and (straddle_pct or 99) < 6)

    # ---- score --------------------------------------------------------
    score = 0.0
    sig: list[str] = []
    score += _clamp(flow_bias * 0.3, -30, 30)
    if abs(flow_bias) >= 25:
        sig.append(f"{'put' if flow_bias > 0 else 'call'} flow {flow_bias:+.0f}")
    if atm_bias == "PUT_WRITING":
        score += 20
        sig.append("ATM put writing")
    elif atm_bias == "CALL_WRITING":
        score -= 20
        sig.append("ATM call writing")
    if wall_break == "ABOVE_CALL_WALL":
        score += 25
        sig.append(f"broke call wall {call_wall_k:g}")
    elif wall_break == "BELOW_PUT_WALL":
        score -= 25
        sig.append(f"broke put wall {put_wall_k:g}")
    score += {"LONG_BUILDUP": 15, "SHORT_COVERING": 12,
              "SHORT_BUILDUP": -15, "LONG_UNWINDING": -12}.get(oi_buildup, 0)
    if max_pe_add > max_ce_add * 1.3 and max_pe_add > 0:
        score += 10
        sig.append(f"big put add @{pe_add['strike']:g}")
    elif max_ce_add > max_pe_add * 1.3 and max_ce_add > 0:
        score -= 10
        sig.append(f"big call add @{ce_add['strike']:g}")
    if iv_skew is not None and iv_skew > 1.5:
        score -= 8
        sig.append(f"put-rich IV {iv_skew:+.1f}")
    elif iv_skew is not None and iv_skew < -1.5:
        score += 8
        sig.append(f"call-rich IV {iv_skew:+.1f}")
    if gamma_regime == "SHORT_GAMMA":
        score *= 1.15
        sig.append("short-gamma (moves amplify)")
    if compression:
        sig.append("coiled: low IV rank")

    score = round(_clamp(score, -100, 100), 1)
    bias = "BULLISH" if score >= 25 else "BEARISH" if score <= -25 else "NEUTRAL"

    return {
        "callWall": call_wall_k,
        "putWall": put_wall_k,
        "wallBreak": wall_break,
        "maxCallAddStrike": ce_add["strike"] if ce_add else None,
        "maxCallAdd": round(max_ce_add),
        "maxPutAddStrike": pe_add["strike"] if pe_add else None,
        "maxPutAdd": round(max_pe_add),
        "atmBias": atm_bias,
        "flowBias": flow_bias,
        "volOiRatio": vol_oi_ratio,
        "ivSkew": iv_skew,
        "gammaFlip": gamma_flip,
        "gammaRegime": gamma_regime,
        "gammaFlipDistPct": gamma_flip_dist,
        "compression": compression,
        "smartMoneyScore": score,
        "smartBias": bias,
        "smartSignals": sig,
    }


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
    straddle_pct = round(straddle / spot * 100.0, 2) if (straddle and spot) else None
    buildup = classify_oi_buildup(move_pct, net_oi_chg, oi_base)

    row = {
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
        "straddlePctOfSpot": straddle_pct,
        "maxPain": max_pain,
        "maxPainDistPct": round(mp_dist, 2),
        "netGex": chain.get("netGex"),
        "ceOIChg": ce_chg,
        "peOIChg": pe_chg,
        "oiBuildup": buildup,
        "ts": time.time(),
    }
    try:
        row.update(smart_money(chain, spot, move_pct, buildup, straddle_pct, rank))
    except Exception:  # noqa: BLE001 - never let the smart-money block kill a row
        pass
    return row


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
    "Smart-Money Bull": {"smartScoreMin": 35, "sortBy": "smartMoneyScore", "sortDir": "desc"},
    "Smart-Money Bear": {"smartScoreMax": -35, "sortBy": "smartMoneyScore", "sortDir": "asc"},
    "Wall Break": {"wallBreak": ["ABOVE_CALL_WALL", "BELOW_PUT_WALL"]},
    "Coiled (low IV)": {"compression": True},
    "Short-Gamma (trend)": {"gammaRegime": ["SHORT_GAMMA"]},
}

_SORTABLE = {
    "ivRank", "atmIV", "pcr", "sessionMovePct", "straddlePctOfSpot",
    "maxPainDistPct", "dte", "netGex", "symbol",
    "smartMoneyScore", "flowBias", "volOiRatio", "gammaFlipDistPct",
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
            (spec.get("smartScoreMin") is None or (num("smartMoneyScore") is not None and num("smartMoneyScore") >= spec["smartScoreMin"])),
            (spec.get("smartScoreMax") is None or (num("smartMoneyScore") is not None and num("smartMoneyScore") <= spec["smartScoreMax"])),
            (not spec.get("wallBreak") or r.get("wallBreak") in spec["wallBreak"]),
            (not spec.get("gammaRegime") or r.get("gammaRegime") in spec["gammaRegime"]),
            (not spec.get("compression") or r.get("compression") is True),
        ]
        return all(checks)

    out = [r for r in rows if keep(r)]
    sort_by = spec.get("sortBy") if spec.get("sortBy") in _SORTABLE else "ivRank"
    reverse = spec.get("sortDir", "desc") != "asc"
    out.sort(key=lambda r: (r.get(sort_by) is None, r.get(sort_by) if r.get(sort_by) is not None else 0), reverse=reverse)
    limit = spec.get("limit")
    return out[:limit] if isinstance(limit, int) and limit > 0 else out
