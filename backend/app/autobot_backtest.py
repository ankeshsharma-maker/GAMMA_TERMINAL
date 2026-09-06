"""Daily-bar backtest for an AutoBot rule — indicator-first.

Reuses the live rule engine's condition evaluator (autobot._Ctx / eval_all /
eval_any) against a *synthetic* daily history:

  spot     = underlying daily close      <- upstox_data.fetch_underlying_candles
                                            (5y of bars, indices + BSE + F&O
                                             stocks; always populated)
  pcr      = daily put/call OI ratio     ]
  maxPain  = daily max-pain strike       ]  best-effort from
  ceOIChg  = day-over-day Call-OI change ]  upstox_data.fetch_history_chain
  peOIChg  = day-over-day Put-OI change  ]  (skipped if unavailable — the
                                            indicator conditions still run)

Indicator conditions (rsi / ema_cross / price_vs_ema / macd / spot_move_pct)
only need the spot series, so an indicator-only rule backtests over any date
range.  A warm-up slice of bars *before* from_date is fed to the evaluator so
RSI/EMA/MACD are fully seeded even for a short visible window.

Option P&L: on an entry signal, take the rule's instrument (ATM/OTM.. CE/PE)
at that day's premium and mark it daily until an exit.  Premiums come from
real historical option candles when the expiry's contracts still resolve
(recent ranges); otherwise from a Black-Scholes model (fixed IV, a synthetic
DTE that decays as the trade is held) so long indicator backtests still work.
"""
from __future__ import annotations

import asyncio
from datetime import datetime

from . import upstox_data
from .autobot import _Ctx, _entry_filter_ok, _resolve_instrument
from .brokers.upstox import get_upstox
from .greeks import bs_price

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


def _syn_premium(ot: str, spot: float, strike: float, held_days: int,
                 iv: float, dte: int) -> float:
    """Black-Scholes premium for the synthetic option model."""
    t = max(dte - held_days, 1) / 365.0
    return round(bs_price(ot, spot, strike, t, 0.06, 0.0, iv), 2)


