"""Daily-bar backtest for an AutoBot rule.

Reuses the live rule engine's condition evaluator (autobot._Ctx / eval_all)
by feeding it a *synthetic* daily history built from Upstox:

  spot     = underlying daily close
  pcr      = daily put/call OI ratio       ]  from upstox_data.fetch_history_chain
  maxPain  = daily max-pain strike         ]
  ceOIChg  = day-over-day total Call-OI change
  peOIChg  = day-over-day total Put-OI change

Conditions that need series we don't have historically (net GEX, gamma flip,
IV skew, intraday-only kinds like opening_range / vol_surge) simply never
fire — a daily backtest can't model them.

Trades: on an entry signal, enter the rule's instrument (ATM/OTM.. CE/PE) at
that day's option close; each following day mark the premium and exit on the
rule's exit conditions, slPct, targetPct or a trailing stop.
"""
from __future__ import annotations

import asyncio
from datetime import datetime

from . import upstox_data
from .autobot import _Ctx, _resolve_instrument
from .brokers.upstox import get_upstox

_STEP = {
    "NIFTY": 50, "BANKNIFTY": 100, "FINNIFTY": 50, "MIDCPNIFTY": 25,
    "NIFTYNXT50": 50, "SENSEX": 100, "BANKEX": 100,
}
_LOT = {
    "NIFTY": 75, "BANKNIFTY": 30, "FINNIFTY": 65, "MIDCPNIFTY": 120,
    "NIFTYNXT50": 25, "SENSEX": 20, "BANKEX": 30,
}


