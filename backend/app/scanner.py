"""Gamma-blast signal engine.

For each tracked symbol we combine the current processed chain with the rolling
history deque (`store.history`, ~15s cadence) into:
  - normalised sub-scores (0..1) for the ingredients of an expiry-day gamma blast
  - a composite Gamma Blast Score (0..100), DTE-gated
  - a directional bias
  - human-readable reasons
and raise de-duplicated alerts when scores/moves cross thresholds.

Everything here is heuristic and meant to be tuned -- the weights and refs below
are the knobs.
"""
from __future__ import annotations

import time

# history lookback in samples (~15s each): 20 ~= 5 min, 80 ~= 20 min
W_SHORT = 20
W_LONG = 80

# component weights (sum ~= 1.0 before the DTE gate)
WEIGHTS = {
    "gamma": 0.20,
    "breakout": 0.17,
    "dte": 0.15,
    "straddle": 0.14,
    "ivpop": 0.13,
    "unwind": 0.11,
    "pin": 0.10,
}

# normalisation references
IV_POP_PTS = 1.5      # ATM IV points in 5m -> full ivpop score
STRADDLE_EXP = 0.15   # +15% straddle in 5m -> full straddle score
MOVE_REF_PCT = 0.004  # 0.4% spot move -> full breakout score (fallback)
MP_REF_PCT = 0.004    # 0.4% away from max pain -> full pin-break score


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _past(hist: list[dict], n: int, key: str):
    if not hist:
        return None
    return hist[max(0, len(hist) - 1 - n)].get(key)


def evaluate(symbol: str, chain: dict, hist: list[dict]) -> dict:
    now = time.time()
    spot = chain["spot"] or 0.0
    dte = chain["dte"]
    atm_iv = chain.get("atmIV")
    straddle = chain.get("atmStraddle")
    atm_gex = chain.get("atmGammaOI") or 0.0
    net_gex = chain.get("netGex") or 0.0
    max_pain = chain.get("maxPain") or spot
    ce_oi_chg = chain["totals"]["ceOIChg"]
    pe_oi_chg = chain["totals"]["peOIChg"]

    reasons: list[str] = []

    # --- DTE ramp: gamma blast is an expiry-day phenomenon ---
    g_dte = _clamp((2.0 - dte) / 2.0)
    if dte <= 1.0:
        reasons.append(f"{dte:.2f} DTE")

    # --- spot move vs recent range (compression -> expansion) ---
    spot_5m = _past(hist, W_SHORT, "spot") or spot
    long_spots = [h["spot"] for h in hist[-W_LONG:] if h.get("spot")]
    rng = (max(long_spots) - min(long_spots)) if len(long_spots) >= 3 else 0.0
    move_5m = spot - spot_5m
    move_5m_pct = (move_5m / spot) if spot else 0.0
    if rng > spot * 0.0005:
        g_breakout = _clamp(abs(move_5m) / rng)
    else:
        g_breakout = _clamp(abs(move_5m_pct) / MOVE_REF_PCT)
    if abs(move_5m_pct) >= 0.003:
        reasons.append(f"Spot {move_5m_pct * 100:+.2f}% in 5m")

    # --- IV pop (sudden intraday IV uptick = blast fuel) ---
    iv_5m = _past(hist, W_SHORT, "atmIV")
    iv_chg = (atm_iv - iv_5m) if (atm_iv and iv_5m) else 0.0
    g_ivpop = _clamp(iv_chg / IV_POP_PTS)
    if iv_chg >= 0.8:
        reasons.append(f"ATM IV {iv_chg:+.1f} in 5m")

    # --- straddle expansion / collapse ---
    str_5m = _past(hist, W_SHORT, "atmStraddle")
    str_pct = ((straddle - str_5m) / str_5m) if (straddle and str_5m) else 0.0
    g_straddle = _clamp(str_pct / STRADDLE_EXP)
    if str_pct >= 0.08:
        reasons.append(f"Straddle {str_pct * 100:+.0f}% in 5m")
    elif str_pct <= -0.12:
        reasons.append(f"Straddle {str_pct * 100:+.0f}% in 5m (pinning)")

    # --- gamma proximity: is ATM gamma*OI near its recent peak? ---
    gex_hist = [abs(h["atmGammaOI"]) for h in hist[-W_LONG:] if h.get("atmGammaOI")]
    gex_ref = max(gex_hist) if gex_hist else (abs(atm_gex) or 1.0)
    g_gamma = _clamp(abs(atm_gex) / gex_ref) if gex_ref else 0.0
    if net_gex < 0:
        g_gamma = _clamp(g_gamma + 0.15)
        reasons.append("Dealers net short gamma")

    # --- one-sided OI unwind (short covering / squeeze) ---
    tot = abs(ce_oi_chg) + abs(pe_oi_chg) + 1.0
    imb = (pe_oi_chg - ce_oi_chg) / tot  # >0: puts written / calls covered -> bullish
    g_unwind = _clamp(abs(imb))
    if ce_oi_chg < 0 and abs(ce_oi_chg) > 0.4 * tot:
        reasons.append("CE OI unwinding")
    if pe_oi_chg < 0 and abs(pe_oi_chg) > 0.4 * tot:
        reasons.append("PE OI unwinding")

    # --- pin break vs max pain ---
    mp_dist = (abs(spot - max_pain) / spot) if spot else 0.0
    g_pin = _clamp(mp_dist / MP_REF_PCT)
    if mp_dist >= 0.003:
        reasons.append(f"Spot {mp_dist * 100:.1f}% from Max Pain")

    comp = {
        "gamma": g_gamma,
        "breakout": g_breakout,
        "dte": g_dte,
        "straddle": g_straddle,
        "ivpop": g_ivpop,
        "unwind": g_unwind,
        "pin": g_pin,
    }
    raw = sum(WEIGHTS[k] * comp[k] for k in WEIGHTS)
    gate = 0.25 + 0.75 * g_dte
    score = round(100 * raw * gate, 1)

    bias_val = (move_5m_pct / MOVE_REF_PCT) + 0.6 * imb
    bias = "UP" if bias_val > 0.25 else ("DOWN" if bias_val < -0.25 else "NEUTRAL")

    return {
        "symbol": symbol,
        "ts": now,
        "score": score,
        "bias": bias,
        "dte": dte,
        "spot": round(spot, 2),
        "atmIV": atm_iv,
        "ivChg5m": round(iv_chg, 2),
        "straddle": straddle,
        "straddlePct5m": round(str_pct * 100, 1),
        "move5mPct": round(move_5m_pct * 100, 2),
        "range20m": round(rng, 1),
        "netGex": net_gex,
        "atmGammaOI": atm_gex,
        "pcr": chain.get("pcr"),
        "maxPain": max_pain,
        "mpDistPct": round(mp_dist * 100, 2),
        "oiImbalance": round(imb, 2),
        "components": {k: round(v, 2) for k, v in comp.items()},
        "reasons": reasons[:5],
    }