async def backtest_rule(rule: dict, from_date: str, to_date: str) -> dict:
    symbol = (rule.get("symbol") or "NIFTY").upper()
    expiry = rule.get("_btExpiry") or ""
    syn_iv = _f(rule.get("_btIV"), 0.0) or 0.15
    syn_dte = int(_f(rule.get("_btDTE"), 30) or 30)

    ux = get_upstox()
    await ux.load_instruments()
    if not ux.underlying_key(symbol):
        raise RuntimeError(f"Upstox has no key for {symbol}")

    # 1. underlying daily candles — full history for indicator warm-up
    candles = await upstox_data.fetch_underlying_candles(symbol, 86400)
    if len(candles) < 40:
        raise RuntimeError(f"only {len(candles)} daily bars for {symbol} from Upstox")
    by_date: dict[str, float] = {}
    for c in candles:
        d = datetime.utcfromtimestamp(c["time"]).strftime("%Y-%m-%d")
        by_date[d] = _f(c["close"])
    all_dates = sorted(by_date)

    # keep ~90 bars of warm-up before from_date, cap the window at to_date
    win = [d for d in all_dates if from_date <= d <= to_date]
    if len(win) < 3:
        raise RuntimeError(
            f"only {len(win)} trading day(s) for {symbol} in {from_date}..{to_date}"
        )
    warm_start_i = max(0, all_dates.index(win[0]) - 90)
    dates = all_dates[warm_start_i : all_dates.index(win[-1]) + 1]
    first_tradable = win[0]

    # 2. best-effort daily chain history (pcr / maxPain / OI) keyed by date
    chain_by: dict[str, dict] = {}
    have_chain = False
    if not expiry:
        try:
            exps = await upstox_data.fetch_expiries(symbol)
            expiry = exps[0] if exps else ""
        except Exception:  # noqa: BLE001
            expiry = ""
    if expiry:
        try:
            hc = await upstox_data.fetch_history_chain(symbol, expiry, dates[0], to_date)
            rows = hc.get("series", [])
            prev_ce = prev_pe = None
            for r in rows:
                ce, pe = _f(r.get("ceOI")), _f(r.get("peOI"))
                chain_by[r["date"]] = {
                    "pcr": r.get("pcr"), "maxPain": r.get("maxPain"),
                    "ceOIChg": 0.0 if prev_ce is None else ce - prev_ce,
                    "peOIChg": 0.0 if prev_pe is None else pe - prev_pe,
                }
                prev_ce, prev_pe = ce, pe
            have_chain = len(rows) >= 6
        except Exception:  # noqa: BLE001
            have_chain = False

    step = _STEP.get(symbol, 50)
    lot = _LOT.get(symbol, 1)

    hist: list[dict] = []
    for d in dates:
        row = {"t": datetime.strptime(d, "%Y-%m-%d").timestamp(), "spot": by_date[d]}
        row.update(chain_by.get(d, {}))
        hist.append(row)

    # 3. real historical option closes for strikes we might touch (best effort)
    closes: dict[tuple, dict] = {}
    if expiry:
        atm_range = set()
        for d in win:
            base = round(by_date[d] / step) * step
            for i in range(-3, 4):
                atm_range.add(base + i * step)
        try:
            key = ux.underlying_key(symbol)
            chain = await ux.get(
                "/option/chain",
                {"instrument_key": key, "expiry_date": upstox_data._nse_to_iso(expiry)},
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
                        return (k, ot), {
                            c[0][:10]: _f(c[4])
                            for c in h.get("data", {}).get("candles", []) or []
                        }
                    except Exception:  # noqa: BLE001
                        return (k, ot), {}

            closes = dict(await asyncio.gather(*[_one(k, ot, ik) for (k, ot), ik in ik_by.items()]))
        except Exception:  # noqa: BLE001
            closes = {}

    real_hits = syn_hits = 0

    def _premium(k: float, ot: str, d: str, spot: float, held: int) -> float:
        nonlocal real_hits, syn_hits
        px = closes.get((k, ot), {}).get(d)
        if px is not None and px > 0:
            real_hits += 1
            return px
        syn_hits += 1
        return _syn_premium(ot, spot, k, held, syn_iv, syn_dte)

    # 4. walk the days
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

    for i, d in enumerate(dates):
        if d < first_tradable and not open_pos:
            continue
        ctx = _Ctx(symbol, hist[: i + 1])

        if open_pos:
            k, ot, ep, edate, ei = (
                open_pos["k"], open_pos["ot"], open_pos["entry"],
                open_pos["date"], open_pos["i"],
            )
            px = _premium(k, ot, d, by_date[d], i - ei)
            spct = (px - ep) / ep * 100.0 * sign if ep else 0.0
            open_pos["peak"] = max(open_pos["peak"], spct)
            reason = None
            if sl is not None and spct <= -abs(sl):
                reason = f"SL {sl:.0f}%"
            elif tp is not None and spct >= abs(tp):
                reason = f"target {tp:.0f}%"
            elif trl > 0 and open_pos["peak"] >= trl_arm and spct <= open_pos["peak"] - trl:
                reason = f"trail ({open_pos['peak']:.0f}%→{spct:.0f}%)"
            elif exit_conds and ctx.eval_conds(exit_conds, rule.get("exitLogic", "any")):
                reason = "exit signal"
            elif i == len(dates) - 1:
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
        if sum(1 for t in trades if t["entryDate"] == d) >= max_pd:
            continue
        if not ctx.eval_conds(entry_conds, rule.get("entryLogic", "all")):
            continue
        base = round(by_date[d] / step) * step
        strike, ot = _resolve_instrument(rule.get("instrument", "ATM_CE"), base, step)
        px = _premium(strike, ot, d, by_date[d], 0)
        if px <= 0:
            continue
        ef_ok, _ = _entry_filter_ok(rule.get("entryFilter") or {}, px, 0.5, 0.0, 0.0)
        if not ef_ok:
            continue
        open_pos = {"k": strike, "ot": ot, "entry": px, "date": d, "peak": 0.0, "i": i}

    # 5. stats
    pnls = [t["pnlRs"] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    equity, run, peak, max_dd = [], 0.0, 0.0, 0.0
    for p in pnls:
        run += p
        equity.append(run)
        peak = max(peak, run)
        max_dd = min(max_dd, run - peak)

    pricing = "historical" if syn_hits == 0 else "synthetic" if real_hits == 0 else "mixed"
    return {
        "symbol": symbol, "expiry": expiry or None, "from": from_date, "to": to_date,
        "instrument": rule.get("instrument"), "side": side, "lots": rule.get("lots", 1),
        "lot": lot, "days": len(win),
        "pricing": pricing, "hasChain": have_chain,
        "synIV": round(syn_iv, 3), "synDTE": syn_dte,
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
