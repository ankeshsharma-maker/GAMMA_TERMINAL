"""Performance statistics for a list of closed AutoBot trades.

One implementation for both the live trade ledger and the backtester, so the numbers
mean the same thing in both places. Input is one P&L (rupees) per round-trip trade in
the order they closed; a trade that scaled out is ONE trade (the caller sums its
legs), so win rate and expectancy aren't distorted by partial exits.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import datetime


def _streak(pnls: list[float], winning: bool) -> int:
    best = run = 0
    for p in pnls:
        hit = p > 0 if winning else p <= 0
        run = run + 1 if hit else 0
        best = max(best, run)
    return best


def summarize(
    pnls: list[float],
    *,
    holds_min: list[float | None] | None = None,
    reasons: list[str] | None = None,
    days: list[str] | None = None,
) -> dict:
    n = len(pnls)
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    total_win, total_loss = sum(wins), sum(losses)

    equity: list[float] = []
    run = peak = max_dd = 0.0
    for p in pnls:
        run += p
        equity.append(round(run, 0))
        peak = max(peak, run)
        max_dd = min(max_dd, run - peak)

    avg_win = total_win / len(wins) if wins else 0.0
    avg_loss = total_loss / len(losses) if losses else 0.0
    out = {
        "total": round(sum(pnls), 0),
        "count": n,
        "wins": len(wins),
        "losses": len(losses),
        "winRate": round(len(wins) / n * 100, 1) if n else 0.0,
        "totalWin": round(total_win, 0),
        "totalLoss": round(total_loss, 0),
        "avgWin": round(avg_win, 0),
        "avgLoss": round(avg_loss, 0),
        "profitFactor": round(total_win / abs(total_loss), 2) if losses and total_loss else None,
        "maxDrawdown": round(max_dd, 0),
        # what one trade is worth on average -- the number that decides whether a rule is worth running
        "expectancy": round(sum(pnls) / n, 0) if n else 0.0,
        # average win per average loss: a 40% win rate is fine at 2.0, ruinous at 0.5
        "payoff": round(avg_win / abs(avg_loss), 2) if losses and avg_loss else None,
        "maxWinStreak": _streak(pnls, True),
        "maxLossStreak": _streak(pnls, False),
        "best": round(max(pnls), 0) if pnls else 0.0,
        "worst": round(min(pnls), 0) if pnls else 0.0,
        "equity": equity,
    }
    if holds_min:
        hs = [h for h in holds_min if h is not None]
        out["avgHoldMin"] = round(sum(hs) / len(hs), 1) if hs else None
    if reasons:
        by: dict[str, dict] = defaultdict(lambda: {"n": 0, "pnl": 0.0})
        for p, r in zip(pnls, reasons):
            key = (r or "?").split(" ")[0] if (r or "").startswith(("SL", "target")) else (r or "?")
            by[key]["n"] += 1
            by[key]["pnl"] += p
        out["byReason"] = {k: {"n": v["n"], "pnl": round(v["pnl"], 0)} for k, v in by.items()}
    if days:
        wd: dict[str, dict] = defaultdict(lambda: {"n": 0, "pnl": 0.0})
        for p, d in zip(pnls, days):
            try:
                name = datetime.strptime(d, "%Y-%m-%d").strftime("%a")
            except (TypeError, ValueError):
                continue
            wd[name]["n"] += 1
            wd[name]["pnl"] += p
        out["byWeekday"] = {k: {"n": v["n"], "pnl": round(v["pnl"], 0)} for k, v in wd.items()}
    return out