def _emit_alerts(store, row: dict, prev: dict | None) -> list[dict]:
    sym, sc = row["symbol"], row["score"]
    psc = (prev or {}).get("score", 0.0)
    fired: list[dict] = []

    def fire(kind: str, severity: str, message: str) -> None:
        if store.recent_alert(sym, kind, 300):
            return
        alert = {
            "ts": time.time(),
            "symbol": sym,
            "kind": kind,
            "severity": severity,
            "message": message,
            "score": sc,
        }
        store.add_alert(alert)
        fired.append(alert)

    tag = ", ".join(row["reasons"][:2]) or f"bias {row['bias']}"
    if sc >= 80 and psc < 80:
        fire("blast-crit", "critical", f"{sym}: gamma-blast score {sc:.0f} — {tag}")
    elif sc >= 60 and psc < 60:
        fire("blast-warn", "warning", f"{sym}: gamma-blast building {sc:.0f} — {tag}")
    if row["ivChg5m"] >= 2.0:
        fire("iv-spike", "warning", f"{sym}: ATM IV {row['ivChg5m']:+.1f} pts in 5m")
    if row["straddlePct5m"] >= 20:
        fire("straddle-exp", "warning", f"{sym}: ATM straddle {row['straddlePct5m']:+.0f}% in 5m")
    return fired


def run(store) -> dict:
    """Re-score every tracked symbol. Returns the sorted scan + any new alerts."""
    new_alerts: list[dict] = []
    for sym in store.all_symbols():
        chain = store.get_chain(sym)
        if not chain:
            continue
        prev = store.scan_results.get(sym)
        row = evaluate(sym, chain, store.get_history(sym))
        store.set_scan(sym, row)
        new_alerts += _emit_alerts(store, row, prev)
    return {"scan": store.get_scan(), "newAlerts": new_alerts}