def _f(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


async def backtest_rule(rule: dict, from_date: str, to_date: str) -> dict:
    symbol = (rule.get("symbol") or "NIFTY").upper()
    expiry = rule.get("_btExpiry") or ""       # optional: which expiry's chain to price from
    ux = get_upstox()
    if not ux.instrument_key(symbol):
        raise RuntimeError(f"Upstox has no key for {symbol} (index symbols only)")

    # 1. daily chain history -> pcr / maxPain / OI  +  underlying spot
    if not expiry:
        exps = await upstox_data.fetch_expiries(symbol)
        expiry = exps[0] if exps else ""
    hc = await upstox_data.fetch_history_chain(symbol, expiry, from_date, to_date)
    rows = hc.get("series", [])
    if len(rows) < 6:
        raise RuntimeError(
            f"only {len(rows)} day(s) of history for {symbol} {expiry} in that range — "
            "an expiry's option contracts only trade for a few weeks, so keep the range "
            "recent (or pick a monthly expiry for a longer window)"
        )

    step = _STEP.get(symbol, 50)
    lot = _LOT.get(symbol, 1)

    # synthetic daily history in store.history's shape
    hist: list[dict] = []
    prev_ce = prev_pe = None
    for r in rows:
        ce, pe = _f(r.get("ceOI")), _f(r.get("peOI"))
        hist.append({
            "t": datetime.strptime(r["date"], "%Y-%m-%d").timestamp(),
            "spot": _f(r.get("spot")),
            "pcr": r.get("pcr"),
            "maxPain": r.get("maxPain"),
            "ceOIChg": 0.0 if prev_ce is None else ce - prev_ce,
            "peOIChg": 0.0 if prev_pe is None else pe - prev_pe,
        })
        prev_ce, prev_pe = ce, pe

    dates = [r["date"] for r in rows]

    # 2. option daily closes for every strike we might touch (ATM +/- 3 steps,
    #    both CE & PE) — fetch once, index by (strike, ot, date)
    atm_range = set()
    for h in hist:
        base = round(h["spot"] / step) * step
        for i in range(-3, 4):
            atm_range.add(base + i * step)
    key = ux.instrument_key(symbol)
    chain = await ux.get(
        "/option/chain", {"instrument_key": key, "expiry_date": upstox_data._nse_to_iso(expiry)}
    )
    ik_by = {}
    for r in chain.get("data", []) or []:
        k = _f(r.get("strike_price"))
        if k in atm_range:
            for ot, obj in (("CE", r.get("call_options")), ("PE", r.get("put_options"))):
                ik = (obj or {}).get("instrument_key")
                if ik:
                    ik_by[(k, ot)] = ik

    sem = asyncio.Semaphore(10)

    async def _one(k, ot, ik):
        async with sem:
            try:
                h = await ux.get(f"/historical-candle/{ik}/day/{to_date}/{from_date}")
                return (k, ot), {c[0][:10]: _f(c[4]) for c in h.get("data", {}).get("candles", []) or []}
            except Exception:  # noqa: BLE001
                return (k, ot), {}

    closes = dict(await asyncio.gather(*[_one(k, ot, ik) for (k, ot), ik in ik_by.items()]))

    # 3. walk the days
    side = (rule.get("side") or "BUY").upper()
    sign = 1 if side == "BUY" else -1
    sl = _f(rule.get("slPct")) if rule.get("slPct") not in (None, "") else None
    tp = _f(rule.get("targetPct")) if rule.get("targetPct") not in (None, "") else None
    trl = _f(rule.get("trailPct") or 0)
    trl_arm = _f(rule.get("trailArmPct") or 0)
    max_pd = int(rule.get("maxTradesPerDay", 3) or 3)
    cooldown_d = 1 if _f(rule.get("cooldownMin") or 0) > 0 else 0
    entry_conds = rule.get("entry", [])
    exit_conds = rule.get("exit", [])

    trades: list[dict] = []
    open_pos = None
    cooldown_until = -1
    warm = 5

    for i in range(warm, len(hist)):
        d = dates[i]
        px_ctx = _Ctx(symbol, hist[: i + 1])

        if open_pos:
            k, ot, ep, edate = open_pos["k"], open_pos["ot"], open_pos["entry"], open_pos["date"]
            px = closes.get((k, ot), {}).get(d)
            if px is None:
                continue
            spct = (px - ep) / ep * 100.0 * sign
            open_pos["peak"] = max(open_pos["peak"], spct)
            reason = None
            if sl is not None and spct <= -abs(sl):
                reason = f"SL {sl:.0f}%"
            elif tp is not None and spct >= abs(tp):
                reason = f"target {tp:.0f}%"
            elif trl > 0 and open_pos["peak"] >= trl_arm and spct <= open_pos["peak"] - trl:
                reason = f"trail ({open_pos['peak']:.0f}%→{spct:.0f}%)"
            elif exit_conds and px_ctx.eval_any(exit_conds):
                reason = "exit signal"
            elif i == len(hist) - 1:
                reason = "range end"
            if reason:
                pnl_rs = round((px - ep) * sign * int(rule.get("lots", 1)) * lot, 0)
                trades.append({
                    "entryDate": edate, "exitDate": d, "strike": k, "ot": ot,
                    "side": side, "entryPx": round(ep, 2), "exitPx": round(px, 2),
                    "pnlPct": round(spct, 1), "pnlRs": pnl_rs, "reason": reason,
                })
                open_pos = None
                cooldown_until = i + cooldown_d
            continue

        if i <= cooldown_until:
            continue
        tt = sum(1 for t in trades if t["entryDate"] == d)
        if tt >= max_pd:
            continue
        if not px_ctx.eval_all(entry_conds):
            continue
        base = round(hist[i]["spot"] / step) * step
        strike, ot = _resolve_instrument(rule.get("instrument", "ATM_CE"), base, step)
        px = closes.get((strike, ot), {}).get(d)
        if px is None or px <= 0:
            continue
        open_pos = {"k": strike, "ot": ot, "entry": px, "date": d, "peak": 0.0}

    # 4. stats
    pnls = [t["pnlRs"] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    equity = []
    run = 0.0
    peak = 0.0
    max_dd = 0.0
    for p in pnls:
        run += p
        equity.append(run)
        peak = max(peak, run)
        max_dd = min(max_dd, run - peak)
    return {
        "symbol": symbol, "expiry": expiry, "from": from_date, "to": to_date,
        "instrument": rule.get("instrument"), "side": side, "lots": rule.get("lots", 1),
        "lot": lot, "days": len(hist),
        "trades": trades,
        "equity": equity,
        "summary": {
            "total": round(sum(pnls), 0),
            "count": len(trades),
            "wins": len(wins),
            "losses": len(losses),
            "winRate": round(len(wins) / len(trades) * 100, 1) if trades else 0.0,
            "avgWin": round(sum(wins) / len(wins), 0) if wins else 0.0,
            "avgLoss": round(sum(losses) / len(losses), 0) if losses else 0.0,
            "profitFactor": round(sum(wins) / abs(sum(losses)), 2) if losses and sum(losses) else None,
            "maxDrawdown": round(max_dd, 0),
        },
    }
