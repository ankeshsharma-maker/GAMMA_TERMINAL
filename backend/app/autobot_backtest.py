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

Every position is stepped through `autobot_sim.SimPosition`, which asks the live engine's own
exit code (`autobot_exit`) what to do -- so stop, breakeven, trail, target and scale-out behave
here exactly as they do with real money. Intraday bars are judged on their high / low as well
as their close (a stop touched inside a bar exits at the stop, and beats a target hit in the
same bar). An intraday (non-positional) rule is always flat by the end of its trading day, at
every timeframe: the bar that contains the square-off time (or the day's last bar) closes it. Results are net of estimated brokerage / STT / exchange charges and slippage
(`charges.py`; switch off or tune with the `costs` argument), and the trade-count safety gates
(weekly cap, losing-streak pause, per-rule loss cap) are replayed.

Option P&L: on an entry signal, take the rule's instrument (ATM/OTM.. CE/PE)
at that day's premium and mark it daily until an exit.  Premiums come from
real historical option candles when the expiry's contracts still resolve
(recent ranges); otherwise from a Black-Scholes model (fixed IV, a synthetic
DTE that decays as the trade is held) so long indicator backtests still work.
"""
from __future__ import annotations

import asyncio
import math
from datetime import datetime

from . import autobot_exit as X
from . import autobot_groups as G
from . import autobot_structures as ST
from . import charges as chg
from . import nse_bhavcopy, upstox_data
from .autobot import _Ctx, _entry_filter_ok, _parse_hhmm, _resolve_instrument
from .autobot_sim import SimPosition
from .autobot_stats import summarize
from .brokers.upstox import get_upstox
from .charting import bucket_start
from .greeks import bs_price
from .processing import IST, lot_size

_STEP = {
    "NIFTY": 50, "BANKNIFTY": 100, "FINNIFTY": 50, "MIDCPNIFTY": 25,
    "NIFTYNXT50": 50, "SENSEX": 100, "BANKEX": 100,
}
# condition kinds that need reconstructed historical Greeks/GEX (see
# upstox_data.fetch_history_greeks) -- gated separately from the cheap
# pcr/maxPain fetch below since this one does real IV-solving + a second
# full round of Upstox calls, so only pay for it when a rule actually uses it.
_GREEK_KINDS = {"gamma_flip", "net_gex", "delta_change", "gamma_change", "gamma_vs_delta"}


def _rule_uses_greeks(rule: dict) -> bool:
    conds = list(rule.get("entry") or []) + list(rule.get("exit") or [])
    return any((c or {}).get("kind") in _GREEK_KINDS for c in conds)


def _f(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def _syn_premium(ot: str, spot: float, strike: float, held_days: float,
                 iv: float, dte: int) -> float:
    """Black-Scholes premium for the synthetic option model."""
    t = max(dte - held_days, 0.02) / 365.0
    return round(bs_price(ot, spot, strike, t, 0.06, 0.0, iv), 2)


def _resample(cands: list[dict], interval_s: int) -> list[dict]:
    """Bucket 1-minute candles up to `interval_s`."""
    if interval_s <= 60 or not cands:
        return cands
    buckets: dict[int, dict] = {}
    for c in cands:
        b = bucket_start(c["time"], interval_s)
        cur = buckets.get(b)
        if cur is None:
            buckets[b] = {
                "time": b, "open": c["open"], "high": c["high"],
                "low": c["low"], "close": c["close"], "volume": c.get("volume", 0.0),
            }
        else:
            cur["high"] = max(cur["high"], c["high"])
            cur["low"] = min(cur["low"], c["low"])
            cur["close"] = c["close"]
            cur["volume"] = cur.get("volume", 0.0) + c.get("volume", 0.0)
    return [buckets[k] for k in sorted(buckets)]


def _costs_cfg(costs: dict | None) -> dict:
    """Backtest cost model. On by default: a backtest that ignores brokerage, STT and the
    bid-ask spread flatters every rule, and the flattery is worst for the frequent,
    small-premium trades AutoBot tends to take."""
    c = costs or {}
    return {
        "enabled": bool(c.get("enabled", True)),
        "slippagePct": _f(c.get("slippagePct"), chg.DEFAULT_SLIPPAGE_PCT) if c.get("slippagePct") not in (None, "") else chg.DEFAULT_SLIPPAGE_PCT,
        "brokerage": _f(c.get("brokerage"), chg.BROKERAGE_PER_ORDER) if c.get("brokerage") not in (None, "") else chg.BROKERAGE_PER_ORDER,
    }


def _round_trip_costs(cfg: dict, side: str, base: float, lots: int, lot: int,
                      fills: list[tuple[int, float]]) -> tuple[float, float]:
    """(charges, slippage) in rupees for a finished trade: one entry order at `base`, and every
    closing fill (lots, premium). Both are zero when the cost model is switched off."""
    if not cfg["enabled"]:
        return 0.0, 0.0
    exit_side = "SELL" if side == "BUY" else "BUY"
    entry_q = lots * lot
    charges = chg.order_charges(base * entry_q, side, brokerage=cfg["brokerage"])
    slip = base * entry_q * cfg["slippagePct"] / 100.0
    for n, px in fills:
        q = n * lot
        charges += chg.order_charges(px * q, exit_side, brokerage=cfg["brokerage"])
        slip += px * q * cfg["slippagePct"] / 100.0
    return charges, slip


def _struct_meta(pos: dict) -> dict:
    """Extra trade-row fields for a multi-leg structure."""
    if not pos.get("legs"):
        return {}
    return {
        "structure": pos["structure"], "label": ST.label(pos["structure"], pos["legs"]),
        "legs": [{"ot": lg["ot"], "strike": lg["strike"], "side": lg["side"]} for lg in pos["legs"]],
    }


def _trade_of(sim, px: float) -> dict:
    """The open trade as the trade_stoploss / trade_target exit conditions see it. Judged on the bar's
    CLOSE premium (they are conditions, so like every other exit signal they act at the close; the
    fixed SL / target boxes are the ones that also catch a touch inside the bar)."""
    return {"buy": sim.buy, "base": sim.base, "ltp": px, "qty": sim.qty}


def _pos_px(pos: dict, price_fn) -> tuple[float, list[float]]:
    """Current premium of a position on the footing autobot_exit expects, plus each leg's price.
    A structure's value is its net; a credit structure reports what it would cost to close."""
    if pos.get("legs"):
        prices = [price_fn(lg["strike"], lg["ot"]) for lg in pos["legs"]]
        net = ST.net_premium(pos["legs"], prices)
        return (net if pos["side"] == "BUY" else -net), prices
    px = price_fn(pos["k"], pos["ot"])
    return px, [px]


def _leg_costs(cfg: dict, pos: dict, exit_prices: list[float] | None, lots: int, lot: int):
    """(charges, slippage) for a structure, leg by leg: each leg is its own order both ways, and
    the STT / stamp duty depend on each leg's own side. None for a single option."""
    if not pos.get("legs") or exit_prices is None:
        return None
    if not cfg["enabled"]:
        return 0.0, 0.0
    charges = slip = 0.0
    for lg, ep, xp in zip(pos["legs"], pos["entry_px"], exit_prices):
        q = lots * lot * int(lg.get("mult", 1))
        exit_side = "SELL" if lg["side"] == "BUY" else "BUY"
        charges += chg.order_charges(ep * q, lg["side"], brokerage=cfg["brokerage"])
        charges += chg.order_charges(xp * q, exit_side, brokerage=cfg["brokerage"])
        # a leg's spread doesn't grow with its intrinsic value: a wing that finishes deep in the
        # money is priced for slippage at no more than twice what it cost to open
        slip += (ep + min(xp, 2.0 * ep)) * q * cfg["slippagePct"] / 100.0
    return charges, slip


def _finish_trade(*, rule_side: str, base: float, lots: int, lot: int, ev: dict, sim, cfg: dict,
                  meta: dict, hold_min: float | None, leg_costs=None) -> dict:
    """One row per ROUND TRIP (a trade that scaled out is one trade)."""
    gross = ev["gross"]
    charges, slip = leg_costs if leg_costs is not None else _round_trip_costs(cfg, rule_side, base, lots, lot, sim.fills)
    net = gross - charges - slip
    invested = base * lots * lot
    return {
        **meta,
        "side": rule_side, "lots": lots, "entryPx": round(base, 2),
        "exitPx": round(ev["px"], 2), "reason": ev["reason"], "scaled": len(sim.fills) > 1,
        "pnlPct": round(gross / invested * 100.0, 1) if invested else 0.0,
        "grossRs": round(gross, 0), "chargesRs": round(charges, 0), "slippageRs": round(slip, 0),
        "pnlRs": round(net, 0), "holdMin": None if hold_min is None else round(hold_min, 1),
    }


def _summarize_trades(trades: list[dict]) -> tuple[dict, list[float]]:
    pnls = [t["pnlRs"] for t in trades]
    s = summarize(
        pnls,
        holds_min=[t.get("holdMin") for t in trades],
        reasons=[t["reason"] for t in trades],
        days=[t["exitDate"] for t in trades],
    )
    s["grossTotal"] = round(sum(t["grossRs"] for t in trades), 0)
    s["chargesTotal"] = round(sum(t["chargesRs"] for t in trades), 0)
    s["slippageTotal"] = round(sum(t["slippageRs"] for t in trades), 0)
    return s, s["equity"]


class _Gates:
    """The engine's trade-history safety gates, replayed in a backtest so a rule with a weekly
    cap or a loss-streak stop is tested the way it will actually run. (The DTE gate and the
    spread guard need a real expiry / real quotes, which a backtest doesn't have.)"""

    def __init__(self, rule: dict):
        self.week_cap = int(_f(rule.get("maxTradesPerWeek"), 0) or 0)
        self.streak_cap = int(_f(rule.get("maxConsecLosses"), 0) or 0)
        self.loss_cap = abs(_f(rule.get("ruleMaxLoss"), 0.0))
        self.week_count: dict[str, int] = {}
        self.day_pnl: dict[str, float] = {}
        self.day_streak: dict[str, int] = {}
        self.paused_days: set[str] = set()

    @staticmethod
    def week_of(day: str) -> str:
        y, w, _ = datetime.strptime(day, "%Y-%m-%d").isocalendar()
        return f"{y}-W{w:02d}"

    def allows(self, day: str) -> bool:
        if day in self.paused_days:
            return False
        return not (self.week_cap and self.week_count.get(self.week_of(day), 0) >= self.week_cap)

    def opened(self, day: str) -> None:
        wk = self.week_of(day)
        self.week_count[wk] = self.week_count.get(wk, 0) + 1

    def closed(self, day: str, gross: float) -> None:
        self.day_pnl[day] = self.day_pnl.get(day, 0.0) + gross
        self.day_streak[day] = self.day_streak.get(day, 0) + 1 if gross < 0 else 0
        if (self.streak_cap and self.day_streak[day] >= self.streak_cap) or (
            self.loss_cap and self.day_pnl[day] <= -self.loss_cap
        ):
            self.paused_days.add(day)


def _not_simulated(rule: dict, interval: int | None = None) -> list[str]:
    out = []
    if interval and interval >= 900 and str(rule.get("holdType", "intraday")).lower() != "positional":
        m = interval // 60
        sq = rule.get("squareOff")
        out.append(
            f"intraday square-off at {sq} is applied at the close of the {m}-minute bar that contains it, so it can fire up to {m} minutes late"
            if sq else f"intraday trades are closed at the close of each day's last {m}-minute bar"
        )
    if rule.get("minDte") not in (None, "") or rule.get("maxDte") not in (None, ""):
        out.append("days-to-expiry gate (a backtest has no real expiry calendar)")
    if _f(rule.get("maxSpreadPct"), 0.0) > 0:
        out.append("spread guard (no historical quotes)")
    if any((c or {}).get("kind") in X.TRADE_KINDS for c in (rule.get("exit") or [])):
        out.append("trade stop-loss / target conditions are judged at each bar's close, not on a touch inside it "
                   "(the SL / target boxes do catch touches inside a bar)")
    return out



async def backtest_rule(
    rule: dict, from_date: str, to_date: str, interval: int = 86400, bars: int = 0,
    costs: dict | None = None,
) -> dict:
    if interval and interval < 86400:
        return await _backtest_intraday(rule, from_date, to_date, int(interval), int(bars or 0), costs)
    symbol = (rule.get("symbol") or "NIFTY").upper()
    expiry = rule.get("_btExpiry") or ""
    syn_iv = _f(rule.get("_btIV"), 0.0) or 0.15
    syn_dte = int(_f(rule.get("_btDTE"), 30) or 30)

    ux = get_upstox()
    await ux.load_instruments()
    if not ux.underlying_key(symbol):
        raise RuntimeError(f"Upstox has no key for {symbol}")

    # 1. underlying daily candles — full history for indicator warm-up.
    # retry with backoff — Upstox rate-limits the historical endpoint and
    # returns an empty list when throttled.
    candles = await upstox_data.fetch_underlying_candles(symbol, 86400)
    for wait in (3, 6, 10):
        if len(candles) >= 40:
            break
        await asyncio.sleep(wait)
        candles = await upstox_data.fetch_underlying_candles(symbol, 86400)
    if len(candles) < 40:
        raise RuntimeError(
            f"only {len(candles)} daily bars for {symbol} from Upstox — likely rate-limited, "
            "wait ~30s and re-run"
        )
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

    # 2b. Greeks/GEX history (gamma_flip / net_gex / delta_change / gamma_change / gamma_vs_delta)
    # -- only fetched when the rule actually uses one of these, since this does
    # real Black-Scholes IV-solving plus a real round of network calls either way.
    #
    # Preferred source: NSE's own bhavcopy (nse_bhavcopy) -- one real chain per
    # day, correctly using whichever expiry was actually front-week that day,
    # with no dependence on a contract still being listed today. Falls back to
    # the Upstox same-expiry approximation only for symbols bhavcopy doesn't
    # cover (BSE names) or if the bhavcopy fetch comes up short.
    have_greeks = False
    if _rule_uses_greeks(rule):
        try:
            hg = await nse_bhavcopy.fetch_bhavcopy_greeks(symbol, dates[0], to_date)
            rows_g = hg.get("series", [])
            if len(rows_g) < 6 and expiry:
                if have_chain:
                    # The pcr/maxPain fetch above just made ~120 historical-candle
                    # requests to the same Upstox endpoint this one uses. Measured
                    # empirically against production: back-to-back, every single
                    # leg in this second wave gets rate-limited and silently
                    # returns [] (no exception anywhere); a 15s gap was the first
                    # one that reliably recovered, so 20s is used here for margin.
                    await asyncio.sleep(20)
                hg = await upstox_data.fetch_history_greeks(symbol, expiry, dates[0], to_date)
                rows_g = hg.get("series", [])
            for r in rows_g:
                chain_by.setdefault(r["date"], {}).update({
                    k: r.get(k) for k in
                    ("netGex", "gammaFlip", "atmCEDelta", "atmCEGamma", "atmPEDelta", "atmPEGamma")
                })
            have_greeks = len(rows_g) >= 6
        except Exception:  # noqa: BLE001
            have_greeks = False

    step = _STEP.get(symbol, 50)
    lot = lot_size(symbol)

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
                        h = await ux.get(f"/historical-candle/{ik}/days/1/{to_date}/{from_date}", v3=True)
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
    buy = side == "BUY"
    if ST.is_structure(rule):   # a structure has no single side and doesn't scale out (see autobot_structures)
        rule = {**rule, "target1Pct": 0}
    lots0 = int(rule.get("lots", 1) or 1)
    cfg = _costs_cfg(costs)
    gates = _Gates(rule)
    positional = str(rule.get("holdType", "intraday")).lower() == "positional"
    max_pd = int(rule.get("maxTradesPerDay", 3) or 3)
    cooldown_d = 1 if _f(rule.get("cooldownMin") or 0) > 0 else 0
    entry_conds = rule.get("entry", [])
    exit_conds = rule.get("exit", [])
    entry_logic, entry_groups = G.spec(rule, "entry")
    exit_logic, exit_groups = G.spec(rule, "exit")

    trades: list[dict] = []
    open_pos = None
    cooldown_until = -1

    def _close(pos: dict, ev: dict, d: str, exit_prices: list[float] | None = None) -> None:
        nonlocal open_pos, cooldown_until
        t = _finish_trade(
            rule_side=pos["side"], base=pos["entry"], lots=lots0, lot=lot, ev=ev, sim=pos["sim"], cfg=cfg,
            meta={"entryDate": pos["date"], "exitDate": d, "strike": pos["k"], "ot": pos["ot"], **_struct_meta(pos)},
            hold_min=None, leg_costs=_leg_costs(cfg, pos, exit_prices, lots0, lot),
        )
        trades.append(t)
        gates.closed(d, t["grossRs"])
        open_pos = None

    for i, d in enumerate(dates):
        if d < first_tradable and not open_pos:
            continue
        ctx = _Ctx(symbol, hist[: i + 1])  # daily bars -- entryTf resample n/a
        last = i == len(dates) - 1

        if open_pos:
            ei = open_pos["i"]
            px, leg_px = _pos_px(open_pos, lambda k, ot: _premium(k, ot, d, by_date[d], i - ei))
            sig = bool(exit_conds) and ctx.eval_conds(exit_conds, exit_logic, trade=_trade_of(open_pos["sim"], px), groups=exit_groups)
            evs = open_pos["sim"].step(px, exit_signal=sig)
            if not open_pos["sim"].closed and last:
                evs += open_pos["sim"].force_close(px, "range end")
            fin = next((e for e in evs if e["kind"] == "exit"), None)
            if fin:
                _close(open_pos, fin, d, leg_px)
                cooldown_until = i + cooldown_d
            continue

        if i <= cooldown_until:
            continue
        if sum(1 for t in trades if t["entryDate"] == d) >= max_pd:
            continue
        if not gates.allows(d):
            continue
        if not ctx.eval_conds(entry_conds, entry_logic, groups=entry_groups):
            continue
        base = round(by_date[d] / step) * step
        legs, entry_px_legs = None, None
        if ST.is_structure(rule):
            legs = ST.legs_for(rule["structure"], base, step, rule.get("offset"), rule.get("width"))
            entry_px_legs = [_premium(lg["strike"], lg["ot"], d, by_date[d], 0) for lg in legs]
            if any(p <= 0 for p in entry_px_legs):
                continue
            net = ST.net_premium(legs, entry_px_legs)
            if net == 0:
                continue
            strike, ot, px, pos_side = base, "STR", abs(net), ("BUY" if net > 0 else "SELL")
            ef_use = {k: v for k, v in (rule.get("entryFilter") or {}).items() if k in ("premOp", "premVal", "premTol")}
        else:
            strike, ot = _resolve_instrument(rule.get("instrument", "ATM_CE"), base, step)
            px = _premium(strike, ot, d, by_date[d], 0)
            pos_side, ef_use = side, (rule.get("entryFilter") or {})
        if px <= 0:
            continue
        ef_ok, _ = _entry_filter_ok(ef_use, px, 0.5, 0.0, 0.0)
        if not ef_ok:
            continue
        gates.opened(d)
        if positional:
            open_pos = {
                "k": strike, "ot": ot, "entry": px, "date": d, "i": i, "side": pos_side,
                "sim": SimPosition(rule, buy=(pos_side == "BUY"), base=px, lots=lots0, lot_size=lot),
                **({"legs": legs, "structure": rule["structure"], "entry_px": entry_px_legs} if legs else {}),
            }
        else:
            # Intraday: a daily bar is a single end-of-day price, so there's no way to simulate an
            # intraday square-off -- the position can never be allowed to carry into the next day's
            # bar. Close it same-day at the same price (this validates WHEN the entry signal fires,
            # not intraday P&L -- use an intraday timeframe above for that). It is not charged: it
            # isn't a real trade, and a fee on a made-up round trip would only add noise.
            trades.append({
                "entryDate": d, "exitDate": d, "strike": strike, "ot": ot, "side": side, "lots": lots0,
                "entryPx": round(px, 2), "exitPx": round(px, 2), "pnlPct": 0.0, "pnlRs": 0, "grossRs": 0,
                "chargesRs": 0, "slippageRs": 0, "holdMin": None, "scaled": False,
                "reason": "square-off (daily-bar)",
            })
            cooldown_until = i + cooldown_d

    summary, equity = _summarize_trades(trades)
    pricing = "historical" if syn_hits == 0 else "synthetic" if real_hits == 0 else "mixed"
    return {
        "symbol": symbol, "expiry": expiry or None, "from": from_date, "to": to_date,
        "instrument": rule.get("structure") if ST.is_structure(rule) else rule.get("instrument"), "side": side, "lots": rule.get("lots", 1),
        "lot": lot, "days": len(win),
        "pricing": pricing, "hasChain": have_chain, "hasGreeksHistory": have_greeks,
        "synIV": round(syn_iv, 3), "synDTE": syn_dte,
        "costs": cfg, "notSimulated": _not_simulated(rule),
        "trades": trades,
        "equity": equity,
        "summary": summary,
    }



# --------------------------------------------------------------------------
# intraday backtest — indicator-only, synthetic premiums, N candles at a
# chosen timeframe (1m / 5m / 15m / 30m / 1h)
# --------------------------------------------------------------------------
async def _backtest_intraday(
    rule: dict, from_date: str, to_date: str, interval: int, bars: int, costs: dict | None = None
) -> dict:
    symbol = (rule.get("symbol") or "NIFTY").upper()
    syn_iv = _f(rule.get("_btIV"), 0.0) or 0.15
    syn_dte = int(_f(rule.get("_btDTE"), 30) or 30)

    ux = get_upstox()
    await ux.load_instruments()
    if not ux.underlying_key(symbol):
        raise RuntimeError(f"Upstox has no key for {symbol}")

    raw = await upstox_data.fetch_underlying_candles(symbol, interval)
    for wait in (3, 6, 10):
        if len(raw) >= 30:
            break
        await asyncio.sleep(wait)
        raw = await upstox_data.fetch_underlying_candles(symbol, interval)
    cands = _resample(raw, interval)
    if len(cands) < 30:
        raise RuntimeError(
            f"only {len(cands)} intraday candles for {symbol} at {interval//60}m "
            "— Upstox intraday history is ~25 days; pick a wider timeframe or fewer bars"
        )

    def _dstr(ts: int) -> str:
        return datetime.fromtimestamp(ts, IST).strftime("%Y-%m-%d")

    in_win = [c for c in cands if from_date <= _dstr(c["time"]) <= to_date]
    if bars > 0:
        in_win = in_win[-bars:]
    if len(in_win) < 3:
        raise RuntimeError(
            f"only {len(in_win)} candle(s) for {symbol} in {from_date}..{to_date} at "
            f"{interval//60}m"
        )
    first_ts = in_win[0]["time"]
    warm_i = next((i for i, c in enumerate(cands) if c["time"] >= first_ts), 0)
    series = cands[max(0, warm_i - 150) : cands.index(in_win[-1]) + 1]

    step = _STEP.get(symbol, 50)
    lot = lot_size(symbol)
    hist = [{"t": c["time"], "spot": c["close"], "o": c["open"], "h": c["high"], "l": c["low"], "c": c["close"]} for c in series]

    side = (rule.get("side") or "BUY").upper()
    buy = side == "BUY"
    if ST.is_structure(rule):
        rule = {**rule, "target1Pct": 0}
    lots0 = int(rule.get("lots", 1) or 1)
    cfg = _costs_cfg(costs)
    gates = _Gates(rule)
    positional = str(rule.get("holdType", "intraday")).lower() == "positional"
    max_pd = int(rule.get("maxTradesPerDay", 3) or 3)
    cd_bars = max(0, math.ceil(_f(rule.get("cooldownMin") or 0) * 60 / interval))
    sq = _parse_hhmm(rule.get("squareOff"))
    neb = _parse_hhmm(rule.get("noEntryBefore"))
    nea = _parse_hhmm(rule.get("noEntryAfter"))
    entry_conds, exit_conds = rule.get("entry", []), rule.get("exit", [])
    entry_logic, entry_groups = G.spec(rule, "entry")
    exit_logic, exit_groups = G.spec(rule, "exit")

    trades: list[dict] = []
    open_pos = None
    cd_until = -1
    day_count: dict[str, int] = {}

    def _clock(ts: int) -> str:
        return datetime.fromtimestamp(ts, IST).strftime("%H:%M:%S")

    def _close(pos: dict, ev: dict, c: dict, exit_prices: list[float] | None = None) -> None:
        nonlocal open_pos
        hold = (c["time"] - pos["ts"]) / 60.0
        t = _finish_trade(
            rule_side=pos["side"], base=pos["entry"], lots=lots0, lot=lot, ev=ev, sim=pos["sim"], cfg=cfg,
            meta={"entryDate": pos["d"], "exitDate": _dstr(c["time"]), "strike": pos["k"], "ot": pos["ot"],
                  "entryTime": pos["t"], "exitTime": _clock(c["time"]), **_struct_meta(pos)},
            hold_min=hold, leg_costs=_leg_costs(cfg, pos, exit_prices, lots0, lot),
        )
        trades.append(t)
        gates.closed(_dstr(c["time"]), t["grossRs"])
        open_pos = None

    for i, c in enumerate(series):
        ts = c["time"]
        spot = c["close"]
        dkey = _dstr(ts)
        clk = datetime.fromtimestamp(ts, IST).time()
        tradable = ts >= first_ts
        ctx = _Ctx(symbol, hist[: i + 1], tf=int(rule.get("entryTf") or 0))
        last = i == len(series) - 1
        # The trading day's last bar: the next bar is on another date. (The range's own final bar is left to
        # "range end" -- a cut-off range says nothing about the session.)
        eod = i + 1 < len(series) and _dstr(series[i + 1]["time"]) != dkey
        # A bar that CONTAINS the square-off time: it starts before it and ends after it. At 15m / 30m / 1h no
        # bar starts exactly at 15:20, so this used to never fire and an intraday trade rode into the next day
        # (and, being still open, blocked every later entry).
        spans_sq = bool(sq and clk < sq < datetime.fromtimestamp(ts + interval, IST).time())

        if open_pos:
            ei = open_pos["i"]
            held = (i - ei) * interval / 86400.0

            def value_at(s_):
                return _pos_px(open_pos, lambda k, ot: _syn_premium(ot, s_, k, held, syn_iv, syn_dte))

            # premium at the bar's own open / low / high / close -- the extremes are what let a stop
            # or target be hit INSIDE the bar instead of only being noticed at its close
            ps = [value_at(c["open"])[0], value_at(c["low"])[0], value_at(c["high"])[0], value_at(spot)[0]]
            px = ps[3]
            leg_px = value_at(spot)[1]
            sig = bool(exit_conds) and ctx.eval_conds(exit_conds, exit_logic, trade=_trade_of(open_pos["sim"], px), groups=exit_groups)
            evs = open_pos["sim"].step(
                px, lo=min(ps), hi=max(ps), opn=ps[0], exit_signal=sig,
                square_off=bool(not positional and ((sq and clk >= sq) or spans_sq or eod)),
            )
            if not open_pos["sim"].closed and last:
                evs += open_pos["sim"].force_close(px, "range end")
            fin = next((e for e in evs if e["kind"] == "exit"), None)
            if fin:
                _close(open_pos, fin, c, leg_px)
                cd_until = i + cd_bars
            continue

        if not tradable or i <= cd_until:
            continue
        if not positional and (eod or spans_sq):
            continue  # entered at this bar's close it would already be past the square-off / the day's end
        if day_count.get(dkey, 0) >= max_pd:
            continue
        if neb and clk < neb:
            continue
        if nea and clk >= nea:
            continue
        if sq and clk >= sq:
            continue
        if not gates.allows(dkey):
            continue
        if not ctx.eval_conds(entry_conds, entry_logic, groups=entry_groups):
            continue
        base = round(spot / step) * step
        legs, entry_px_legs = None, None
        if ST.is_structure(rule):
            legs = ST.legs_for(rule["structure"], base, step, rule.get("offset"), rule.get("width"))
            entry_px_legs = [_syn_premium(lg["ot"], spot, lg["strike"], 0.0, syn_iv, syn_dte) for lg in legs]
            if any(p <= 0 for p in entry_px_legs):
                continue
            net = ST.net_premium(legs, entry_px_legs)
            if net == 0:
                continue
            strike, ot, px, pos_side = base, "STR", abs(net), ("BUY" if net > 0 else "SELL")
            ef_use = {k: v for k, v in (rule.get("entryFilter") or {}).items() if k in ("premOp", "premVal", "premTol")}
        else:
            strike, ot = _resolve_instrument(rule.get("instrument", "ATM_CE"), base, step)
            px = _syn_premium(ot, spot, strike, 0.0, syn_iv, syn_dte)
            pos_side, ef_use = side, (rule.get("entryFilter") or {})
        if px <= 0:
            continue
        ok, _ = _entry_filter_ok(ef_use, px, 0.5, 0.0, 0.0)
        if not ok:
            continue
        open_pos = {
            "k": strike, "ot": ot, "entry": px, "d": dkey, "t": _clock(ts), "ts": ts, "i": i, "side": pos_side,
            "sim": SimPosition(rule, buy=(pos_side == "BUY"), base=px, lots=lots0, lot_size=lot),
            **({"legs": legs, "structure": rule["structure"], "entry_px": entry_px_legs} if legs else {}),
        }
        day_count[dkey] = day_count.get(dkey, 0) + 1
        gates.opened(dkey)

    summary, equity = _summarize_trades(trades)
    return {
        "symbol": symbol, "expiry": None, "from": from_date, "to": to_date,
        "instrument": rule.get("structure") if ST.is_structure(rule) else rule.get("instrument"), "side": side, "lots": rule.get("lots", 1),
        "lot": lot, "days": len({_dstr(c["time"]) for c in in_win}),
        "interval": interval, "candles": len(in_win),
        "pricing": "synthetic", "hasChain": False,
        "synIV": round(syn_iv, 3), "synDTE": syn_dte,
        "costs": cfg, "notSimulated": _not_simulated(rule, interval),
        "trades": trades, "equity": equity,
        "summary": summary,
    }
