"""Gamma-blast signal engine.

For each tracked symbol we combine the current processed chain with the rolling
history deque (`store.history`, one sample per poll; windows below are in real
seconds so they don't depend on the poll cadence) into:
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

# history lookback in SECONDS, not sample counts: the poll cadence differs per
# deployment (~9s prod, ~30s local dev), so counting samples silently changed
# what "5m" meant (about 3 min on prod, 10 min on dev)
WIN_SHORT_S = 300.0    # 5 min
WIN_LONG_S = 1200.0    # 20 min
BASELINE_TOL_S = 90.0  # a baseline sample further than this from its target time is stale

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

# "blast building" alert: fires when the score has RISEN fast (so it works from
# any calm baseline) AND one near-ATM strike shows an outsized OI move. Untuned
# starting values -- calibrate with tools/blast_backtest.py once sessions are
# archived (history_archive.py).
BUILD_MIN_SCORE = 35.0     # ignore rises out of a dead-calm baseline
BUILD_MIN_RISE = 12.0      # score points gained over the last WIN_SHORT_S
BUILD_DEDUP_S = 900        # one "building" alert per symbol per 15 min
BUILD_MAX_PER_10MIN = 5    # flood valve across all symbols (e.g. stock-expiry day)

# what counts as a high-value OI move at one strike, vs ~OI_WINDOW_MIN ago
OI_WINDOW_MIN = 15
OI_NEAR_STRIKES = 8        # +-8 strikes around spot, where gamma actually bites
OI_MIN_TOTAL_PCT = 0.006   # >= 0.6% of that side's total OI (material to the chain)
OI_MIN_OWN_PCT = 0.10      # >= 10% of the strike's own OI (material to the strike)
OI_STAND_OUT = 2.5         # >= 2.5x the median |change| of the near-ATM legs


def _clamp(x: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, x))


def _at(hist: list[dict], ts: float) -> dict | None:
    """Latest sample at or before `ts`, provided it lies within BASELINE_TOL_S
    of it. None when history doesn't reach back that far (early session) or the
    nearest sample is stale (feed gap, restart): callers then treat the change
    as unknown (0) rather than comparing against the wrong moment."""
    for h in reversed(hist):
        t = h.get("t")
        if t is not None and t <= ts:
            return h if ts - t <= BASELINE_TOL_S else None
    return None


def evaluate(symbol: str, chain: dict, hist: list[dict], now: float | None = None) -> dict:
    now = time.time() if now is None else now
    # anchor the windows on the newest sample, not the wall clock, so a stalled
    # feed keeps a stable score and a recorded session replays identically
    t_ref = (hist[-1].get("t") or now) if hist else now
    base = _at(hist, t_ref - WIN_SHORT_S)  # the sample ~5 min ago, or None
    long_hist = [h for h in hist if (h.get("t") or 0) >= t_ref - WIN_LONG_S]  # last ~20 min
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
    spot_5m = (base or {}).get("spot") or spot
    long_spots = [h["spot"] for h in long_hist if h.get("spot")]
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
    iv_5m = (base or {}).get("atmIV")
    iv_chg = (atm_iv - iv_5m) if (atm_iv and iv_5m) else 0.0
    g_ivpop = _clamp(iv_chg / IV_POP_PTS)
    if iv_chg >= 0.8:
        reasons.append(f"ATM IV {iv_chg:+.1f} in 5m")

    # --- straddle expansion / collapse ---
    str_5m = (base or {}).get("atmStraddle")
    str_pct = ((straddle - str_5m) / str_5m) if (straddle and str_5m) else 0.0
    g_straddle = _clamp(str_pct / STRADDLE_EXP)
    if str_pct >= 0.08:
        reasons.append(f"Straddle {str_pct * 100:+.0f}% in 5m")
    elif str_pct <= -0.12:
        reasons.append(f"Straddle {str_pct * 100:+.0f}% in 5m (pinning)")

    # --- gamma proximity: is ATM gamma*OI near its recent peak? ---
    gex_hist = [abs(h["atmGammaOI"]) for h in long_hist if h.get("atmGammaOI")]
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


def hot_strikes(store, symbol: str, chain: dict, limit: int = 2) -> list[dict]:
    """Near-ATM strikes whose OI moved unusually hard over the last ~15 min,
    biggest first. A leg qualifies only if the move is material to the whole
    chain, material to that strike, AND an outlier among its neighbours.
    Positive `chg` = OI build, negative = unwind."""
    expiry = chain.get("expiry")
    if not expiry:
        return []
    w = store.oi_change_window(symbol, expiry, OI_WINDOW_MIN)
    strikes = w.get("strikes") or {}
    if not strikes or w.get("baseTs") is None:
        return []
    mins = (w["curTs"] - w["baseTs"]) / 60
    # too little history to call anything a "move", or a stale base after a feed gap
    if mins < 3 or mins > 2 * OI_WINDOW_MIN:
        return []
    spot = chain.get("spot") or 0.0
    near = sorted(strikes, key=lambda k: abs(float(k) - spot))[: 2 * OI_NEAR_STRIKES + 1]
    legs = []
    for k in near:
        s = strikes[k]
        legs.append((float(k), "CE", s["ceOiChg"], s["ceOi"]))
        legs.append((float(k), "PE", s["peOiChg"], s["peOi"]))
    mags = sorted(abs(chg) for _, _, chg, _ in legs)
    median = mags[len(mags) // 2] if mags else 0.0
    totals = chain.get("totals") or {}
    out = []
    for strike, side, chg, oi in legs:
        base = oi - chg
        side_total = totals.get("ceOI" if side == "CE" else "peOI") or 0.0
        if not chg or base <= 0 or side_total <= 0:
            continue
        if abs(chg) < OI_MIN_TOTAL_PCT * side_total:
            continue
        if abs(chg) / base < OI_MIN_OWN_PCT:
            continue
        if abs(chg) < OI_STAND_OUT * median:
            continue
        out.append({
            "strike": strike, "side": side, "chg": chg, "oi": oi,
            "pct": 100 * chg / base, "mins": round(mins),
        })
    out.sort(key=lambda h: -abs(h["chg"]))
    return out[:limit]


def _fmt_hot(hot: list[dict]) -> str:
    if not hot:
        return ""
    parts = [f"{int(h['strike'])} {h['side']} {h['chg'] / 1e5:+.1f}L ({h['pct']:+.0f}%)" for h in hot]
    return f"OI {hot[0]['mins']}m: " + ", ".join(parts)


def _emit_alerts(store, row: dict, prev: dict | None, chain: dict | None = None) -> list[dict]:
    from .history_archive import in_session

    sym, sc = row["symbol"], row["score"]
    psc = (prev or {}).get("score", 0.0)
    fired: list[dict] = []

    def fire(kind: str, severity: str, message: str, dedup: float = 300) -> None:
        if store.recent_alert(sym, kind, dedup):
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

    hot_cache: list[list[dict]] = []

    def hot() -> list[dict]:
        if not hot_cache:
            hot_cache.append(hot_strikes(store, sym, chain) if chain else [])
        return hot_cache[0]

    def with_oi(msg: str) -> str:
        oi = _fmt_hot(hot())
        return f"{msg} · {oi}" if oi else msg

    tag = ", ".join(row["reasons"][:2]) or f"bias {row['bias']}"
    if sc >= 80 and psc < 80:
        fire("blast-crit", "critical", with_oi(f"{sym}: gamma-blast score {sc:.0f} — {tag}"))
    elif sc >= 60 and psc < 60:
        fire("blast-warn", "warning", with_oi(f"{sym}: gamma-blast building {sc:.0f} — {tag}"))
    elif BUILD_MIN_SCORE <= sc < 60 and in_session(row["ts"]):
        # "started building": the score has climbed fast AND a strike is seeing an
        # outsized OI move. Below 60 only -- from 60 up, warn/crit already cover it.
        ago = _at(store.get_scan_history(sym), row["ts"] - WIN_SHORT_S)
        rise = sc - ago["score"] if ago else 0.0
        if rise >= BUILD_MIN_RISE and hot():
            recent = sum(
                1 for a in store.get_alerts(200)
                if a["kind"] == "blast-build" and row["ts"] - a["ts"] < 600
            )
            if recent < BUILD_MAX_PER_10MIN:
                bias = "" if row["bias"] == "NEUTRAL" else f", bias {row['bias']}"
                fire(
                    "blast-build", "warning",
                    f"{sym}: gamma blast starting to build — score {sc:.0f} (+{rise:.0f} in 5m){bias} · {tag} · {_fmt_hot(hot())}",
                    dedup=BUILD_DEDUP_S,
                )
    if row["ivChg5m"] >= 2.0:
        fire("iv-spike", "warning", f"{sym}: ATM IV {row['ivChg5m']:+.1f} pts in 5m")
    if row["straddlePct5m"] >= 20:
        fire("straddle-exp", "warning", f"{sym}: ATM straddle {row['straddlePct5m']:+.0f}% in 5m")
    return fired


def run(store, extra: set[str] | None = None) -> dict:
    """Re-score every tracked symbol (watchlists + defaults, plus any symbol
    in `extra` -- e.g. AutoBot rule symbols, so a rule's blast_score
    condition sees a score even for a symbol not otherwise watched).
    Returns the sorted scan + any new alerts."""
    new_alerts: list[dict] = []
    for sym in store.all_symbols(extra=extra):
        chain = store.get_chain(sym)
        if not chain:
            continue
        prev = store.scan_results.get(sym)
        row = evaluate(sym, chain, store.get_history(sym))
        store.set_scan(sym, row)
        new_alerts += _emit_alerts(store, row, prev, chain)
    return {"scan": store.get_scan(), "newAlerts": new_alerts}
